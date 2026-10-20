import type {
  ActionResult,
  ArtKind,
  ArtOption,
  ArtOptionsResult,
  CacheStats,
  DetailsResult,
  EmuActionResult,
  EmuReadiness,
  EmuSettings,
  JobsSnapshot,
  UiMode,
  LaunchBoxStatus,
  PadState,
  LibrarySnapshot,
  Prefs,
  SecretName,
  Settings,
  SettingsPatch,
  SgdbGame
} from './types'

/** The API exposed on window.lumen by the preload script. */
export interface LumenApi {
  library: {
    get(): Promise<LibrarySnapshot>
    refresh(includeAccount: boolean): Promise<LibrarySnapshot>
    onSnapshot(cb: (s: LibrarySnapshot) => void): () => void
  }
  game: {
    play(gameId: string): Promise<ActionResult>
    install(gameId: string): Promise<ActionResult>
    openInSteam(gameId: string, view: 'details' | 'store' | 'downloads'): Promise<ActionResult>
    details(gameId: string, force?: boolean): Promise<DetailsResult>
  }
  prefs: {
    get(): Promise<Prefs>
    toggleFavorite(gameId: string): Promise<Prefs>
    setGameCategories(gameId: string, categoryIds: string[]): Promise<Prefs>
    createCategory(name: string): Promise<Prefs>
    renameCategory(id: string, name: string): Promise<Prefs>
    deleteCategory(id: string): Promise<Prefs>
    setPinned(id: string, pinned: boolean): Promise<Prefs>
    moveCategory(id: string, delta: number): Promise<Prefs>
    onChange(cb: (p: Prefs) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    patch(p: SettingsPatch): Promise<Settings>
    setSecret(name: SecretName, value: string | null): Promise<Settings>
    onChange(cb: (s: Settings) => void): () => void
  }
  art: {
    url(gameId: string, kind: ArtKind, rev?: number): string
    options(gameId: string, kind: ArtKind): Promise<ArtOptionsResult>
    search(term: string): Promise<{ ok: true; games: SgdbGame[] } | { ok: false; error: string }>
    setMatch(gameId: string, sgdbGame: SgdbGame | null): Promise<Prefs>
    choose(gameId: string, kind: ArtKind, option: ArtOption): Promise<Prefs>
    chooseFile(gameId: string, kind: ArtKind): Promise<Prefs | null>
    useSteam(gameId: string, kind: ArtKind): Promise<Prefs>
    reset(gameId: string, kind: ArtKind): Promise<Prefs>
    onChanged(cb: (gameId: string, rev: number) => void): () => void
  }
  launchbox: {
    status(): Promise<LaunchBoxStatus>
    update(): Promise<LaunchBoxStatus>
    cancel(): Promise<void>
    onChange(cb: (s: LaunchBoxStatus) => void): () => void
  }
  /** EmuStart games: every action runs in the EmuStart engine (engine/emustart) */
  emustart: {
    launch(gameId: string): Promise<EmuActionResult>
    /** stop the download of the game being launched */
    cancelLaunch(): Promise<void>
    /** close the finished / failed launch session */
    dismiss(): Promise<void>
    /** keep the game on this PC (download now, outside the "last N games" limit) or stop keeping it */
    toggleKeep(gameId: string): Promise<EmuActionResult>
    removeLocal(gameId: string): Promise<EmuActionResult>
    readiness(gameId: string): Promise<EmuReadiness>
    installEmulators(systems: string[]): Promise<EmuActionResult>
    settings(): Promise<EmuSettings>
    pickFolder(key: 'emu_root' | 'cache_dir'): Promise<EmuSettings>
    refreshLibrary(): Promise<EmuActionResult>
    restartEngine(): Promise<void>
    clearConflicts(): Promise<void>
  }
  jobs: {
    get(): Promise<JobsSnapshot>
    cancel(jobId: string): Promise<EmuActionResult>
    onChange(cb: (j: JobsSnapshot) => void): () => void
  }
  /** desktop (Lumen look) ⇄ fullscreen (EmuStart look); both use the same core */
  ui: {
    getMode(): Promise<UiMode>
    /** `then` — what to open in the fullscreen interface (EmuStart settings: login, profiles, emulators) */
    setMode(mode: UiMode, then?: 'settings'): Promise<void>
    /** the game the user is looking at (kept when switching modes) */
    select(gameId: string | null): void
    onMode(cb: (mode: UiMode, selection: string | null) => void): () => void
  }
  app: {
    toggleFullscreen(): Promise<boolean>
    isFullscreen(): Promise<boolean>
    cacheStats(): Promise<CacheStats>
    clearCache(): Promise<CacheStats>
    openLogs(): Promise<void>
    openExternal(url: string): Promise<void>
    quit(): Promise<void>
    onFocusChange(cb: (focused: boolean) => void): () => void
    /** XInput controller state from the main process (see main/input/xinput.ts) */
    onPadState(cb: (pads: PadState[]) => void): () => void
    platform: string
  }
}

export const IPC = {
  libraryGet: 'library:get',
  libraryRefresh: 'library:refresh',
  librarySnapshot: 'library:snapshot',
  gamePlay: 'game:play',
  gameInstall: 'game:install',
  gameOpen: 'game:open',
  gameDetails: 'game:details',
  prefsGet: 'prefs:get',
  prefsOp: 'prefs:op',
  prefsChanged: 'prefs:changed',
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsSecret: 'settings:secret',
  settingsChanged: 'settings:changed',
  artOptions: 'art:options',
  artSearch: 'art:search',
  artSetMatch: 'art:setMatch',
  artChoose: 'art:choose',
  artChooseFile: 'art:chooseFile',
  artUseSteam: 'art:useSteam',
  artReset: 'art:reset',
  artChanged: 'art:changed',
  appFullscreen: 'app:fullscreen',
  appIsFullscreen: 'app:isFullscreen',
  appCacheStats: 'app:cacheStats',
  appClearCache: 'app:clearCache',
  appOpenLogs: 'app:openLogs',
  appOpenExternal: 'app:openExternal',
  appQuit: 'app:quit',
  appFocus: 'app:focus',
  launchboxStatus: 'launchbox:status',
  launchboxUpdate: 'launchbox:update',
  launchboxCancel: 'launchbox:cancel',
  launchboxChanged: 'launchbox:changed',
  padState: 'pad:state',
  emuLaunch: 'emu:launch',
  emuCancelLaunch: 'emu:cancelLaunch',
  emuDismiss: 'emu:dismiss',
  emuToggleKeep: 'emu:toggleKeep',
  emuRemoveLocal: 'emu:removeLocal',
  emuReadiness: 'emu:readiness',
  emuInstall: 'emu:install',
  emuSettings: 'emu:settings',
  emuPickFolder: 'emu:pickFolder',
  emuRefresh: 'emu:refresh',
  emuRestart: 'emu:restart',
  emuClearConflicts: 'emu:clearConflicts',
  jobsGet: 'jobs:get',
  jobsCancel: 'jobs:cancel',
  jobsChanged: 'jobs:changed',
  uiGetMode: 'ui:getMode',
  uiSetMode: 'ui:setMode',
  uiSelect: 'ui:select',
  uiMode: 'ui:mode'
  // channels of the fullscreen view: shared/emuPad.ts (EMU_UI), kept apart so the two sandboxed
  // preload bundles share no module
} as const

export const ART_SCHEME = 'lumen-art'
/** EmuStart's fullscreen UI files (engine/web) and its /media, /assets proxied to the engine */
export const EMU_UI_SCHEME = 'lumen-emu'
