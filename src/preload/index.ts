import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { ART_SCHEME, IPC, type LumenApi } from '../shared/api'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const prefsOp = (op: string, ...args: unknown[]) => invoke<never>(IPC.prefsOp, op, ...args)

const api: LumenApi = {
  library: {
    get: () => invoke(IPC.libraryGet),
    refresh: (includeAccount) => invoke(IPC.libraryRefresh, includeAccount),
    onSnapshot: (cb) => subscribe(IPC.librarySnapshot, cb)
  },
  game: {
    play: (id) => invoke(IPC.gamePlay, id),
    install: (id) => invoke(IPC.gameInstall, id),
    openInSteam: (id, view) => invoke(IPC.gameOpen, id, view),
    details: (id, force) => invoke(IPC.gameDetails, id, force)
  },
  prefs: {
    get: () => invoke(IPC.prefsGet),
    toggleFavorite: (id) => prefsOp('toggleFavorite', id),
    setGameCategories: (id, cats) => prefsOp('setGameCategories', id, cats),
    createCategory: (name) => prefsOp('createCategory', name),
    renameCategory: (id, name) => prefsOp('renameCategory', id, name),
    deleteCategory: (id) => prefsOp('deleteCategory', id),
    setPinned: (id, pinned) => prefsOp('setPinned', id, pinned),
    moveCategory: (id, delta) => prefsOp('moveCategory', id, delta),
    onChange: (cb) => subscribe(IPC.prefsChanged, cb)
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    patch: (p) => invoke(IPC.settingsPatch, p),
    setSecret: (name, value) => invoke(IPC.settingsSecret, name, value),
    onChange: (cb) => subscribe(IPC.settingsChanged, cb)
  },
  art: {
    url: (gameId, kind, rev = 0) => `${ART_SCHEME}://img/${encodeURIComponent(gameId)}/${kind}?r=${rev}`,
    options: (id, kind) => invoke(IPC.artOptions, id, kind),
    search: (term) => invoke(IPC.artSearch, term),
    setMatch: (id, g) => invoke(IPC.artSetMatch, id, g),
    choose: (id, kind, option) => invoke(IPC.artChoose, id, kind, option),
    chooseFile: (id, kind) => invoke(IPC.artChooseFile, id, kind),
    useSteam: (id, kind) => invoke(IPC.artUseSteam, id, kind),
    reset: (id, kind) => invoke(IPC.artReset, id, kind),
    onChanged: (cb) => subscribe(IPC.artChanged, cb)
  },
  launchbox: {
    status: () => invoke(IPC.launchboxStatus),
    update: () => invoke(IPC.launchboxUpdate),
    cancel: () => invoke(IPC.launchboxCancel),
    onChange: (cb) => subscribe(IPC.launchboxChanged, cb)
  },
  emustart: {
    launch: (id) => invoke(IPC.emuLaunch, id),
    cancelLaunch: () => invoke(IPC.emuCancelLaunch),
    dismiss: () => invoke(IPC.emuDismiss),
    resolveConflict: (choice) => invoke(IPC.emuResolve, choice),
    toggleKeep: (id) => invoke(IPC.emuToggleKeep, id),
    removeLocal: (id) => invoke(IPC.emuRemoveLocal, id),
    readiness: (id) => invoke(IPC.emuReadiness, id),
    installEmulators: (systems) => invoke(IPC.emuInstall, systems),
    settings: () => invoke(IPC.emuSettings),
    pickFolder: (key) => invoke(IPC.emuPickFolder, key),
    refreshLibrary: () => invoke(IPC.emuRefresh),
    restartEngine: () => invoke(IPC.emuRestart),
    clearConflicts: () => invoke(IPC.emuClearConflicts)
  },
  jobs: {
    get: () => invoke(IPC.jobsGet),
    cancel: (id) => invoke(IPC.jobsCancel, id),
    onChange: (cb) => subscribe(IPC.jobsChanged, cb)
  },
  ui: {
    getMode: () => invoke(IPC.uiGetMode),
    setMode: (mode, then) => invoke(IPC.uiSetMode, mode, then),
    select: (id) => ipcRenderer.send(IPC.uiSelect, id),
    onMode: (cb) => subscribe(IPC.uiMode, cb)
  },
  app: {
    toggleFullscreen: () => invoke(IPC.appFullscreen),
    isFullscreen: () => invoke(IPC.appIsFullscreen),
    cacheStats: () => invoke(IPC.appCacheStats),
    clearCache: () => invoke(IPC.appClearCache),
    openLogs: () => invoke(IPC.appOpenLogs),
    openExternal: (url) => invoke(IPC.appOpenExternal, url),
    pickPath: (o) => invoke(IPC.appPickPath, o),
    quit: () => invoke(IPC.appQuit),
    onFocusChange: (cb) => subscribe(IPC.appFocus, cb),
    onPadState: (cb) => subscribe(IPC.padState, cb),
    platform: process.platform
  }
}

contextBridge.exposeInMainWorld('lumen', api)
