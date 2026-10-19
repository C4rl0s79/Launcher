import { EventEmitter } from 'node:events'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { AccountLibraryStatus, LibrarySnapshot, SteamClientStatus, SteamUser } from '@shared/types'
import { log } from '../logger'
import { JsonFile } from '../store/jsonFile'
import type { SettingsStore } from '../store/settings'
import { isPidAlive, readSteamRegistry } from '../steam/registry'
import {
  accountIdToSteamId64,
  pathExists,
  readLibraryFolders,
  readLocalPlayStats,
  readLoginUsers,
  scanAllLibraries,
  steamId64ToAccountId
} from '../steam/local'
import { getOwnedGames, type OwnedGame } from '../steam/webApi'
import { mergeLibrary, shortcutGames } from './merge'
import { readShortcuts } from '../steam/shortcuts'
import { FirstSeenStore } from './firstSeen'
import { collectionsDir, readCollections } from '../steam/collections'
import { demoGames } from './demo'

const ACCOUNT_TTL_MS = 6 * 3600 * 1000

interface AccountCache {
  steamId?: string
  fetchedAt: number
  private: boolean
  games: OwnedGame[]
}

/**
 * Owns the current library snapshot. Emits "snapshot" whenever it changes and
 * "gameExited" when the Steam-reported running app goes back to none.
 */
export class LibraryService extends EventEmitter {
  private snapshot: LibrarySnapshot = {
    games: [],
    steam: { status: 'unknown', libraryFolders: [], users: [] },
    account: { state: 'disabled', reason: 'noKey' },
    collections: null,
    demo: false,
    scannedAt: 0,
    warnings: []
  }
  private accountCache: JsonFile<AccountCache>
  private account: AccountCache | null = null
  private accountStatus: AccountLibraryStatus = { state: 'disabled', reason: 'noKey' }
  private accountFetch: Promise<void> | null = null
  private watchers: FSWatcher[] = []
  private watchedFolders = ''
  private rescanTimer: NodeJS.Timeout | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private scanning: Promise<LibrarySnapshot> | null = null
  private lastRunning: number | undefined
  private lastHash = ''

  private firstSeen: FirstSeenStore | null

  constructor(
    private readonly settings: SettingsStore,
    accountCacheFile: string,
    firstSeenFile?: string
  ) {
    super()
    this.accountCache = new JsonFile<AccountCache>(accountCacheFile, () => ({ fetchedAt: 0, private: false, games: [] }))
    this.firstSeen = firstSeenFile ? new FirstSeenStore(firstSeenFile) : null
  }

  get current(): LibrarySnapshot {
    return this.snapshot
  }

  get steamPath(): string | undefined {
    return this.snapshot.steam.installPath
  }

  async start(): Promise<void> {
    const cached = await this.accountCache.load()
    if (cached.fetchedAt) this.account = cached
    await this.scan()
    void this.refreshAccount(false)
    this.pollTimer = setInterval(() => void this.pollRuntime(), 3000)
  }

  stop(): void {
    clearInterval(this.pollTimer)
    clearTimeout(this.rescanTimer)
    this.watchers.forEach((w) => w.close())
  }

  /** Full rescan of local Steam data. Concurrent calls share one scan. */
  scan(): Promise<LibrarySnapshot> {
    if (!this.scanning) this.scanning = this.doScan().finally(() => (this.scanning = null))
    return this.scanning
  }

