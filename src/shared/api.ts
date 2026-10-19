import type {
  ActionResult,
  ArtKind,
  ArtOption,
  ArtOptionsResult,
  CacheStats,
  DetailsResult,
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
  app: {
    toggleFullscreen(): Promise<boolean>
    isFullscreen(): Promise<boolean>
    cacheStats(): Promise<CacheStats>
    clearCache(): Promise<CacheStats>
    openLogs(): Promise<void>
    openExternal(url: string): Promise<void>
    quit(): Promise<void>
    onFocusChange(cb: (focused: boolean) => void): () => void
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
  appFocus: 'app:focus'
} as const

export const ART_SCHEME = 'lumen-art'
