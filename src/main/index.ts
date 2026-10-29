import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } from 'electron'
import { existsSync, mkdirSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ART_SCHEME, IPC } from '@shared/api'
import { isModeCombo } from '@shared/pad'
import type { ActionResult, ArtKind, ArtLayout, ArtOption, DetailsResult, GameRatings, FsEntry, FsListOptions, Game, JobsSnapshot, LibrarySnapshot, Prefs, SecretName, SettingsPatch, SgdbGame, UiMode } from '@shared/types'
import { initLogger, log } from './logger'
import { chooseDataDir, migrateDataDir } from './dataDir'
import { listDir } from './fsBrowse'
import { Limiter } from './net'
import { detectFlavor, Updater } from './updater'
import { ops, PrefsError, PrefsStore } from './store/prefs'
import { SettingsStore } from './store/settings'
import { LibraryService } from './library/service'
import { StoreMetadataProvider } from './steam/storeMeta'
import { DRY_RUN, openSteam, openSteamUri, shortcutRunUri } from './steam/actions'
import { pickBestMatch, pickExactMatch, SgdbAuthError, SgdbClient } from './art/sgdb'
import { LaunchBoxService } from './launchbox/service'
import { XInputPoller } from './input/xinput'
import { foreground } from './input/foreground'
import { platformForEs, platformForTags } from './launchbox/match'
import { IMAGE_BASE, LB_TYPES, PICKER_TYPES, regionsOfTags, type LbImage } from './launchbox/images'
import { ArtworkService } from './art/artwork'
import { isPlayable } from './steam/manifests'
import { steamId64ToAccountId } from './steam/local'
import { EmustartEngine, resolveEngineCommand } from './emustart/engine'
import { EmustartProvider } from './emustart/provider'
import { emuArtField, emuDetails, isEmuGameId } from './emustart/mapping'
import { registerEmustartIpc } from './emustart/ipc'
import { UnifiedLibrary } from './core/unifiedLibrary'
import { UiModeManager } from './core/uiMode'

const ART_KINDS: ArtKind[] = ['grid', 'hero', 'logo', 'icon']
/** the EmuStart engine finds Lumen's window by this title (in-game menu, return after a game) */
const WINDOW_TITLE = 'Lumen'

protocol.registerSchemesAsPrivileged([
  { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
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
const emu = new EmustartProvider(engine, paths.emustartLibrary, () => ({ order: settings.get().regionOrder, choices: prefs.get().versions }))
const unified = new UnifiedLibrary(library, emu)
const updater = new Updater({
  current: app.getVersion(),
  flavor: detectFlavor({ packaged: app.isPackaged, exeDir: path.dirname(process.execPath), portableFile: process.env.PORTABLE_EXECUTABLE_FILE }),
  dataDir: userData,
  // the portable exe runs from a temporary copy — the file to replace and restart is the original
  exe: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
  portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
  // development / tests only: local release feed instead of GitHub
  feed: process.env.LUMEN_UPDATE_FEED || undefined,
  quit: () => app.quit()
})
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
/** Steam game whose controller profile hid devices (disabled in Windows until the game ends) */
let hiddenForAppId: number | undefined
let hiddenWatchdog: NodeJS.Timeout | undefined
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
    if (win) activateWindow(win)
    if (settings.get().startMode === 'fullscreen') modes?.setMode('fullscreen')
  })
  win.on('focus', () => {
    send(IPC.appFocus, true)
    // keyboard focus belongs to the interface (both layouts are the window's own page)
    win?.webContents.focus()
  })
  win.on('minimize', () => log.info('window', 'minimized'))
  win.on('restore', () => log.info('window', 'restored'))
  win.on('blur', () => {
    send(IPC.appFocus, false)
    // who took the focus (diagnosis: pad silent although Lumen stays on top)
    setTimeout(() => {
      if (!win || win.isDestroyed() || win.isFocused()) return
      const fg = foreground(ownHandle())
      if (fg) log.info('window', `focus lost to: ${fg.desc}${fg.other ? '' : ' — pad stays on'}`)
    }, 300)
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file:')) e.preventDefault()
  })
  win.webContents.on('before-input-event', (_e, input) => hotkeys(input, win!.webContents))
  win.webContents.on('render-process-gone', (_e, d) => log.error('app', `renderer gone: ${d.reason}`))

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  modes = new UiModeManager(win)
  modes.on('mode', (mode: UiMode, selection: string | null) => send(IPC.uiMode, mode, selection))
}

/** F10 / View+Start: switch interface; F11: window fullscreen (desktop); F12: DevTools (development). */
function hotkeys(input: Electron.Input, wc: Electron.WebContents): void {
  if (input.type !== 'keyDown') return
  if (input.key === 'F10') modes?.toggle()
  if (input.key === 'F11' && modes?.mode !== 'fullscreen') win?.setFullScreen(!win.isFullScreen())
  if (input.key === 'F12' && !app.isPackaged) wc.toggleDevTools()
}

/**
 * Show the window with keyboard focus. Windows does not hand the foreground to a window of a
 * process the player did not start directly (the portable launcher unpacks and starts Lumen, the
 * update task restarts it): the window appeared without focus and the pad stayed silent (pad
 * input only while Lumen has focus). Steps Windows allows, each only when the previous one failed.
 */
function activateWindow(w: BrowserWindow): void {
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  w.webContents.focus()
  if (w.isFocused()) return
  w.setAlwaysOnTop(true)
  w.show()
  w.focus()
  w.setAlwaysOnTop(false)
  setTimeout(() => {
    if (w.isDestroyed() || w.isFocused()) return
    w.minimize()
    w.restore()
    w.focus()
    log.info('window', `focus at start: ${w.isFocused() ? 'yes' : 'no (click the window)'}`)
  }, 300)
}

function ownHandle(): bigint {
  const b = win && !win.isDestroyed() ? win.getNativeWindowHandle() : null
  return b ? (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))) : 0n
}

// pad without focus: Lumen visible and no other application's real window in front (checked at most every 250 ms)
let fgAt = 0
let fgOk = false
function padWithoutFocus(): boolean {
  const now = Date.now()
  if (now - fgAt > 250) {
    fgAt = now
    const fg = win && win.isVisible() ? foreground(ownHandle()) : null
    fgOk = !!fg && !fg.other
  }
  return fgOk
}