  private async doScan(): Promise<LibrarySnapshot> {
    const settings = this.settings.get()
    const warnings: string[] = []
    const reg = await readSteamRegistry()
    // LUMEN_STEAM_PATH overrides detection (tests / portable Steam); "none" simulates a PC without Steam.
    const override = process.env.LUMEN_STEAM_PATH
    if (override) {
      reg.steamPath = override === 'none' ? undefined : override
      if (override === 'none') reg.activePid = undefined
    }
    let installPath = reg.steamPath ? path.normalize(reg.steamPath) : undefined
    if (installPath && !(await pathExists(installPath))) {
      warnings.push(`Rejestr wskazuje Steam w „${installPath}”, ale katalog nie istnieje.`)
      installPath = undefined
    }
    if (!installPath && !override) {
      const fallback = 'C:\\Program Files (x86)\\Steam'
      if (await pathExists(path.join(fallback, 'steamapps'))) installPath = fallback
    }

    let status: SteamClientStatus = installPath ? (isPidAlive(reg.activePid) ? 'running' : 'notRunning') : 'notInstalled'
    if (process.platform !== 'win32' && installPath) status = 'unknown'

    let libraryFolders: string[] = []
    let users: SteamUser[] = []
    let manifests: Awaited<ReturnType<typeof scanAllLibraries>> = []
    if (installPath) {
      ;[libraryFolders, users] = await Promise.all([readLibraryFolders(installPath), readLoginUsers(installPath)])
      manifests = await scanAllLibraries(libraryFolders)
    }

    const activeSteamId =
      settings.steamIdOverride ??
      (reg.activeUserAccountId ? accountIdToSteamId64(reg.activeUserAccountId) : undefined) ??
      users[0]?.steamId64
    const accountId = activeSteamId ? steamId64ToAccountId(activeSteamId) : undefined
    const [localStats, collections, shortcuts] = await Promise.all([
      installPath && accountId ? readLocalPlayStats(installPath, accountId) : Promise.resolve(new Map()),
      installPath && accountId && !settings.demoMode ? readCollections(installPath, accountId) : Promise.resolve(null),
      installPath && accountId && !settings.demoMode ? readShortcuts(installPath, accountId) : Promise.resolve(null)
    ])
    const existingExes = new Set<string>()
    await Promise.all(
      [...new Set((shortcuts ?? []).map((s) => s.exe).filter(Boolean))].map((exe) =>
        pathExists(exe).then((ok) => ok && existingExes.add(exe))
      )
    )
    // "added" date of a shortcut: creation time of its ROM (first quoted path in the launch
    // options, as Steam ROM Manager writes it) or, failing that, of the program itself
    const shortcutAdded = new Map<number, number>()
    await Promise.all(
      (shortcuts ?? []).map(async (s) => {
        const rom = /"([A-Za-z]:[\\/][^"]+)"/.exec(s.launchOptions ?? '')?.[1]
        for (const p of [rom, s.exe]) {
          if (!p) continue
          try {
            const st = await fs.stat(p)
            shortcutAdded.set(s.appId, Math.floor((st.birthtimeMs || st.mtimeMs) / 1000))
            return
          } catch {
            /* try next */
          }
        }
      })
    )

    const useAccount = this.account && this.account.steamId === activeSteamId && !this.account.private
    let games = settings.demoMode
      ? demoGames()
      : mergeLibrary({
          manifests,
          owned: useAccount ? this.account!.games : undefined,
          localStats,
          runningAppId: reg.runningAppId || undefined,
          showTools: settings.showTools
        })
          .concat(
            shortcutGames(shortcuts ?? [], (exe) => existingExes.has(exe), reg.runningAppId || undefined, (s) => shortcutAdded.get(s.appId))
          )
          .sort((a, b) => a.sortName.localeCompare(b.sortName, 'pl'))

    if (!settings.demoMode && this.firstSeen && installPath) {
      games = await this.firstSeen.process(games, !!useAccount).catch((e) => {
        log.warn('library', `first-seen tracking failed: ${(e as Error).message}`)
        return games
      })
    }

    this.trackRunning(reg.runningAppId || undefined)
    this.snapshot = {
      games,
      steam: { status, installPath, libraryFolders, users, activeSteamId, runningAppId: reg.runningAppId || undefined },
      account: this.computeAccountStatus(activeSteamId),
      collections,
      demo: settings.demoMode,
      scannedAt: Date.now(),
      warnings
    }
    this.watchFolders(libraryFolders, installPath && accountId ? collectionsDir(installPath, accountId) : undefined)
    this.emitIfChanged()
    log.info(
      'library',
      `scan: steam=${status} folders=${libraryFolders.length} manifests=${manifests.length} games=${games.length} account=${this.snapshot.account.state}`
    )
    return this.snapshot
  }

  private computeAccountStatus(activeSteamId: string | undefined): AccountLibraryStatus {
    if (!this.settings.getSecret('steamWebApiKey')) return { state: 'disabled', reason: 'noKey' }
    if (!activeSteamId) return { state: 'disabled', reason: 'noSteamId' }
    if (this.accountStatus.state === 'error') return this.accountStatus
    if (this.account && this.account.steamId === activeSteamId) {
      if (this.account.private) return { state: 'private', fetchedAt: this.account.fetchedAt }
      return { state: 'ok', count: this.account.games.length, fetchedAt: this.account.fetchedAt, fromCache: this.accountStatus.state !== 'ok' }
    }
    return this.accountStatus
  }

  /** Fetch owned games via the Web API (only when a key is configured). */
  refreshAccount(force: boolean): Promise<void> {
    if (this.accountFetch) return this.accountFetch
    this.accountFetch = (async () => {
      const key = this.settings.getSecret('steamWebApiKey')
      const steamId = this.snapshot.steam.activeSteamId
      if (!key || !steamId) {
        this.accountStatus = { state: 'disabled', reason: key ? 'noSteamId' : 'noKey' }
        return
      }
      if (!force && this.account?.steamId === steamId && Date.now() - this.account.fetchedAt < ACCOUNT_TTL_MS) {
        this.accountStatus = this.computeAccountStatus(steamId)
        return
      }
      try {
        const r = await getOwnedGames(key, steamId)
        this.account = { steamId, fetchedAt: Date.now(), private: r.kind === 'private', games: r.kind === 'ok' ? r.games : [] }
        await this.accountCache.save(this.account)
        this.accountStatus =
          r.kind === 'private'
            ? { state: 'private', fetchedAt: this.account.fetchedAt }
            : { state: 'ok', count: r.games.length, fetchedAt: this.account.fetchedAt, fromCache: false }
        log.info('library', `account library: ${r.kind === 'ok' ? r.games.length + ' games' : 'private/empty'}`)
      } catch (e) {
        log.warn('library', `account library fetch failed: ${(e as Error).message}`)
        this.accountStatus = {
          state: 'error',
          message: (e as Error).message.startsWith('Steam odrzucił')
            ? (e as Error).message
            : 'Nie udało się pobrać biblioteki konta (sieć niedostępna?). Pokazuję ostatnie dane.',
          fetchedAt: Date.now(),
          cachedCount: this.account?.steamId === steamId ? this.account.games.length : undefined
        }
      }
    })().finally(async () => {
      this.accountFetch = null
      await this.scan()
    })
    return this.accountFetch
  }

  /**
   * Single place that turns RunningAppID changes into gameStarted/gameExited events.
   * Both full scans (triggered e.g. by Steam rewriting a manifest when a game starts or
   * exits) and the 3 s poll go through here, so no transition can be swallowed.
   */
  private trackRunning(running: number | undefined): void {
    const prev = this.lastRunning
    if (running === prev) return
    this.lastRunning = running
    if (prev) this.emit('gameExited', prev)
    if (running) this.emit('gameStarted', running)
  }

  /** Cheap periodic check of the running game & Steam process. */
  private async pollRuntime(): Promise<void> {
    try {
      const reg = await readSteamRegistry()
      const running = reg.runningAppId || undefined
      const status: SteamClientStatus = this.snapshot.steam.installPath
        ? isPidAlive(reg.activePid)
          ? 'running'
          : 'notRunning'
        : 'notInstalled'
      if (running !== this.lastRunning || status !== this.snapshot.steam.status) {
        this.trackRunning(running)
        this.snapshot = {
          ...this.snapshot,
          steam: { ...this.snapshot.steam, status, runningAppId: running },
          games: this.snapshot.games.map((g) =>
            (g.appId === running) !== !!g.running ? { ...g, running: g.appId === running && !!running } : g
          )
        }
        this.emitIfChanged()
      }
    } catch (e) {
      log.warn('library', `runtime poll failed: ${(e as Error).message}`)
    }
  }

  /** Watch steamapps folders so installs/updates started in Steam show up without a manual refresh. */
  private watchFolders(folders: string[], collectionsDirectory?: string): void {
    const key = [...folders, collectionsDirectory].join('|')
    if (key === this.watchedFolders) return
    this.watchedFolders = key
    this.watchers.forEach((w) => w.close())
    this.watchers = []
    for (const f of folders) {
      try {
        const w = watch(path.join(f, 'steamapps'), { persistent: false }, (_ev, file) => {
          if (file && !/^appmanifest_\d+\.acf/i.test(String(file))) return
          clearTimeout(this.rescanTimer)
          this.rescanTimer = setTimeout(() => void this.scan(), 800)
        })
        w.on('error', () => undefined)
        this.watchers.push(w)
      } catch (e) {
        log.warn('library', `cannot watch ${f}: ${(e as Error).message}`)
      }
    }
    if (collectionsDirectory) {
      // Steam rewrites these when collections change (also after syncing from another PC) and
      // tools like Steam ROM Manager rewrite shortcuts.vdf one level up.
      const targets: [string, RegExp][] = [
        [collectionsDirectory, /^cloud-storage-namespace-1/i],
        [path.dirname(collectionsDirectory), /^shortcuts\.vdf$/i]
      ]
      for (const [dir, pattern] of targets) {
        try {
          const w = watch(dir, { persistent: false }, (_ev, file) => {
            if (file && !pattern.test(String(file))) return
            clearTimeout(this.rescanTimer)
            this.rescanTimer = setTimeout(() => void this.scan(), 800)
          })
          w.on('error', () => undefined)
          this.watchers.push(w)
        } catch {
          /* optional */
        }
      }
    }
  }

  private emitIfChanged(): void {
    const { scannedAt: _s, ...rest } = this.snapshot
    const hash = JSON.stringify(rest)
    if (hash === this.lastHash) return
    this.lastHash = hash
    this.emit('snapshot', this.snapshot)
  }
}
