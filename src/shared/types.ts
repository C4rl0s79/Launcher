// Types shared between the main process, preload bridge and renderer.
// Game identity is always the stable `id` ("steam:<appid>"), never the title.

/**
 * steam = Steam app; shortcut = non-Steam game added to Steam (shortcuts.vdf); demo = fake data;
 * emustart = game on the EmuStart server, downloaded and run with an emulator by the EmuStart engine
 */
export type GameSource = 'steam' | 'shortcut' | 'demo' | 'emustart'

/** Install state derived from Steam's appmanifest StateFlags (see main/steam/manifests.ts). */
export type InstallState =
  | 'installed'
  | 'notInstalled'
  | 'updateRequired'
  | 'updating' // update/download in progress
  | 'updatePaused'
  | 'installing' // first-time download in progress
  | 'uninstalling'
  | 'broken' // files missing/corrupt, needs validation in Steam

export interface DownloadProgress {
  /** Raw byte counters written by Steam into the manifest. They are refreshed by Steam with a delay. */
  bytesDownloaded: number
  bytesToDownload: number
  bytesStaged: number
  bytesToStage: number
}

/** Where we learned about this game. Local-only detection is NOT the full owned library. */
export type Provenance = 'localManifest' | 'accountApi' | 'steamShortcut' | 'demo' | 'emustartServer'

export interface Game {
  id: string
  source: GameSource
  appId: number
  name: string
  sortName: string
  provenance: Provenance[]
  installState: InstallState
  installed: boolean
  installDir?: string
  libraryPath?: string
  sizeOnDisk?: number
  buildId?: string
  progress?: DownloadProgress
  /** unix seconds; from local Steam config or the Web API */
  lastPlayed?: number
  /** unix seconds; when the game appeared on this PC (install manifest / ROM file creation) */
  addedAt?: number
  /** minutes */
  playtimeMinutes?: number
  running?: boolean
  /** only for non-Steam shortcuts */
  shortcut?: {
    exe: string
    launchOptions?: string
    /** Steam tags set on the shortcut, e.g. "PS2" (the generic "Non-Steam" tag is dropped) */
    tags: string[]
    /** id for steam://rungameid */
    gameId64: string
  }
  /** only for EmuStart games (source 'emustart') */
  emu?: EmuGameInfo
}

/** EmuStart-specific part of a game. `id` is the engine's local number (changes per device);
 *  Game.id uses the stable `sid` (same on every device: system + game name on the server). */
export interface EmuGameInfo {
  id: number
  sid: string
  es: string
  system: string
  tags: string
  size: number
  /** complete copy in the local game cache — playable without the server */
  cached: boolean
  /** kept locally on purpose (outside the "last N games" cache limit) */
  pinned: boolean
  /** a download of this game is in progress */
  copying: boolean
  /** discs in the set (multi-disc games are one entry); 1 = single disc / cartridge */
  discs: number
  /** LaunchBox Games DB id (server metadata) — releases of one game share it */
  lb?: number
  /** regional versions / revisions of this game (desktop shows them as one entry); absent = one version */
  versions?: EmuVersion[]
  /** id (emu:<sid>) of the version this entry shows and plays */
  shownVersion?: string
  genre?: string
  year?: string
  players?: string
  developer?: string
  publisher?: string
  hasBox: boolean
  hasSnap: boolean
  hasLogo: boolean
}

export type SteamClientStatus = 'running' | 'notRunning' | 'notInstalled' | 'unknown'

export interface SteamUser {
  steamId64: string
  accountName?: string
  mostRecent: boolean
}

export type AccountLibraryStatus =
  | { state: 'disabled'; reason: 'noKey' | 'noSteamId' }
  | { state: 'ok'; count: number; fetchedAt: number; fromCache: boolean }
  | { state: 'private'; fetchedAt: number }
  | { state: 'error'; message: string; fetchedAt: number; cachedCount?: number }

/** A Steam library collection (read-only, from the local Steam client data). */
export interface SteamCollection {
  id: string
  name: string
  /** explicit members (added minus removed); for dynamic collections only the manual additions */
  appIds: number[]
  dynamic: boolean
  kind: 'user' | 'favorite' | 'hidden'
}

export interface LibrarySnapshot {
  games: Game[]
  steam: {
    status: SteamClientStatus
    installPath?: string
    libraryFolders: string[]
    users: SteamUser[]
    activeSteamId?: string
    runningAppId?: number
  }
  account: AccountLibraryStatus
  /** null = Steam collections could not be read */
  collections: SteamCollection[] | null
  demo: boolean
  scannedAt: number
  warnings: string[]
  /** EmuStart engine and server (the Steam part is in `steam`) */
  emustart: EmustartSummary
}

/** One version of a game that has several (regions, revisions). */
export interface EmuVersion {
  /** emu:<sid> */
  id: string
  tags: string
  cached: boolean
  pinned: boolean
  copying: boolean
  discs: number
  size: number
  lastPlayed?: number
}

/** Which regional version a game shows by default. */
export type RegionOrder = 'europe' | 'usa' | 'japan'

export type EngineState = 'disabled' | 'starting' | 'ready' | 'missing' | 'error'

export interface EmuServerState {
  ok: boolean
  name?: string
  checking?: boolean
  key_rejected?: boolean
  reason?: string
}

export interface EmuSystem {
  es: string
  display: string
  games: number
  cached: number
  emulator: string
}

export interface EmustartSummary {
  engine: EngineState
  /** why the engine is not ready (missing Python, crash…) */
  message?: string
  version?: string
  /** null = this device is not logged in to an EmuStart server */
  server: EmuServerState | null
  profile?: string
  systems: EmuSystem[]
  /** the library shown comes from the last saved copy (engine not running) */
  fromCache: boolean
  /** emulator root folder set on this PC */
  configured: boolean
}

export interface GameDetails {
  appId: number
  fetchedAt: number
  source: 'steamStore' | 'launchbox' | 'emustart'
  name?: string
  shortDescription?: string
  descriptionHtml?: string
  /** plain-text description (LaunchBox) */
  descriptionText?: string
  genres?: string[]
  releaseDate?: string
  comingSoon?: boolean
  developers?: string[]
  publishers?: string[]
  website?: string
  players?: string
  /** community rating 0–5 (LaunchBox) */
  rating?: number
  platform?: string
  launchboxId?: number
}

export interface LaunchBoxStatus {
  ready: boolean
  updated?: string
  games?: number
  /** images listed (box art, backgrounds, logos…) */
  images?: number
  /** built by an older Lumen without the image list — rebuilt automatically */
  outdated?: boolean
  sizeBytes?: number
  error?: string
  job?: { phase: 'download' | 'build'; done: number; total: number }
}

export type DetailsResult =
  | { ok: true; details: GameDetails; stale: boolean }
  | { ok: false; error: string }

// ---------- User preferences (local only) ----------

export type SmartCategoryType = 'recent' | 'installed' | 'favorites' | 'notInstalled' | 'all'

export interface Category {
  id: string
  name: string
  /**
   * smart = built-in rule, custom = Lumen category, steam = mirror of a Steam collection (read-only),
   * emustart = platform (system) of the EmuStart server library (read-only, follows the server)
   */
  kind: 'smart' | 'custom' | 'steam' | 'emustart'
  smart?: SmartCategoryType
  steamCollectionId?: string
  emuSystem?: string
  pinned: boolean
  /** order among pinned categories on the home screen */
  order: number
}

export type ArtKind = 'grid' | 'hero' | 'logo' | 'icon'

export type ArtChoice =
  | { type: 'sgdb'; imageId: number; url: string; thumb?: string }
  | { type: 'file'; file: string }
  | { type: 'steam' }
  /** image from LaunchBox Games DB (images.launchbox-app.com) */
  | { type: 'launchbox'; url: string }
  | { type: 'none' }

export interface GameArtPrefs {
  sgdbGameId?: number
  sgdbGameName?: string
  grid?: ArtChoice
  hero?: ArtChoice
  logo?: ArtChoice
  icon?: ArtChoice
}

export interface Prefs {
  version: number
  categories: Category[]
  /** gameId -> custom category ids */
  gameCategories: Record<string, string[]>
  favorites: string[]
  art: Record<string, GameArtPrefs>
  /** game with several versions (emugrp:…) → the version the player chose (emu:<sid>) */
  versions: Record<string, string>
}

export type ArtSourcePriority = 'sgdbFirst' | 'steamFirst'
export type AfterLaunch = 'minimize' | 'keep'
/** xinput = passive XInput polling in the main process (default); chromium = browser Gamepad API */
/** One connected XInput pad (raw XINPUT_GAMEPAD values). */
export interface PadState {
  index: number
  buttons: number
  lt: number
  rt: number
  lx: number
  ly: number
}

export type GamepadBackend = 'xinput' | 'chromium'