let refocusAt = 0
function refocus(): void {
  if (!win || Date.now() - refocusAt < 2000) return
  refocusAt = Date.now()
  activateWindow(win)
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
      if (gameId.startsWith('emusys:')) {
        // platform logo from the EmuStart server (TV system carousel)
        const logo = kind === 'logo' ? emu.systemLogo(gameId.slice(7)) : undefined
        if (!logo || !engine.baseUrl) return new Response('not found', { status: 404 })
        return (await engineMedia(logo)) ?? new Response('not found', { status: 404 })
      }
      if (u.searchParams.get('tv') === '1') {
        const own = await tvArt(gameId, kind as ArtKind)
        if (own) return own
      }
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

/**
 * EmuStart game art comes from the engine (its offline copy of the server's media). Requests go
 * through Node with a limit — a poster grid asked Chromium's network service for dozens at once
 * (net::ERR_INSUFFICIENT_RESOURCES, posters stayed empty) — and recent images stay in memory.
 */
const emuArtLimit = new Limiter(6, 'emustart-art', true)
/** recent EmuStart images in memory, least recently shown dropped first (a byte budget, not a count) */
const emuArtCache = new Map<string, { type: string; body: Buffer }>()
const EMU_ART_BUDGET = 256 * 1024 * 1024
let emuArtBytes = 0
function emuArtGet(url: string): { type: string; body: Buffer } | undefined {
  const hit = emuArtCache.get(url)
  if (hit) {
    emuArtCache.delete(url)
    emuArtCache.set(url, hit)
  }
  return hit
}
function emuArtPut(url: string, hit: { type: string; body: Buffer }): void {
  emuArtCache.set(url, hit)
  emuArtBytes += hit.body.length
  for (const [k, v] of emuArtCache) {
    if (emuArtBytes <= EMU_ART_BUDGET) break
    emuArtCache.delete(k)
    emuArtBytes -= v.body.length
  }
}

/** Names to look a game up in SteamGridDB: its LaunchBox name and the titles of its versions. */
function emuTitles(gameId: string): string[] {
  const rows = [emu.row(gameId), ...emu.versionsOf(gameId).map((v) => emu.row(v.id))]
  const out = new Set<string>()
  for (const r of rows) if (r?.title) out.add(r.title)
  const lb = emuLbId(gameId)
  const lbName = lb ? launchbox.nameById(lb) : undefined
  return lbName ? [lbName, ...[...out].filter((n) => n !== lbName)] : [...out]
}

/**
 * LaunchBox Games DB id of an EmuStart game: from the server's metadata (any version), else found
 * by title on the system's platform in the local LaunchBox database (systems the server has no
 * metadata for: Mega Drive, Game Boy, Atari…). A title match is remembered while the program runs.
 */
const emuLbMatch = new Map<string, number>()
function emuLbId(gameId: string): number | undefined {
  const own = emu.row(gameId)?.lb || emu.versionsOf(gameId).map((v) => emu.row(v.id)?.lb).find(Boolean)
  if (own) return own
  const known = emuLbMatch.get(gameId)
  if (known !== undefined) return known || undefined
  const row = emu.row(gameId)
  const platform = row ? platformForEs(row.es) : undefined
  if (!row?.title || !platform) return undefined
  const hit = launchbox.find(row.title, platform)
  // a miss is remembered only with the database present (it may be downloaded later)
  if (hit || launchbox.ready) emuLbMatch.set(gameId, hit?.id ?? 0)
  return hit?.id
}

/** EmuStart details with what the server lacks filled in from LaunchBox (description, genre, year…) */
function withLaunchBox(gameId: string, r: DetailsResult): DetailsResult {
  const lbId = emuLbId(gameId)
  const lb = lbId ? launchbox.detailsById(lbId) : null
  if (!lb) return r
  if (!r.ok) return { ok: true, details: { ...lb, name: emu.row(gameId)?.title ?? lb.name }, stale: false }
  const d = r.details
  return {
    ...r,
    details: {
      ...d,
      descriptionText: d.descriptionText || lb.descriptionText,
      genres: d.genres?.length ? d.genres : lb.genres,
      releaseDate: d.releaseDate || lb.releaseDate,
      developers: d.developers?.length ? d.developers : lb.developers,
      publishers: d.publishers?.length ? d.publishers : lb.publishers,
      players: d.players || lb.players,
      rating: d.rating ?? lb.rating,
      ratingCount: d.ratingCount ?? lb.ratingCount,
      esrb: d.esrb || lb.esrb,
      coop: d.coop ?? lb.coop,
      releaseType: d.releaseType || lb.releaseType,
      launchboxId: d.launchboxId ?? lb.launchboxId
    }
  }
}

/** LaunchBox images of an EmuStart game, best first: the shown version's region, then preference */
function emuLbImages(gameId: string, types: readonly string[]): LbImage[] {
  const lb = emuLbId(gameId)
  if (!lb) return []
  return launchbox.images(lb, types, settings.get().regionOrder ?? 'europe', regionsOfTags(emu.row(gameId)?.tags ?? ''))
}

/** First LaunchBox image of these types that downloads, as a response */
async function emuLbArt(gameId: string, kind: ArtKind, types: readonly string[]): Promise<Response | null> {
  for (const img of emuLbImages(gameId, types).slice(0, 2)) {
    const f = await artwork.fromUrl(gameId, kind, img.url)
    if (f) return fileResponse(f)
  }
  return null
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
async function fileResponse(file: string): Promise<Response> {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  return new Response(new Uint8Array(await fs.readFile(file)), { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'max-age=86400' } })
}

/**
 * EmuStart art, in order:
 *  - poster: the player's choice → SteamGridDB (600x900, matched strictly by title) → the server's
 *    box art → LaunchBox box front. Box art is a real box shape (3DO longbox ~1:2, CD case ~1:1),
 *    the interface shows it whole over a blurred copy;
 *  - background: choice → SteamGridDB → LaunchBox "Fanart - Background" → the server's screenshot →
 *    LaunchBox screenshot;
 *  - logo: choice → the server (LaunchBox Clear Logo) → LaunchBox → SteamGridDB.
 * LaunchBox images go by the LaunchBox id from the server's metadata (no title guessing). The first
 * SteamGridDB lookup can take a while: after a short wait the next source is shown and the image is
 * swapped in when it arrives (art revision bump).
 */
async function emuArt(gameId: string, kind: string): Promise<Response> {
  const k = kind as ArtKind
  const names = emuTitles(gameId)
  const auto = k !== 'logo'
  // a SteamGridDB lookup not made yet never holds the poster back: the source's art now, the
  // lookup in the background (the poster is swapped when it finds something)
  const decided = !auto || (await artwork.titledDecided(gameId, k))
  const titled = artwork.resolveTitled(gameId, k, names, auto)
  const first = decided ? await titled : 'late'
  if (first === 'late') void titled.then((f) => f && notifyArt(gameId))
  else if (first === null) return new Response('none', { status: 404 })
  else if (first) return fileResponse(first)
  // the player chose "Grafika z serwera EmuStart" (or picked one on the server): exactly the server's
  // art first — LaunchBox only when the server has none of this kind
  const serverChosen = prefs.get().art[gameId]?.[k]?.type === 'steam'
  const steps: (() => Promise<Response | null>)[] =
    serverChosen && k === 'hero'
      ? [() => engineArt(gameId, kind), () => emuLbArt(gameId, k, LB_TYPES.fanart), () => emuLbArt(gameId, k, LB_TYPES.screenshot)]
      : k === 'grid'
      ? [() => engineArt(gameId, kind), () => emuLbArt(gameId, k, LB_TYPES.box)]
      : k === 'hero'
        ? [() => emuLbArt(gameId, k, LB_TYPES.fanart), () => engineArt(gameId, kind), () => emuLbArt(gameId, k, LB_TYPES.screenshot)]
        : k === 'logo'
          ? [() => engineArt(gameId, kind), () => emuLbArt(gameId, k, LB_TYPES.logo)]
          : []
  for (const step of steps) {
    const r = await step()
    if (r) return r
  }
  if (k === 'logo' && first !== 'late') {
    const f = await artwork.resolveTitled(gameId, k, names, true)
    if (f) return fileResponse(f)
  }
  return new Response('not found', { status: 404 })
}

const layoutOf = (layout: unknown): ArtLayout => (layout === 'tv' ? 'tv' : 'desktop')

/**
 * The TV layout's own art (a cover shown whole, a screenshot slot, a logo — not the desktop's 2:3
 * poster and wide background): the TV choice, else for EmuStart games LaunchBox first (box front,
 * background / screenshot, Clear Logo), then the server's art. null: nothing of its own — as on the
 * desktop (Steam games, EmuStart games with neither).
 */
async function tvArt(gameId: string, k: ArtKind): Promise<Response | null> {
  const choice = prefs.get().artTv[gameId]?.[k]
  if (choice?.type === 'none') return new Response('none', { status: 404 })
  if (choice?.type === 'file' && (await fs.stat(choice.file).catch(() => null))) return fileResponse(choice.file)
  if (choice?.type === 'sgdb' || choice?.type === 'launchbox') {
    const f = await artwork.fromUrl(gameId, k, choice.url)
    if (f) return fileResponse(f)
  }
  if (!isEmuGameId(gameId)) return null
  const server = (): Promise<Response | null> => engineArt(gameId, k)
  const lb = (types: readonly string[]) => (): Promise<Response | null> => emuLbArt(gameId, k, types)
  const steps =
    choice?.type === 'steam'
      ? [server]
      : k === 'grid'
        ? [lb(LB_TYPES.box), server]
        : k === 'hero'
          ? [lb(LB_TYPES.fanart), lb(LB_TYPES.screenshot), server]
          : k === 'logo'
            ? [lb(LB_TYPES.logo), server]
            : []
  for (const step of steps) {
    const r = await step()
    if (r) return r
  }
  return null
}

/**
 * A file from the engine's media (offline copy of the server's media), kept in memory. The engine
 * keeps it on disk and fetches a missing one from the server itself. null: not there / engine error.
 */
async function engineMedia(url: string): Promise<Response | null> {
  if (!engine.baseUrl) return null
  const full = new URL(url, engine.baseUrl).toString()
  let hit = emuArtGet(full)
  if (!hit) {
    try {
      hit = await emuArtLimit.run(async () => {
        // the engine is local — also in the "no network" test mode (LUMEN_OFFLINE)
        const res = await fetch(full, { signal: AbortSignal.timeout(60_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return { type: res.headers.get('content-type') ?? 'image/webp', body: Buffer.from(await res.arrayBuffer()) }
      })
    } catch {
      return null
    }
    emuArtPut(full, hit)
  }
  return new Response(new Uint8Array(hit.body), { status: 200, headers: { 'Content-Type': hit.type, 'Cache-Control': 'max-age=86400' } })
}

/** The engine's offline copy of the server's media (box art, screenshot, Clear Logo). */
async function engineArt(gameId: string, kind: string): Promise<Response | null> {
  const field = emuArtField(kind)
  const row = emu.row(gameId)
  // a game with several versions: art of the shown version, else of any version that has it
  const url = (field && (row?.[field] || emu.versionsOf(gameId).map((v) => emu.row(v.id)?.[field]).find(Boolean))) || ''
  return url ? engineMedia(url) : null
}

function bumpArt(gameId: string, kind?: ArtKind): void {
  artwork.invalidate(gameId, kind)
  notifyArt(gameId)
}

/** Tell the interface to reload a game's art (a new image is ready; nothing to forget). */
function notifyArt(gameId: string): void {
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
  const hide = await hideControllers(game.appId)
  try {
    if (game.shortcut) await openSteamUri(shortcutRunUri(game.shortcut.gameId64))
    else await openSteam('run', game.appId)
  } catch (e) {
    await showControllers() // Steam was not asked to run the game: controllers back right away
    throw e
  }
  launchedAppId = game.appId
  const steamRunning = library.current.steam.status === 'running'
  if (settings.get().afterLaunch === 'minimize') setTimeout(() => win?.minimize(), steamRunning ? 1500 : 4000)
  return { ok: true, message: (steamRunning ? 'Uruchamianie przez Steam…' : 'Uruchamianie Steam i gry…') + (hide ? ` ${hide}` : '') }
}

/**
 * Controllers hidden in the game's profile (the engine disables them in Windows: lumen_hide.py) —
 * back when Steam reports the game ended, or when it never starts. Returns a note for the player.
 */
async function hideControllers(appId: number | undefined): Promise<string> {
  // lumen_steam_begin itself brings back what the previous Steam game hid
  clearTimeout(hiddenWatchdog)
  hiddenForAppId = undefined
  if (!appId || engine.state !== 'ready') return ''
  if (DRY_RUN) {
    log.info('app', `DRY RUN, not hiding controllers for ${appId}`)
    return ''
  }
  // set before the call: if it times out, the engine may still have disabled devices — the game's end
  // (or the watchdog, or Lumen exiting) brings them back either way
  hiddenForAppId = appId
  // the game never started (download, error, closed dialog): devices back after 10 minutes
  hiddenWatchdog = setTimeout(() => {
    if (library.current.steam.runningAppId !== appId) void showControllers()
  }, 10 * 60_000)
  try {
    const r = await engine.call<{ hidden: string[]; note: string }>('lumen_steam_begin', [appId], 60_000)
    if (!r.hidden.length && hiddenForAppId === appId) {
      clearTimeout(hiddenWatchdog)
      hiddenForAppId = undefined
    }
    if (r.hidden.length) log.info('app', `controllers hidden for ${appId}: ${r.hidden.join(', ')}`)
    return [r.hidden.length ? `Ukryte na czas gry: ${r.hidden.join(', ')}.` : '', r.note].filter(Boolean).join(' ')
  } catch (e) {
    log.warn('app', `hiding controllers failed: ${(e as Error).message}`)
    return ''
  }
}

async function showControllers(): Promise<void> {
  clearTimeout(hiddenWatchdog)
  if (hiddenForAppId === undefined) return
  hiddenForAppId = undefined
  try {
    await engine.call('lumen_steam_end', [], 60_000)
  } catch (e) {
    log.warn('app', `restoring controllers failed: ${(e as Error).message}`)
  }
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
  const before = prefs.get().versions
  const p = await prefs.update(fn)
  send(IPC.prefsChanged, p)
  if (p.versions !== before) emu.regroup()
  return p
}

function registerIpc(): void {
  handle(IPC.libraryGet, () => unified.current)
  handle(IPC.libraryRatings, async (ids: string[]) => {
    const ratings: Record<string, GameRatings> = {}
    const missing: number[] = []
    const lbIds = new Map<number, string[]>()
    for (const id of Array.isArray(ids) ? ids.slice(0, 20000) : []) {
      if (isEmuGameId(id)) {
        const lb = emuLbId(id)
        if (lb) lbIds.set(lb, [...(lbIds.get(lb) ?? []), id])
        continue
      }
      const appId = steamAppIdOf(id)
      if (!appId) continue
      const r = await meta.cachedRatings(appId)
      if (r) ratings[id] = { critic: r.critic, players: r.players }
      else if (!meta.wasTried(appId)) missing.push(appId) // tried this run without data: no rating
    }
    for (const [lb, r] of launchbox.ratingsById([...lbIds.keys()])) for (const id of lbIds.get(lb) ?? []) ratings[id] = { ...ratings[id], launchbox: r }
    if (missing.length) void meta.prefetch(missing)
    return { ratings, missing: missing.length }
  })
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
      if (engine.state !== 'ready')
        return withLaunchBox(gameId, { ok: false, error: engine.message ?? 'Silnik EmuStart nie działa — opis jest niedostępny.' })
      return withLaunchBox(gameId, emuDetails(await engine.call<Record<string, unknown>>('game_detail', [game.emu.id], 30_000)))
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
    if (before.regionOrder !== after.regionOrder) emu.regroup()
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
      if (isEmuGameId(gameId)) {
        // EmuStart: exact title match, like the automatic poster (correct it with "Zmień dopasowanie")
        const names = emuTitles(gameId)
        let match: SgdbGame | undefined
        for (const n of names.slice(0, 3)) if ((match = pickExactMatch(names, await sgdb.search(n)))) break
        return { ok: true, sgdbGame: match, options: match ? await sgdb.images(kind, { gameId: match.id }) : [] }
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
  handle(IPC.artLbOptions, async (gameId: string, kind: ArtKind) => {
    if (!isEmuGameId(gameId)) return { ok: false, error: 'Grafiki LaunchBox są dostępne dla gier EmuStart.' }
    if (!emuLbId(gameId)) return { ok: false, error: 'Serwer EmuStart nie przypisał tej grze pozycji w LaunchBox.' }
    const st = await launchbox.status()
    if (!st.ready) return { ok: false, error: 'Pobierz bazę LaunchBox w Ustawieniach (Opisy gier spoza Steama).' }
    if (st.outdated || st.job) return { ok: false, error: 'Baza LaunchBox aktualizuje się (dochodzi lista grafik) — spróbuj za kilka minut.' }
    return { ok: true, options: emuLbImages(gameId, PICKER_TYPES[kind] ?? []).slice(0, 48) }
  })
  handle(IPC.artChooseLb, async (gameId: string, kind: ArtKind, url: string, layout?: ArtLayout) => {
    if (!ART_KINDS.includes(kind)) throw new Error('Nieznany rodzaj grafiki.')
    if (!String(url).startsWith(IMAGE_BASE)) throw new Error('Nieoczekiwany adres grafiki.')
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, { type: 'launchbox', url: String(url) }, layoutOf(layout)))
    bumpArt(gameId, kind)
    return p
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
  handle(IPC.artChoose, async (gameId: string, kind: ArtKind, o: ArtOption, layout?: ArtLayout) => {
    if (!/^https:\/\/cdn2\.steamgriddb\.com\//.test(o.url)) throw new Error('Nieoczekiwany adres grafiki.')
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, { type: 'sgdb', imageId: o.id, url: o.url, thumb: o.thumb }, layoutOf(layout)))
    bumpArt(gameId, kind)
    return p
  })
  handle(IPC.artUseFile, async (gameId: string, kind: ArtKind, src: string, layout?: ArtLayout) => {
    const lay = layoutOf(layout)
    const choices = lay === 'tv' ? prefs.get().artTv : prefs.get().art
    if (!ART_KINDS.includes(kind)) throw new Error('Nieznany rodzaj grafiki.')
    if (!/\.(png|jpe?g|webp)$/i.test(String(src))) throw new Error('Wybierz plik PNG, JPG albo WebP.')
    const stat = await fs.stat(src).catch(() => null)
    if (!stat?.isFile()) throw new Error('Wybrany plik nie istnieje.')
    if (stat.size > 25 * 1024 * 1024) throw new Error('Plik jest zbyt duży (maks. 25 MB).')
    await fs.mkdir(paths.customArt, { recursive: true })
    const safe = gameId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const dest = path.join(paths.customArt, `${safe}-${lay === 'tv' ? 'tv-' : ''}${kind}-${Date.now()}${path.extname(src).toLowerCase()}`)
    await fs.copyFile(src, dest)
    const old = choices[gameId]?.[kind]
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, { type: 'file', file: dest }, lay))
    if (old?.type === 'file' && old.file.startsWith(paths.customArt)) await fs.rm(old.file, { force: true })
    bumpArt(gameId, kind)
    return p
  })
  handle(IPC.artUseSteam, async (gameId: string, kind: ArtKind, layout?: ArtLayout) => {
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, { type: 'steam' }, layoutOf(layout)))
    bumpArt(gameId, kind)
    return p
  })
  handle(IPC.artReset, async (gameId: string, kind: ArtKind, layout?: ArtLayout) => {
    const lay = layoutOf(layout)
    const old = (lay === 'tv' ? prefs.get().artTv : prefs.get().art)[gameId]?.[kind]
    const p = await updatePrefs((pr) => ops.setArt(pr, gameId, kind, undefined, lay))
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
    dataDir: () => settings.get().emustartHome || paths.emustartHome,
    changed: () => void emu.refresh(),
    artChanged: (gameId) => {
      emuArtCache.clear()
      emuArtBytes = 0
      bumpArt(gameId)
    },
    engineImage: async (url) => {
      // engine media and server previews through the engine; art sources' previews (https) directly
      const external = /^https:\/\//.test(url)
      if (!external && (!engine.baseUrl || !/^\/(media|serwer)\//.test(url))) return undefined
      try {
        const res = await fetch(external ? url : new URL(url, engine.baseUrl!), { signal: AbortSignal.timeout(15_000) })
        if (external && !(res.headers.get('content-type') ?? '').startsWith('image/')) return undefined
        if (!res.ok) return undefined
        return `data:${res.headers.get('content-type') ?? 'image/png'};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
      } catch {
        return undefined
      }
    }
  })

  handle(IPC.emuChooseVersion, async (gameId: string, versionId: string | null) => {
    const versions = emu.versionsOf(String(gameId))
    if (!versions.length) throw new Error('Ta gra ma jedną wersję.')
    if (versionId !== null && !versions.some((v) => v.id === versionId)) throw new Error('Nieznana wersja gry.')
    return updatePrefs((p) => ops.chooseVersion(p, gameId, versionId ?? undefined))
  })

  handle(IPC.updateGet, () => updater.state)
  handle(IPC.updateCheck, () => updater.check())
  handle(IPC.updateDownload, () => {
    void updater.download()
    return updater.state
  })
  handle(IPC.updateCancel, () => updater.cancel())
  handle(IPC.updateApply, () => updater.apply())

  handle(IPC.uiGetMode, () => modes?.mode ?? 'desktop')
  handle(IPC.uiSetMode, (mode: UiMode) => modes?.setMode(mode === 'fullscreen' ? 'fullscreen' : 'desktop'))
  ipcMain.on(IPC.uiSelect, (_e, gameId: unknown) => modes?.select(typeof gameId === 'string' ? gameId : null))
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

let started = false // set once the app is ready: a second instance quitting at once has nothing to stop
app.whenReady().then(async () => {
  log.info('app', `Lumen ${app.getVersion()} starting (electron ${process.versions.electron}, packaged=${app.isPackaged})`)
  log.info('app', `data folder: ${userData}`)
  if (dataChoice.warning) log.warn('app', dataChoice.warning)
  if (migrated.length) log.info('app', `copied from ${legacyDataDir} (left unchanged): ${migrated.join(', ')}`)
  await Promise.all([settings.init(), prefs.init(), emu.init()])
  started = true
  registerArtProtocol()
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
  updater.on('state', (s) => send(IPC.updateChanged, s))
  // like EmuStart: look for a new version shortly after start and once a day
  const autoCheck = (): void => void updater.check()
  setTimeout(autoCheck, 20_000)
  setInterval(autoCheck, 24 * 3600_000)
  engine.on('event', (ev: { type: string }) => {
    if (ev.type === 'quit') app.quit()
  })
  engine.on('state', (st) => {
    if (st !== 'ready') return
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
    if (hiddenForAppId === appId) void showControllers()
  })
  createWindow()
  // controller: passive XInput polling, only while Lumen has focus (never while a game runs)
  settings.setRuntimeInfo({ xinputAvailable: pads.available })
  let combo = false
  pads.start(
    () =>
      // LUMEN_NO_PAD=1: automated UI tests ignore controllers connected to this PC
      process.env.LUMEN_NO_PAD !== '1' &&
      settings.get().gamepadBackend === 'xinput' &&
      !!win &&
      !win.isDestroyed() &&
      !win.isMinimized() &&
      (win.isFocused() || padWithoutFocus()),
    (state) => {
      // focus taken by something invisible (Lumen still on top): the pad brings it back
      if (win && !win.isFocused() && state.some((p) => p.buttons || Math.abs(p.lx) > 16000 || Math.abs(p.ly) > 16000))
        refocus()
      // View + Start: switch between the desktop and fullscreen interfaces
      const nowCombo = state.some(isModeCombo)
      if (nowCombo && !combo) modes?.toggle()
      combo = nowCombo
      if (nowCombo) return
      send(IPC.padState, state)
    }
  )
  library.start().catch((e) => log.error('library', 'start failed', e))
  // a LaunchBox database from an older Lumen has no image list (posters, backgrounds) — rebuilt once
  setTimeout(() => void launchbox.upgradeIfOutdated().catch((e) => log.warn('launchbox', `upgrade: ${(e as Error).message}`)), 30_000)
  if (settings.get().emustartEnabled) engine.start().catch((e) => log.error('engine', 'start failed', e))
})

app.on('window-all-closed', () => app.quit())

// Every way out (window closed, "Wyjdź z Lumen", the engine's quit event) passes here — app.quit()
// does not emit window-all-closed. Stop polling, save the art cache index, and let the engine finish
// (save uploads after the last game) before Lumen exits.
let shutDown = false
app.on('before-quit', (e) => {
  if (shutDown || !started) return
  e.preventDefault()
  shutDown = true
  void shutdown().finally(() => app.quit())
})

async function shutdown(): Promise<void> {
  await showControllers() // never leave a wheel disabled after Lumen exits
  library.stop()
  emu.stop()
  await artwork.flush()
  if (engine.state !== 'disabled' && engine.state !== 'missing') await engine.stop()
}

process.on('unhandledRejection', (e) => log.error('app', 'unhandled rejection', e))
