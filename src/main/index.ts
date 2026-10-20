import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ART_SCHEME, IPC } from '@shared/api'
import type { ActionResult, ArtKind, ArtOption, Game, LibrarySnapshot, Prefs, SecretName, SettingsPatch, SgdbGame } from '@shared/types'
import { initLogger, log } from './logger'
import { ops, PrefsError, PrefsStore } from './store/prefs'
import { SettingsStore } from './store/settings'
import { LibraryService } from './library/service'
import { StoreMetadataProvider } from './steam/storeMeta'
import { openSteam, openSteamUri, shortcutRunUri } from './steam/actions'
import { pickBestMatch, SgdbAuthError, SgdbClient } from './art/sgdb'
import { LaunchBoxService } from './launchbox/service'
import { XInputPoller } from './input/xinput'
import { platformForTags } from './launchbox/match'
import { ArtworkService } from './art/artwork'
import { isPlayable } from './steam/manifests'
import { steamId64ToAccountId } from './steam/local'

const ART_KINDS: ArtKind[] = ['grid', 'hero', 'logo', 'icon']

protocol.registerSchemesAsPrivileged([
  { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

// Separate profile for tests/development: LUMEN_USER_DATA=<dir>
if (process.env.LUMEN_USER_DATA) app.setPath('userData', path.resolve(process.env.LUMEN_USER_DATA))
// Portable build: keep everything (settings, caches, LaunchBox DB) next to the .exe.
else if (process.env.PORTABLE_EXECUTABLE_DIR) app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'LumenData'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const userData = app.getPath('userData')
const logFile = initLogger(path.join(userData, 'logs'))
const paths = {
  prefs: path.join(userData, 'prefs.json'),
  settings: path.join(userData, 'settings.json'),
  secrets: path.join(userData, 'secrets.json'),
  account: path.join(userData, 'cache', 'account-library.json'),
  artCache: path.join(userData, 'cache', 'art'),
  metaCache: path.join(userData, 'cache', 'meta'),
  customArt: path.join(userData, 'custom-art'),
  // not under cache/: rebuilding it means a ~110 MB download, so "clear cache" keeps it
  launchbox: path.join(userData, 'launchbox')
}

const settings = new SettingsStore(paths.settings, paths.secrets)
const prefs = new PrefsStore(paths.prefs)
const library = new LibraryService(settings, paths.account, path.join(userData, 'first-seen.json'))
const meta = new StoreMetadataProvider(paths.metaCache, () => settings.get().language)
const launchbox = new LaunchBoxService(paths.launchbox)
const pads = new XInputPoller()
const sgdb = new SgdbClient(() => settings.getSecret('sgdbApiKey'))
const artwork = new ArtworkService({
  cacheDir: paths.artCache,
  steamPath: () => library.steamPath,
  sgdb,
  priority: () => settings.get().artPriority,
  prefsFor: (id) => prefs.get().art[id],
  userGridDir: () => {
    const { installPath, activeSteamId } = library.current.steam
    const accountId = activeSteamId ? steamId64ToAccountId(activeSteamId) : undefined
    return installPath && accountId ? path.join(installPath, 'userdata', String(accountId), 'config', 'grid') : undefined
  }
})

let win: BrowserWindow | null = null
let launchedAppId: number | undefined
const artRev = new Map<string, number>()

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function findGame(gameId: string): Game | undefined {
  return library.current.games.find((g) => g.id === gameId)
}

function steamAppIdOf(gameId: string): number | undefined {
  const m = /^steam:(\d+)$/.exec(gameId)
  return m ? Number(m[1]) : undefined
}

function fail(error: string): ActionResult {
  return { ok: false, error }
}

// ---------------- window ----------------

function createWindow(): void {
  const s = settings.get()
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0c11',
    title: 'Lumen',
    autoHideMenuBar: true,
    fullscreen: s.startFullscreen,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  })
  Menu.setApplicationMenu(null)
  win.once('ready-to-show', () => win?.show())
  win.on('focus', () => send(IPC.appFocus, true))
  win.on('minimize', () => log.info('window', 'minimized'))
  win.on('restore', () => log.info('window', 'restored'))
  win.on('blur', () => send(IPC.appFocus, false))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file:')) e.preventDefault()
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win?.setFullScreen(!win.isFullScreen())
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win?.webContents.toggleDevTools()
  })
  win.webContents.on('render-process-gone', (_e, d) => log.error('app', `renderer gone: ${d.reason}`))

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function restoreWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------------- image protocol ----------------

function registerArtProtocol(): void {
  protocol.handle(ART_SCHEME, async (req) => {
    try {
      const u = new URL(req.url)
      const [, rawId, kind] = u.pathname.split('/')
      const gameId = decodeURIComponent(rawId ?? '')
      if (!ART_KINDS.includes(kind as ArtKind)) return new Response('bad kind', { status: 400 })
      const game = findGame(gameId)
      const shortcutId = /^shortcut:(\d+)$/.exec(gameId)
      const file = shortcutId
        ? await artwork.resolve(gameId, undefined, kind as ArtKind, game?.name, Number(shortcutId[1]))
        : await artwork.resolve(gameId, game?.appId || steamAppIdOf(gameId), kind as ArtKind, game?.name)
      if (!file) return new Response('not found', { status: 404 })
      const res = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers(res.headers)
      headers.set('Cache-Control', 'max-age=31536000')
      return new Response(res.body, { status: 200, headers })
    } catch (e) {
      log.warn('art', `protocol error: ${(e as Error).message}`)
      return new Response('error', { status: 500 })
    }
  })
}

function bumpArt(gameId: string, kind?: ArtKind): void {
  artwork.invalidate(gameId, kind)
  const rev = (artRev.get(gameId) ?? 0) + 1
  artRev.set(gameId, rev)
  send(IPC.artChanged, gameId, rev)
}

// ---------------- IPC ----------------

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as A))
    } catch (e) {
      if (!(e instanceof PrefsError)) log.error('ipc', `${channel} failed`, e)
      throw new Error((e as Error).message)
    }
  })
}

async function updatePrefs(fn: (p: Prefs) => Prefs): Promise<Prefs> {
  const p = await prefs.update(fn)
  send(IPC.prefsChanged, p)
  return p
}

function registerIpc(): void {
  handle(IPC.libraryGet, () => library.current)
  handle(IPC.libraryRefresh, async (includeAccount: boolean) => {
    if (includeAccount) await library.refreshAccount(true)
    return library.scan()
  })

  handle(IPC.gamePlay, async (gameId: string): Promise<ActionResult> => {
    const game = findGame(gameId)
    if (!game) return fail('Nie znaleziono gry w bibliotece.')
    if (game.source === 'demo') return fail('To jest gra demonstracyjna — nie można jej uruchomić.')
    if (library.current.steam.status === 'notInstalled') return fail('Nie znaleziono klienta Steam na tym komputerze.')
    if (!isPlayable(game.installState))
      return fail(game.source === 'shortcut' ? 'Nie znaleziono programu tego skrótu na dysku.' : 'Gra nie jest gotowa do uruchomienia.')
    if (game.shortcut) await openSteamUri(shortcutRunUri(game.shortcut.gameId64))
    else await openSteam('run', game.appId)
    launchedAppId = game.appId
    const steamRunning = library.current.steam.status === 'running'
    if (settings.get().afterLaunch === 'minimize') setTimeout(() => win?.minimize(), steamRunning ? 1500 : 4000)
    return { ok: true, message: steamRunning ? 'Uruchamianie przez Steam…' : 'Uruchamianie Steam i gry…' }
  })

  handle(IPC.gameInstall, async (gameId: string): Promise<ActionResult> => {
    const game = findGame(gameId)
    if (!game) return fail('Nie znaleziono gry w bibliotece.')
    if (game.source !== 'steam') return fail('Tej pozycji nie instaluje się przez Steam.')
    if (library.current.steam.status === 'notInstalled') return fail('Nie znaleziono klienta Steam na tym komputerze.')
    await openSteam('install', game.appId)
    return { ok: true, message: 'Steam otworzy okno instalacji — potwierdź tam lokalizację.' }
  })

  handle(IPC.gameOpen, async (gameId: string, view: 'details' | 'store' | 'downloads'): Promise<ActionResult> => {
    const game = findGame(gameId)
    if (view === 'downloads') {
      await openSteam('downloads')
      return { ok: true }
    }
    if (!game || game.source !== 'steam') return fail('Ta pozycja nie jest grą ze sklepu Steam.')
    await openSteam(view, game.appId)
    return { ok: true }
  })

  handle(IPC.gameDetails, async (gameId: string, force?: boolean) => {
    const game = findGame(gameId)
    if (game?.shortcut) {
      const st = await launchbox.status()
      if (!st.ready) return { ok: false, error: 'Opisy gier spoza Steama wymagają bazy LaunchBox — pobierz ją w Ustawieniach.' }
      const d = launchbox.details(game.name, platformForTags(game.shortcut.tags))
      return d ? { ok: true, details: d, stale: false } : { ok: false, error: 'Nie znaleziono tej gry w bazie LaunchBox.' }
    }
    const appId = steamAppIdOf(gameId)
    if (!appId) return { ok: false, error: 'Brak danych dla pozycji demonstracyjnej.' }
    return meta.get(appId, force)
  })

  handle(IPC.launchboxStatus, () => launchbox.status())
  handle(IPC.launchboxUpdate, () => {
    void launchbox.update()
    return launchbox.status()
  })
  handle(IPC.launchboxCancel, () => launchbox.cancel())

  handle(IPC.prefsGet, () => prefs.get())
  handle(IPC.prefsOp, async (op: string, ...args: unknown[]) => {
    switch (op) {
      case 'toggleFavorite':
        return updatePrefs((p) => ops.toggleFavorite(p, args[0] as string))
      case 'setGameCategories':
        return updatePrefs((p) => ops.setGameCategories(p, args[0] as string, args[1] as string[]))
      case 'createCategory':
        return updatePrefs((p) => ops.createCategory(p, args[0] as string))
      case 'renameCategory':
        return updatePrefs((p) => ops.renameCategory(p, args[0] as string, args[1] as string))
      case 'deleteCategory':
        return updatePrefs((p) => ops.deleteCategory(p, args[0] as string))
      case 'setPinned':
        return updatePrefs((p) => ops.setPinned(p, args[0] as string, args[1] as boolean))
      case 'moveCategory':
        return updatePrefs((p) => ops.moveCategory(p, args[0] as string, args[1] as number))
      default:
        throw new Error(`Unknown prefs op ${op}`)
    }
  })

  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsPatch, async (patch: SettingsPatch) => {
    const before = settings.get()
    const after = await settings.patch(patch)
    if (before.artPriority !== after.artPriority) for (const g of library.current.games) bumpArt(g.id)
    if (before.demoMode !== after.demoMode || before.showTools !== after.showTools || before.steamIdOverride !== after.steamIdOverride) {
      await library.scan()
      if (before.steamIdOverride !== after.steamIdOverride) void library.refreshAccount(true)
    }
    send(IPC.settingsChanged, after)
    return after
  })
  handle(IPC.settingsSecret, async (name: SecretName, value: string | null) => {
    if (name !== 'sgdbApiKey' && name !== 'steamWebApiKey') throw new Error('Unknown secret')
    await settings.setSecret(name, value)
    if (name === 'steamWebApiKey') void library.refreshAccount(true)
    if (name === 'sgdbApiKey') {
      // previous "not found" results may have been caused by a missing key
      for (const g of library.current.games) bumpArt(g.id)
    }
    send(IPC.settingsChanged, settings.get())
    return settings.get()
  })

  handle(IPC.artOptions, async (gameId: string, kind: ArtKind) => {
    if (!sgdb.enabled) return { ok: false, error: 'Dodaj klucz SteamGridDB w Ustawieniach, aby przeglądać grafiki.' }
    const appId = steamAppIdOf(gameId)
    const manual = prefs.get().art[gameId]
    try {
      if (manual?.sgdbGameId) {
        return {
          ok: true,
          sgdbGame: { id: manual.sgdbGameId, name: manual.sgdbGameName ?? `#${manual.sgdbGameId}` },
          options: await sgdb.images(kind, { gameId: manual.sgdbGameId })
        }
      }
      if (!appId) {
        // non-Steam shortcut: match by title (the user can correct it with "Zmień dopasowanie")
        const name = findGame(gameId)?.name
        const match = name ? pickBestMatch(name, await sgdb.search(name)) : undefined
        return { ok: true, sgdbGame: match, options: match ? await sgdb.images(kind, { gameId: match.id }) : [] }
      }
      const [game, options] = await Promise.all([sgdb.gameBySteamId(appId), sgdb.images(kind, { steamAppId: appId })])
      return { ok: true, sgdbGame: game, options }
    } catch (e) {
      return { ok: false, error: e instanceof SgdbAuthError ? e.message : 'Nie udało się połączyć ze SteamGridDB.' }
    }
  })
  handle(IPC.artSearch, async (term: string) => {
    if (!sgdb.enabled) return { ok: false, error: 'Brak klucza SteamGridDB.' }
    try {
      return { ok: true, games: await sgdb.search(term) }
    } catch (e) {
      return { ok: false, error: e instanceof SgdbAuthError ? e.message : 'Wyszukiwanie w SteamGridDB nie powiodło się.' }
    }
  })
  handle(IPC.artSetMatch, async (gameId: string, g: SgdbGame | null) => {
    const p = await updatePrefs((pr) => ops.setSgdbMatch(pr, gameId, g?.id, g?.name))
    bumpArt(gameId)
    return p
  })
  handle(IPC.artChoose, async (gameId: string, kind: ArtKind, o: ArtOption) => {
    if (!/^https:\/\/cdn2\.steamgriddb\.com\//.test(o.url)) throw new Error('Nieoczekiwany adres grafiki.')
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, { type: 'sgdb', imageId: o.id, url: o.url, thumb: o.thumb }))
    bumpArt(gameId, kind)
    return p
  })
  handle(IPC.artChooseFile, async (gameId: string, kind: ArtKind) => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Wybierz plik graficzny',
      properties: ['openFile'],
      filters: [{ name: 'Obrazy', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    const src = r.filePaths[0]
    const stat = await fs.stat(src)
    if (stat.size > 25 * 1024 * 1024) throw new Error('Plik jest zbyt duży (maks. 25 MB).')
    await fs.mkdir(paths.customArt, { recursive: true })
    const safe = gameId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const dest = path.join(paths.customArt, `${safe}-${kind}-${Date.now()}${path.extname(src).toLowerCase()}`)
    await fs.copyFile(src, dest)
    const old = prefs.get().art[gameId]?.[kind]
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, { type: 'file', file: dest }))
    if (old?.type === 'file' && old.file.startsWith(paths.customArt)) await fs.rm(old.file, { force: true })
    bumpArt(gameId, kind)
    return p
  })
  handle(IPC.artUseSteam, async (gameId: string, kind: ArtKind) => {
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, { type: 'steam' }))
    bumpArt(gameId, kind)
    return p
  })
  handle(IPC.artReset, async (gameId: string, kind: ArtKind) => {
    const old = prefs.get().art[gameId]?.[kind]
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, undefined))
    if (old?.type === 'file' && old.file.startsWith(paths.customArt)) await fs.rm(old.file, { force: true })
    bumpArt(gameId, kind)
    return p
  })

  handle(IPC.appFullscreen, () => {
    if (!win) return false
    win.setFullScreen(!win.isFullScreen())
    return win.isFullScreen()
  })
  handle(IPC.appIsFullscreen, () => !!win?.isFullScreen())
  handle(IPC.appCacheStats, () => artwork.stats())
  handle(IPC.appClearCache, async () => {
    await artwork.clear()
    await fs.rm(paths.metaCache, { recursive: true, force: true })
    for (const g of library.current.games) bumpArt(g.id)
    return artwork.stats()
  })
  handle(IPC.appOpenLogs, async () => {
    shell.showItemInFolder(logFile)
  })
  handle(IPC.appOpenExternal, async (url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error('Dozwolone są tylko adresy https.')
    await shell.openExternal(url)
  })
  handle(IPC.appQuit, () => app.quit())
}