export interface Settings {
  version: 1
  steamIdOverride?: string
  artPriority: ArtSourcePriority
  afterLaunch: AfterLaunch
  restoreAfterGame: boolean
  startFullscreen: boolean
  showTools: boolean
  demoMode: boolean
  gamepadBackend: GamepadBackend
  /** interface shown at start: desktop (Lumen look) or fullscreen (EmuStart look) */
  startMode: UiMode
  /** regional version shown by default for games with several versions */
  regionOrder: RegionOrder
  /** run the EmuStart engine (emulated games from an EmuStart server) */
  emustartEnabled: boolean
  /** EmuStart data folder (config, game cache, profiles); empty = Lumen's own folder */
  emustartHome?: string
  /** Python used to run the engine from sources (dev); empty = bundled engine or `py -3` */
  pythonPath?: string
  /** filled in by the main process: XInput could be loaded on this PC */
  xinputAvailable?: boolean
  language: string
  hasSgdbKey: boolean
  hasSteamWebKey: boolean
  secretsEncrypted: boolean
}

export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'steamIdOverride'
    | 'artPriority'
    | 'afterLaunch'
    | 'restoreAfterGame'
    | 'startFullscreen'
    | 'showTools'
    | 'demoMode'
    | 'gamepadBackend'
    | 'startMode'
    | 'regionOrder'
    | 'emustartEnabled'
    | 'emustartHome'
    | 'pythonPath'
  >
>

export type SecretName = 'sgdbApiKey' | 'steamWebApiKey'

export interface SgdbGame {
  id: number
  name: string
  releaseDate?: number
  verified?: boolean
}

export interface ArtOption {
  id: number
  url: string
  thumb: string
  width: number
  height: number
  style?: string
  score?: number
  author?: string
}

/** An image from LaunchBox Games DB offered in the "Grafiki" window */
export interface LbArtOption {
  url: string
  /** LaunchBox type: "Box - Front", "Fanart - Background", "Clear Logo"… */
  type: string
  region: string
}

export type LbArtOptionsResult = { ok: true; options: LbArtOption[] } | { ok: false; error: string }

export type ArtOptionsResult =
  | { ok: true; sgdbGame?: SgdbGame; options: ArtOption[] }
  | { ok: false; error: string }

export interface CacheStats {
  files: number
  bytes: number
}

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

// ---------- jobs (one queue for both interfaces) ----------

export type JobKind = 'steamDownload' | 'emuLaunch' | 'emuDownload' | 'emuInstall' | 'saveUpload' | 'libraryRefresh'

export interface JobProgress {
  done: number
  total: number
  /** bytes per second */
  speed?: number
  /** seconds */
  eta?: number
}

/**
 * One task shown in both interfaces. Built from the real state of the integration that runs it:
 * Steam manifests (Steam runs the download) or the EmuStart engine.
 */
export interface Job {
  id: string
  kind: JobKind
  source: 'steam' | 'emustart'
  gameId?: string
  title: string
  /** human readable phase, e.g. "Pobieranie", "Rozpakowywanie", "Gra uruchomiona" */
  phase: string
  /** waiting = the job needs a decision from the player (e.g. a save conflict) */
  state: 'active' | 'running' | 'done' | 'error' | 'cancelled' | 'queued' | 'waiting'
  progress?: JobProgress
  message?: string
  cancellable: boolean
  /** Steam runs this download — Lumen can only show it and open the Steam window */
  managedBySteam?: boolean
}

/** EmuStart launch session as reported by the engine (launch_status). */
export interface EmuLaunchStatus {
  phase: 'idle' | 'preparing' | 'downloading' | 'extracting' | 'running' | 'finished' | 'error' | 'cancelled' | 'conflict'
  game_id?: number
  title?: string
  system?: string
  message?: string
  mode?: string
  copying?: boolean
  locked_by?: string
  missing_core?: boolean
  notice?: string
  progress?: { done: number; total: number; left?: number; speed?: number; eta?: number; file?: number; files?: number }
  /** phase "conflict": save bundles changed here and on another device (syncclient Conflict.describe) */
  conflict?: EmuSaveConflict[]
}

export interface EmuSaveConflict {
  emulator: string
  core: string
  kind: 'saves' | 'states' | 'memcards' | string
  server_revision: number
  /** unix seconds */
  server_time: number
  server_device: string
  local_time: number
  local_files: number
}

/** Save sync of one game with the server (syncclient.status). */
export interface EmuSaveSync {
  state: 'synced' | 'pending' | 'never' | 'offline' | string
  /** unix seconds */
  last: number
}

/** A save state of a game on this PC (EmuStart's "Wczytaj zapis" list) */
export interface EmuLocalState {
  path: string
  /** "Kontynuuj", "Stan #3", or the file name */
  label: string
  /** unix seconds */
  time: number
  /** picture the emulator stored with the state (data: URL) */
  thumb?: string
  resume?: boolean
  /** name of the state in the game's save bundle — launch with "arc:<arc>" (EmuStart 0.48.1) */
  arc?: string
  /** state saved by another core of this game: playing it switches the game to that core */
  otherCore?: string
  /** "rdzeń bsnes — nie wczyta się w snes9x" */
  detail?: string
}

