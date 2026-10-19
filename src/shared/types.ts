// Types shared between the main process, preload bridge and renderer.
// Game identity is always the stable `id` ("steam:<appid>"), never the title.

export type GameSource = 'steam' | 'demo'

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
export type Provenance = 'localManifest' | 'accountApi' | 'demo'

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
  /** minutes */
  playtimeMinutes?: number
  running?: boolean
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
}

export interface GameDetails {
  appId: number
  fetchedAt: number
  source: 'steamStore'
  name?: string
  shortDescription?: string
  descriptionHtml?: string
  genres?: string[]
  releaseDate?: string
  comingSoon?: boolean
  developers?: string[]
  publishers?: string[]
  website?: string
}

export type DetailsResult =
  | { ok: true; details: GameDetails; stale: boolean }
  | { ok: false; error: string }

// ---------- User preferences (local only) ----------

export type SmartCategoryType = 'recent' | 'installed' | 'favorites' | 'notInstalled' | 'all'

export interface Category {
  id: string
  name: string
  /** smart = built-in rule, custom = Lumen category, steam = mirror of a Steam collection (read-only) */
  kind: 'smart' | 'custom' | 'steam'
  smart?: SmartCategoryType
  steamCollectionId?: string
  pinned: boolean
  /** order among pinned categories on the home screen */
  order: number
}

export type ArtKind = 'grid' | 'hero' | 'logo' | 'icon'

export type ArtChoice =
  | { type: 'sgdb'; imageId: number; url: string; thumb?: string }
  | { type: 'file'; file: string }
  | { type: 'steam' }
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
  version: 1
  categories: Category[]
  /** gameId -> custom category ids */
  gameCategories: Record<string, string[]>
  favorites: string[]
  art: Record<string, GameArtPrefs>
}

export type ArtSourcePriority = 'sgdbFirst' | 'steamFirst'
export type AfterLaunch = 'minimize' | 'keep'

export interface Settings {
  version: 1
  steamIdOverride?: string
  artPriority: ArtSourcePriority
  afterLaunch: AfterLaunch
  restoreAfterGame: boolean
  startFullscreen: boolean
  showTools: boolean
  demoMode: boolean
  language: string
  hasSgdbKey: boolean
  hasSteamWebKey: boolean
  secretsEncrypted: boolean
}

export type SettingsPatch = Partial<
  Pick<
    Settings,
    'steamIdOverride' | 'artPriority' | 'afterLaunch' | 'restoreAfterGame' | 'startFullscreen' | 'showTools' | 'demoMode'
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

export type ArtOptionsResult =
  | { ok: true; sgdbGame?: SgdbGame; options: ArtOption[] }
  | { ok: false; error: string }

export interface CacheStats {
  files: number
  bytes: number
}

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }
