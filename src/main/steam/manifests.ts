import type { DownloadProgress, InstallState } from '@shared/types'
import { parseVdf, vnum, vobj, vstr } from './vdf'

// EAppState flags as written into appmanifest_<appid>.acf "StateFlags".
// Source: Steamworks SDK (steamclientpublic.h, EAppState). Not a public API contract.
export const AppState = {
  Uninstalled: 1,
  UpdateRequired: 2,
  FullyInstalled: 4,
  Encrypted: 8,
  Locked: 16,
  FilesMissing: 32,
  AppRunning: 64,
  FilesCorrupt: 128,
  UpdateRunning: 256,
  UpdatePaused: 512,
  UpdateStarted: 1024,
  Uninstalling: 2048,
  BackupRunning: 4096,
  Reconfiguring: 65536,
  Validating: 131072,
  AddingFiles: 262144,
  Preallocating: 524288,
  Downloading: 1048576,
  Staging: 2097152,
  Committing: 4194304,
  UpdateStopping: 8388608
} as const

export interface ManifestInfo {
  appId: number
  name: string
  stateFlags: number
  installDir?: string
  sizeOnDisk?: number
  buildId?: string
  lastUpdated?: number
  bytesToDownload: number
  bytesDownloaded: number
  bytesToStage: number
  bytesStaged: number
}

export function parseManifest(text: string): ManifestInfo | null {
  const root = vobj(parseVdf(text), 'AppState')
  if (!root) return null
  const appId = vnum(root, 'appid')
  if (!appId) return null
  return {
    appId,
    name: vstr(root, 'name') || vstr(root, 'UserConfig', 'name') || `App ${appId}`,
    stateFlags: vnum(root, 'StateFlags') ?? 0,
    installDir: vstr(root, 'installdir'),
    sizeOnDisk: vnum(root, 'SizeOnDisk'),
    buildId: vstr(root, 'buildid'),
    lastUpdated: vnum(root, 'LastUpdated'),
    bytesToDownload: vnum(root, 'BytesToDownload') ?? 0,
    bytesDownloaded: vnum(root, 'BytesDownloaded') ?? 0,
    bytesToStage: vnum(root, 'BytesToStage') ?? 0,
    bytesStaged: vnum(root, 'BytesStaged') ?? 0
  }
}

const has = (flags: number, f: number): boolean => (flags & f) !== 0

const ACTIVE_TRANSFER =
  AppState.UpdateRunning |
  AppState.UpdateStarted |
  AppState.Downloading |
  AppState.Staging |
  AppState.Committing |
  AppState.Preallocating |
  AppState.AddingFiles |
  AppState.Validating |
  AppState.Reconfiguring

/** Map raw StateFlags to the simplified state shown in the UI. */
export function mapInstallState(flags: number): InstallState {
  if (flags === 0) return 'broken'
  if (has(flags, AppState.Uninstalling)) return 'uninstalling'
  const fully = has(flags, AppState.FullyInstalled)
  if (has(flags, AppState.FilesMissing) || has(flags, AppState.FilesCorrupt)) return 'broken'
  if (has(flags, AppState.UpdatePaused)) return 'updatePaused'
  if ((flags & ACTIVE_TRANSFER) !== 0) return fully ? 'updating' : 'installing'
  if (has(flags, AppState.UpdateRequired)) return fully ? 'updateRequired' : 'installing'
  if (fully) return 'installed'
  if (has(flags, AppState.Uninstalled)) return 'notInstalled'
  return 'broken'
}

/** Whether the game can be launched right now (Steam may still apply an update first). */
export function isPlayable(state: InstallState): boolean {
  return state === 'installed' || state === 'updateRequired'
}

/**
 * Progress counters straight from the manifest. Only returned when Steam actually
 * reports a non-zero target; we never synthesise progress.
 */
export function manifestProgress(m: ManifestInfo): DownloadProgress | undefined {
  if (m.bytesToDownload <= 0 && m.bytesToStage <= 0) return undefined
  return {
    bytesDownloaded: m.bytesDownloaded,
    bytesToDownload: m.bytesToDownload,
    bytesStaged: m.bytesStaged,
    bytesToStage: m.bytesToStage
  }
}

/** Steam's own tools/redistributables that should not appear as games by default. */
export const TOOL_APP_IDS = new Set<number>([
  228980, // Steamworks Common Redistributables
  1070560, // Steam Linux Runtime
  1391110, // Steam Linux Runtime - soldier
  1628350, // Steam Linux Runtime - sniper
  1493710, // Proton Experimental
  1826330, // Proton EasyAntiCheat Runtime
  1161040, // Proton BattlEye Runtime
  250820, // SteamVR
  1245040, // Proton 5.0
  961940 // Proton 3.16
])

export function isToolApp(appId: number, name: string): boolean {
  if (TOOL_APP_IDS.has(appId)) return true
  return /^(Steamworks Common Redistributables|Steam Linux Runtime|Proton\b|Steamworks SDK|Source SDK)/i.test(name)
}