// ---------------- lifecycle ----------------

app.on('second-instance', () => restoreWindow())

app.whenReady().then(async () => {
  log.info('app', `Lumen ${app.getVersion()} starting (electron ${process.versions.electron}, packaged=${app.isPackaged})`)
  await Promise.all([settings.init(), prefs.init()])
  registerArtProtocol()
  registerIpc()

  launchbox.on('changed', () => void launchbox.status().then((st) => send(IPC.launchboxChanged, st)))
  library.on('snapshot', (s: LibrarySnapshot) => {
    send(IPC.librarySnapshot, s)
    // mirror Steam collections as read-only categories (skipped when they could not be read,
    // so a missing file never wipes the user's pins)
    if (s.collections && prefs.get() !== ops.syncSteamCollections(prefs.get(), s.collections)) {
      updatePrefs((p) => ops.syncSteamCollections(p, s.collections!)).catch((e) => log.error('prefs', 'collection sync failed', e))
    }
  })
  library.on('gameStarted', (appId: number) => log.info('app', `game ${appId} started (per Steam registry)`))
  library.on('gameExited', (appId: number) => {
    log.info('app', `game ${appId} exited (per Steam registry)`)
    if (launchedAppId === appId && settings.get().restoreAfterGame) restoreWindow()
    launchedAppId = undefined
  })
  createWindow()
  // controller: passive XInput polling, only while Lumen has focus (never while a game runs)
  settings.setRuntimeInfo({ xinputAvailable: pads.available })
  pads.start(
    () => settings.get().gamepadBackend === 'xinput' && !!win && !win.isDestroyed() && win.isFocused() && !win.isMinimized(),
    (state) => send(IPC.padState, state)
  )
  library.start().catch((e) => log.error('library', 'start failed', e))
})

app.on('window-all-closed', () => {
  library.stop()
  void artwork.flush()
  app.quit()
})

process.on('unhandledRejection', (e) => log.error('app', 'unhandled rejection', e))
