import { create } from 'zustand'
import type { LumenApi } from '@shared/api'
import type { Category, Game, LibrarySnapshot, Prefs, Settings, SteamCollection } from '@shared/types'

declare global {
  interface Window {
    lumen: LumenApi
  }
}

export const api = (): LumenApi => window.lumen

export type Tab = 'home' | 'library' | 'settings'
export type InputMode = 'keyboard' | 'gamepad' | 'mouse'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface State {
  snapshot: LibrarySnapshot | null
  prefs: Prefs | null
  settings: Settings | null
  artRev: Record<string, number>
  tab: Tab
  detailsId: string | null
  inputMode: InputMode
  toasts: Toast[]
  /** set by "show all" tiles on the home screen; consumed by the library screen */
  libraryRequest: { category: string | null; n: number } | null
  showInLibrary(category: string | null): void
  setSnapshot(s: LibrarySnapshot): void
  setPrefs(p: Prefs): void
  setSettings(s: Settings): void
  bumpArt(gameId: string, rev: number): void
  setTab(t: Tab): void
  openDetails(id: string | null): void
  setInputMode(m: InputMode): void
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
}

let toastId = 0

const savedTab = (): Tab => {
  try {
    const t = localStorage.getItem('lumen.tab')
    return t === 'library' || t === 'settings' ? t : 'home'
  } catch {
    return 'home'
  }
}

export const useStore = create<State>((set) => ({
  snapshot: null,
  prefs: null,
  settings: null,
  artRev: {},
  tab: savedTab(),
  detailsId: null,
  inputMode: 'keyboard',
  toasts: [],
  libraryRequest: null,
  showInLibrary: (category) => {
    useStore.getState().setTab('library')
    set((s) => ({ libraryRequest: { category, n: (s.libraryRequest?.n ?? 0) + 1 } }))
  },
  setSnapshot: (snapshot) => set({ snapshot }),
  setPrefs: (prefs) => set({ prefs }),
  setSettings: (settings) => set({ settings }),
  bumpArt: (gameId, rev) => set((s) => ({ artRev: { ...s.artRev, [gameId]: rev } })),
  setTab: (tab) => {
    try {
      localStorage.setItem('lumen.tab', tab)
    } catch {
      /* ignore */
    }
    set({ tab })
  },
  openDetails: (detailsId) => set({ detailsId }),
  setInputMode: (inputMode) => set((s) => (s.inputMode === inputMode ? s : { inputMode })),
  toast: (text, kind = 'info') =>
    set((s) => {
      const id = ++toastId
      setTimeout(() => useStore.getState().dismissToast(id), kind === 'error' ? 6000 : 3500)
      return { toasts: [...s.toasts.slice(-2), { id, text, kind }] }
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** Report an error from an API call as a toast and swallow it. */
export async function attempt<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p
  } catch (e) {
    const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    useStore.getState().toast(msg, 'error')
    return undefined
  }
}

// ---------- selectors ----------

export function gamesForCategory(cat: Category, games: Game[], prefs: Prefs, collections: SteamCollection[] | null): Game[] {
  if (cat.kind === 'steam') {
    const col = collections?.find((c) => c.id === cat.steamCollectionId)
    if (!col) return []
    const ids = new Set(col.appIds)
    return games.filter((g) => (g.source === 'steam' || g.source === 'shortcut') && ids.has(g.appId))
  }
  const favs = new Set(prefs.favorites)
  switch (cat.smart) {
    case 'recent':
      return games
        .filter((g) => g.lastPlayed)
        .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
        .slice(0, 24)
    case 'installed':
      return games.filter((g) => g.installed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.sortName.localeCompare(b.sortName, 'pl'))
    case 'favorites':
      return games.filter((g) => favs.has(g.id))
    case 'notInstalled':
      return games.filter((g) => !g.installed)
    case 'all':
      return games
    default:
      return games.filter((g) => prefs.gameCategories[g.id]?.includes(cat.id))
  }
}

/** Steam collections (read-only) that contain this game. */
export function steamCollectionsOf(game: Game, prefs: Prefs, collections: SteamCollection[] | null): Category[] {
  if (game.source === 'demo' || !collections) return []
  return sortedCategories(prefs).filter(
    (c) => c.kind === 'steam' && collections.find((col) => col.id === c.steamCollectionId)?.appIds.includes(game.appId)
  )
}

export function sortedCategories(prefs: Prefs): Category[] {
  return [...prefs.categories].sort((a, b) => a.order - b.order)
}