/** A PS2 state on the server, from this PC or the phone (EmuStart's save manager) */
export interface EmuRemoteState {
  platform: 'windows' | 'android' | string
  label: string
  slot: string
  rel: string
  name: string
  size: number
  mtime: number
  targets: { platform: string; emu: string; label: string; ok: boolean | null; note: string }[]
}

/** Everything the desktop shows about a game's saves */
export interface EmuSaves {
  sync: EmuSaveSync & { bundles: number }
  states: EmuLocalState[]
  /** PS2 states of this PC and the phone; absent with a reason when the server is out of reach */
  remote: { ok: true; here: string; states: EmuRemoteState[] } | { ok: false; reason: string }
}

/** How the player settles a save conflict: keep this device's version, take the server's, or skip sync this time. */
export type SaveChoice = 'local' | 'remote' | 'skip'

export interface SaveConflict {
  profile?: string
  file?: string
  at?: number
  [k: string]: unknown
}

export interface EmuRuntime {
  launch: EmuLaunchStatus
  /** save files waiting to be sent to the server ("" = none) */
  postPending: string
  conflicts: SaveConflict[]
  server: EmuServerState | null
}

export interface JobsSnapshot {
  jobs: Job[]
  emu: EmuRuntime | null
}

export type EmuMissing = { kind: 'emulator'; es: string; system: string; installable: boolean; steps: string[] }

export type EmuReadiness =
  | { ok: true; emulator: string; system: string; missing: EmuMissing[]; sync?: EmuSaveSync }
  | { ok: false; reason: string }

export interface EmuActionResult {
  ok: boolean
  message?: string
  error?: string
  /** launch could not start: these components are missing */
  needInstall?: { es: string; system: string; steps: string[] }
}

export interface EmuSettings {
  dataDir: string
  emuRoot: string
  cacheDir: string
  cacheRecent: number
  account?: string
  serverVia?: string
  enroll?: { url?: string; code?: string } | null
  profiles: { id: number; name: string }[]
  profileId?: number
}

export type UiMode = 'desktop' | 'fullscreen'

/** EmuStart library settings shared by both interfaces (stored by the engine, per profile where EmuStart does so). */
export interface EmuOptions {
  hide: { beta: boolean; demo: boolean; pirate: boolean; unl: boolean; program: boolean }
  arcadeClones: boolean
  cacheRecent: number
  streamPlay: boolean
  streamMinSeconds: number
  /** WinFsp state ("dostępny" = streaming possible) */
  winfsp: string
  askProfile: boolean
  profileSettings: boolean
  machineProfile?: number
  profiles: { id: number; name: string }[]
  systems: { es: string; display: string; enabled: boolean; emulator: string; known: boolean }[]
}

export type EmuOptionsPatch = Partial<{
  hide: Partial<EmuOptions['hide']>
  arcadeClones: boolean
  cacheRecent: number
  streamPlay: boolean
  streamMinSeconds: number
  askProfile: boolean
  profileSettings: boolean
  machineProfile: number
}>

export interface EmuEmulatorOption {
  label: string
  exe: string
  args: string
}

// ---------- self-update (GitHub releases, like EmuStart) ----------

/** zip = folder version, installed = setup.exe, portable = single exe, dev = from sources (no updates) */
export type UpdateFlavor = 'zip' | 'installed' | 'portable' | 'dev'

export interface UpdateInfo {
  version: string
  current: string
  newer: boolean
  flavor: UpdateFlavor
  /** the release file for this build */
  file?: { name: string; url: string; size: number; sha256: string }
  sigUrl?: string
  notes: string
  page: string
  published: string
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'verifying' | 'extracting' | 'ready' | 'applying' | 'error'
  info?: UpdateInfo
  done: number
  total: number
  error?: string
  checkedAt?: number
}

// ---------- in-app path picker (gamepad friendly, no system dialog) ----------

export interface FsEntry {
  name: string
  path: string
  /** place = shortcut on the first page (Lumen data, Desktop…) */
  kind: 'drive' | 'dir' | 'file' | 'place'
  note?: string
}

export interface FsListOptions {
  kind: 'folder' | 'file'
  /** file mode: allowed extensions without the dot, e.g. ["png", "jpg"] */
  extensions?: string[]
}

export interface FsListing {
  /** '' = first page (shortcuts and drives) */
  path: string
  /** null on the first page; '' = back to the first page */
  parent: string | null
  entries: FsEntry[]
  truncated: boolean
  error?: string
}
