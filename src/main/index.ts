import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } from 'electron'
import { existsSync, mkdirSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ART_SCHEME, EMU_UI_SCHEME, IPC } from '@shared/api'
import { EMU_UI, isModeCombo } from '@shared/emuPad'
import type { ActionResult, ArtKind, ArtOption, FsEntry, FsListOptions, Game, JobsSnapshot, LibrarySnapshot, Prefs, SecretName, SettingsPatch, SgdbGame, UiMode } from '@shared/types'
import { initLogger, log } from './logger'
import { chooseDataDir, migrateDataDir } from './dataDir'
import { listDir } from './fsBrowse'
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
import { EmustartEngine, resolveEngineCommand } from './emustart/engine'
import { EmustartProvider } from './emustart/provider'
import { emuArtField, emuDetails, isEmuGameId } from './emustart/mapping'
import { registerEmustartIpc } from './emustart/ipc'
import { UnifiedLibrary } from './core/unifiedLibrary'
import { createFullscreenBridge } from './core/fullscreenBridge'
import { UiModeManager } from './core/uiMode'

const ART_KINDS: ArtKind[] = ['grid', 'hero', 'logo', 'icon']
/** the EmuStart engine finds Lumen's window by this title (in-game menu, return after a game) */
const WINDOW_TITLE = 'Lumen'

protocol.registerSchemesAsPrivileged([
  { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: EMU_UI_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

// Data folder: LumenData next to the exe in packaged builds (installer and portable) — settings,
// caches, EmuStart data with the game cache, emulators and BIOS files, temp files (dataDir.ts).
// LUMEN_USER_DATA=<dir>: separate profile for tests/development.
const legacyDataDir = app.getPath('userData')
const dataChoice = chooseDataDir({
  override: process.env.LUMEN_USER_DATA,
  portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  exeDir: path.dirname(process.execPath),
  packaged: app.isPackaged,
  defaultDir: legacyDataDir
})
const migrated = !process.env.LUMEN_USER_DATA ? migrateDataDir(legacyDataDir, dataChoice.dir) : []
app.setPath('userData', dataChoice.dir)
// Chromium and the engine write temp files here instead of %TEMP%
const tempDir = path.join(dataChoice.dir, 'tmp')
mkdirSync(tempDir, { recursive: true })
app.setPath('temp', tempDir)
// also for Chromium's own temp files and child processes (renderers, GPU, the engine)
process.env.TEMP = tempDir
process.env.TMP = tempDir

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
  launchbox: path.join(userData, 'launchbox'),
  // EmuStart engine data (config, game cache, profiles) unless the user picks an existing EmuStart folder
  emustartHome: path.join(userData, 'emustart'),
  // last library read from the engine — shown (not playable) when the engine cannot start
  emustartLibrary: path.join(userData, 'emustart-library.json')
}

/** engine/ next to the app: the project root in development, resources/ when packaged */
const engineRoot = (): string => (app.isPackaged ? process.resourcesPath : app.getAppPath())
const emuWebDir = (): string => path.join(engineRoot(), 'engine', 'web')

const settings = new SettingsStore(paths.settings, paths.secrets)
const prefs = new PrefsStore(paths.prefs)
const library = new LibraryService(settings, paths.account, path.join(userData, 'first-seen.json'))
const engine = new EmustartEngine({
  command: () =>
    resolveEngineCommand({
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      appPath: engineRoot(),
      pythonPath: settings.get().pythonPath
    }),
  home: () => settings.get().emustartHome || paths.emustartHome,
  tempDir: () => tempDir,
  windowTitle: WINDOW_TITLE
})
const emu = new EmustartProvider(engine, paths.emustartLibrary)
const unified = new UnifiedLibrary(library, emu)
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
let modes: UiModeManager | null = null
let launchedAppId: number | undefined
const artRev = new Map<string, number>()

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function findGame(gameId: string): Game | undefined {
  return unified.game(gameId)
}

function steamAppIdOf(gameId: string): number | undefined {
  const m = /^steam:(\d+)$/.exec(gameId)
  return m ? Number(m[1]) : undefined
}

function fail(error: string): ActionResult {
  return { ok: false, error }
}

const artUrl = (gameId: string, kind: ArtKind): string => `${ART_SCHEME}://img/${encodeURIComponent(gameId)}/${kind}?r=${artRev.get(gameId) ?? 0}`

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
    title: WINDOW_TITLE,
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
  win.on('page-title-updated', (e) => e.preventDefault())
  win.once('ready-to-show', () => {
    win?.show()
    if (settings.get().startMode === 'fullscreen') modes?.setMode('fullscreen')
    else modes?.preload()
  })
  win.on('focus', () => {
    send(IPC.appFocus, true)
    // keyboard focus belongs to the visible interface
    if (modes?.mode === 'fullscreen') modes.activeContents.focus()
  })
  win.on('minimize', () => log.info('window', 'minimized'))
  win.on('restore', () => log.info('window', 'restored'))
  win.on('blur', () => send(IPC.appFocus, false))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file:')) e.preventDefault()
  })
  win.webContents.on('before-input-event', (_e, input) => hotkeys(input, win!.webContents))
  win.webContents.on('render-process-gone', (_e, d) => log.error('app', `renderer gone: ${d.reason}`))

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  modes = new UiModeManager(win, {
    preloadDir: path.join(__dirname, '../preload'),
    locate: (gameId) => {
      const g = findGame(gameId)
      if (g?.source === 'steam') return { es: 'steam', id: g.id }
      const row = emu.row(gameId)
      return row ? { es: row.es, id: row.id } : null
    },
    onInput: (input, wc) => hotkeys(input, wc)
  })
  modes.on('mode', (mode: UiMode, selection: string | null) => send(IPC.uiMode, mode, selection))
}

/** F10 / View+Start: switch interface; F11: window fullscreen (desktop); F12: DevTools (development). */
function hotkeys(input: Electron.Input, wc: Electron.WebContents): void {
  if (input.type !== 'keyDown') return
  if (input.key === 'F10') modes?.toggle()
  if (input.key === 'F11' && modes?.mode !== 'fullscreen') win?.setFullScreen(!win.isFullScreen())
  if (input.key === 'F12' && !app.isPackaged) wc.toggleDevTools()
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
      if (isEmuGameId(gameId)) return await emuArt(gameId, kind)
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

/** EmuStart game art comes from the engine (its offline copy of the server's media). */
async function emuArt(gameId: string, kind: string): Promise<Response> {
  const field = emuArtField(kind)
  const url = field ? emu.row(gameId)?.[field] : undefined
  if (!url || !engine.baseUrl) return new Response('not found', { status: 404 })
  const res = await net.fetch(new URL(url, engine.baseUrl).toString())
  if (!res.ok) return new Response('not found', { status: 404 })
  const headers = new Headers(res.headers)
  headers.set('Cache-Control', 'max-age=86400')
  return new Response(res.body, { status: 200, headers })
}

const UI_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

/**
 * lumen-emu://ui/… — EmuStart's UI files (engine/web) for the fullscreen interface; /media and
 * /assets go to the engine (art from the server, system logos). A fixed origin keeps the UI
 * working while the engine restarts or is missing (Steam games still work then).
 */
function registerEmuUiProtocol(): void {
  protocol.handle(EMU_UI_SCHEME, async (req) => {
    try {
      const u = new URL(req.url)
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
      if (rel.startsWith('media/') || rel.startsWith('assets/')) {
        if (!engine.baseUrl) return new Response('engine not running', { status: 503 })
        return await net.fetch(`${engine.baseUrl}/${rel}${u.search}`)
      }
      const base = emuWebDir()
      const file = path.resolve(base, rel || 'index.html')
      if (!file.startsWith(base + path.sep) || !existsSync(file)) return new Response('not found', { status: 404 })
      const body = await fs.readFile(file)
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': UI_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }
      })
    } catch (e) {
      log.warn('ui', `lumen-emu error: ${(e as Error).message}`)
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

/** Shortcuts on the first page of the path picker. */
function places(): FsEntry[] {
  const out: FsEntry[] = [
    { name: 'Folder danych Lumen', path: userData, kind: 'place' },
    { name: 'Dane EmuStart', path: settings.get().emustartHome || paths.emustartHome, kind: 'place' }
  ]
  for (const [name, key] of [['Pulpit', 'desktop'], ['Dokumenty', 'documents'], ['Pobrane', 'downloads']] as const) {
    try {
      out.push({ name, path: app.getPath(key), kind: 'place' })
    } catch {
      /* not available */
    }
  }
  return out.filter((p) => existsSync(p.path))
}

// ---------------- actions shared by both interfaces ----------------

/** Start a Steam game (or a non-Steam shortcut) through the Steam client. */
async function playSteam(gameId: string): Promise<ActionResult> {
  const game = findGame(gameId)
  if (!game) return fail('Nie znaleziono gry w bibliotece.')
  if (game.source === 'demo') return fail('To jest gra demonstracyjna — nie można jej uruchomić.')
  if (game.source === 'emustart') return fail('Gry z serwera EmuStart uruchamia EmuStart.')
  if (library.current.steam.status === 'notInstalled') return fail('Nie znaleziono klienta Steam na tym komputerze.')
  if (!isPlayable(game.installState))
    return fail(game.source === 'shortcut' ? 'Nie znaleziono programu tego skrótu na dysku.' : 'Gra nie jest gotowa do uruchomienia.')
  if (game.shortcut) await openSteamUri(shortcutRunUri(game.shortcut.gameId64))
  else await openSteam('run', game.appId)
  launchedAppId = game.appId
  const steamRunning = library.current.steam.status === 'running'
  if (settings.get().afterLaunch === 'minimize') setTimeout(() => win?.minimize(), steamRunning ? 1500 : 4000)
  return { ok: true, message: steamRunning ? 'Uruchamianie przez Steam…' : 'Uruchamianie Steam i gry…' }
}

/** Ask the Steam client to install a game (Steam shows its own dialog and runs the download). */
async function installSteam(gameId: string): Promise<ActionResult> {
  const game = findGame(gameId)
  if (!game) return fail('Nie znaleziono gry w bibliotece.')
  if (game.source !== 'steam') return fail('Tej pozycji nie instaluje się przez Steam.')
  if (library.current.steam.status === 'notInstalled') return fail('Nie znaleziono klienta Steam na tym komputerze.')
  await openSteam('install', game.appId)
  return { ok: true, message: 'Steam otworzy okno instalacji — potwierdź tam lokalizację. Instalacją zarządza klient Steam.' }
}

async function openInSteam(gameId: string, view: 'details' | 'store' | 'downloads'): Promise<ActionResult> {
  const game = findGame(gameId)
  if (view === 'downloads') {
    await openSteam('downloads')
    return { ok: true }
  }
  if (!game || game.source !== 'steam') return fail('Ta pozycja nie jest grą ze sklepu Steam.')
  await openSteam(view, game.appId)
  return { ok: true }
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
  handle(IPC.libraryGet, () => unified.current)
  handle(IPC.libraryRefresh, async (includeAccount: boolean) => {
    if (includeAccount) await library.refreshAccount(true)
    await Promise.all([library.scan(), engine.state === 'ready' ? emu.refresh() : undefined])
    return unified.current
  })

  handle(IPC.gamePlay, (gameId: string) => playSteam(gameId))
  handle(IPC.gameInstall, (gameId: string) => installSteam(gameId))
  handle(IPC.gameOpen, (gameId: string, view: 'details' | 'store' | 'downloads') => openInSteam(gameId, view))

  handle(IPC.gameDetails, async (gameId: string, force?: boolean) => {
    const game = findGame(gameId)
    if (game?.emu) {
      if (engine.state !== 'ready') return { ok: false, error: engine.message ?? 'Silnik EmuStart nie działa — opis jest niedostępny.' }
      return emuDetails(await engine.call<Record<string, unknown>>('game_detail', [game.emu.id], 30_000))
    }
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
    if (before.emustartEnabled !== after.emustartEnabled || before.emustartHome !== after.emustartHome || before.pythonPath !== after.pythonPath) {
      if (after.emustartEnabled) void engine.restart()
      else void engine.stop()
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
    if (isEmuGameId(gameId)) return { ok: false, error: 'Grafiki gier EmuStart wybiera się na serwerze EmuStart.' }
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
  handle(IPC.artUseFile, async (gameId: string, kind: ArtKind, src: string) => {
    if (!ART_KINDS.includes(kind)) throw new Error('Nieznany rodzaj grafiki.')
    if (!/\.(png|jpe?g|webp)$/i.test(String(src))) throw new Error('Wybierz plik PNG, JPG albo WebP.')
    const stat = await fs.stat(src).catch(() => null)
    if (!stat?.isFile()) throw new Error('Wybrany plik nie istnieje.')
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
  handle(IPC.appListDir, (dir: string, o: FsListOptions) =>
    listDir(String(dir ?? ''), { kind: o?.kind === 'file' ? 'file' : 'folder', extensions: Array.isArray(o?.extensions) ? o.extensions : undefined }, places())
  )

  registerEmustartIpc(handle, {
    engine,
    provider: emu,
    win: () => win,
    jobs: () => unified.jobs,
    dataDir: () => settings.get().emustartHome || paths.emustartHome
  })

  handle(IPC.uiGetMode, () => modes?.mode ?? 'desktop')
  handle(IPC.uiSetMode, (mode: UiMode, then?: 'settings') =>
    modes?.setMode(mode === 'fullscreen' ? 'fullscreen' : 'desktop', then === 'settings' ? 'settings' : undefined)
  )
  ipcMain.on(IPC.uiSelect, (_e, gameId: unknown) => modes?.select(typeof gameId === 'string' ? gameId : null))

  registerFullscreenBridge()
}

/** Fullscreen interface (EmuStart's UI): EmuStart calls go to the engine, Steam is answered here. */
function registerFullscreenBridge(): void {
  const bridge = createFullscreenBridge({
    engineReady: () => engine.state === 'ready',
    engineMessage: () => engine.message,
    engineCall: (m, a) => engine.call(m, a, m === 'launch' || m === 'install_missing' || m === 'server_enroll' ? 120_000 : 60_000),
    steamGames: () => library.current.games,
    steamStatus: () => library.current.steam.status,
    artUrl: (id, kind) => artUrl(id, kind),
    steamDetails: (id) => {
      const appId = steamAppIdOf(id)
      return appId ? meta.get(appId) : Promise.resolve({ ok: false as const, error: 'Brak danych.' })
    },
    play: playSteam,
    install: installSteam,
    openInSteam,
    toggleFavorite: async (id) => (await updatePrefs((p) => ops.toggleFavorite(p, id))).favorites.includes(id),
    isFavorite: (id) => prefs.get().favorites.includes(id),
    runningAppId: () => library.current.steam.runningAppId,
    steamJobs: () => unified.jobs.jobs.filter((j) => j.source === 'steam'),
    setMode: (m) => modes?.setMode(m),
    select: (id) => modes?.select(id),
    emuLumenId: (n) => emu.lumenId(n),
    quit: () => app.quit(),
    log: (m) => log.info('emu-ui', m.slice(0, 300))
  })
  ipcMain.handle(EMU_UI.call, async (e, name: unknown, args: unknown) => {
    if (!modes?.emuContents || e.sender !== modes.emuContents) throw new Error('forbidden')
    try {
      return await bridge.call(String(name), Array.isArray(args) ? args : [])
    } catch (err) {
      log.warn('emu-ui', `${String(name)}: ${(err as Error).message}`)
      throw new Error((err as Error).message)
    }
  })
}

/**
 * Lumen's own EmuStart folder: emulators (and with them the BIOS files from the server, which go
 * to RetroArch's system folder) live inside it unless the user chose another folder. An existing
 * EmuStart folder picked in Settings keeps its own configuration.
 */
async function emustartDefaults(): Promise<void> {
  if (settings.get().emustartHome) return
  try {
    const s = await engine.call<{ emu_root?: string }>('get_settings', [], 30_000)
    if (s.emu_root) return
    const root = path.join(paths.emustartHome, 'emulators')
    await fs.mkdir(root, { recursive: true })
    await engine.call('save_settings', [{ emu_root: root }], 30_000)
    log.info('emustart', `folder emulatorów: ${root}`)
    void emu.refresh()
  } catch (e) {
    log.warn('emustart', `domyślny folder emulatorów: ${(e as Error).message}`)
  }
}

// ---------------- lifecycle ----------------

app.on('second-instance', () => restoreWindow())

app.whenReady().then(async () => {
  log.info('app', `Lumen ${app.getVersion()} starting (electron ${process.versions.electron}, packaged=${app.isPackaged})`)
  log.info('app', `data folder: ${userData}`)
  if (dataChoice.warning) log.warn('app', dataChoice.warning)
  if (migrated.length) log.info('app', `copied from ${legacyDataDir} (left unchanged): ${migrated.join(', ')}`)
  await Promise.all([settings.init(), prefs.init(), emu.init()])
  registerArtProtocol()
  registerEmuUiProtocol()
  registerIpc()

  launchbox.on('changed', () => void launchbox.status().then((st) => send(IPC.launchboxChanged, st)))
  unified.on('snapshot', (s: LibrarySnapshot) => {
    send(IPC.librarySnapshot, s)
    // EmuStart platforms as group tabs — only from a live engine library, never from an empty one
    const systems = s.emustart.systems
    if (s.emustart.engine === 'ready' && !s.emustart.fromCache && systems.length && ops.syncEmustartSystems(prefs.get(), systems) !== prefs.get()) {
      updatePrefs((p) => ops.syncEmustartSystems(p, systems)).catch((e) => log.error('prefs', 'platform sync failed', e))
    }
  })
  unified.on('jobs', (j: JobsSnapshot) => send(IPC.jobsChanged, j))
  engine.on('event', (ev: { type: string }) => {
    if (ev.type === 'quit') app.quit()
  })
  engine.on('state', (st) => {
    if (st !== 'ready') return
    // the fullscreen UI reads the engine state when it loads — reload it once the engine is up
    modes?.reloadEmu()
    void emustartDefaults()
  })
  library.on('snapshot', (s: LibrarySnapshot) => {
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
  let combo = false
  pads.start(
    () =>
      // LUMEN_NO_PAD=1: automated UI tests ignore controllers connected to this PC
      process.env.LUMEN_NO_PAD !== '1' &&
      (settings.get().gamepadBackend === 'xinput' || modes?.mode === 'fullscreen') &&
      !!win &&
      !win.isDestroyed() &&
      win.isFocused() &&
      !win.isMinimized(),
    (state) => {
      // View + Start: switch between the desktop and fullscreen interfaces
      const nowCombo = state.some(isModeCombo)
      if (nowCombo && !combo) modes?.toggle()
      combo = nowCombo
      if (nowCombo) return
      if (modes?.mode === 'fullscreen') modes.emuContents?.send(EMU_UI.pad, state)
      else send(IPC.padState, state)
    }
  )
  library.start().catch((e) => log.error('library', 'start failed', e))
  if (settings.get().emustartEnabled) engine.start().catch((e) => log.error('engine', 'start failed', e))
})

app.on('window-all-closed', () => {
  library.stop()
  emu.stop()
  void artwork.flush()
  app.quit()
})

// let the engine finish (save uploads after the last game) before Lumen exits
let engineStopped = false
app.on('before-quit', (e) => {
  if (engineStopped || engine.state === 'disabled' || engine.state === 'missing') return
  e.preventDefault()
  engineStopped = true
  void engine.stop().finally(() => app.quit())
})

process.on('unhandledRejection', (e) => log.error('app', 'unhandled rejection', e))
