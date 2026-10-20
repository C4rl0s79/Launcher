import { create } from 'zustand'
import type { LumenApi } from '@shared/api'
import type { Category, Game, JobsSnapshot, LibrarySnapshot, Prefs, Settings, SteamCollection } from '@shared/types'

declare global {
  interface Window {
    lumen: LumenApi
  }
}

export const api = (): LumenApi => window.lumen

/** 'home', 'settings' or a group tab: `group:<categoryId>` */
export type Tab = string
export const groupTab = (categoryId: string): Tab => `group:${categoryId}`
export const tabCategoryId = (tab: Tab): string | null => (tab.startsWith('group:') ? tab.slice(6) : null)
export type InputMode = 'keyboard' | 'gamepad' | 'mouse'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface State {
  snapshot: LibrarySnapshot | null
  /** one task list shared with the fullscreen interface (Steam downloads, EmuStart jobs) */
  jobs: JobsSnapshot
  /** jobs panel open */
  jobsOpen: boolean
  prefs: Prefs | null
  settings: Settings | null
  artRev: Record<string, number>
  tab: Tab
  detailsId: string | null
  inputMode: InputMode
  toasts: Toast[]
  setSnapshot(s: LibrarySnapshot): void
  setJobs(j: JobsSnapshot): void
  setJobsOpen(open: boolean): void
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
    // a group tab is validated by the app once preferences are loaded
    return t === 'settings' || t?.startsWith('group:') ? t : 'home'
  } catch {
    return 'home'
  }
}

export const useStore = create<State>((set) => ({
  snapshot: null,
  jobs: { jobs: [], emu: null },
  jobsOpen: false,
  prefs: null,
  settings: null,
  artRev: {},
  tab: savedTab(),
  detailsId: null,
  inputMode: 'keyboard',
  toasts: [],
  setSnapshot: (snapshot) => set({ snapshot }),
  setJobs: (jobs) => set({ jobs }),
  setJobsOpen: (jobsOpen) => set({ jobsOpen }),
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
  openDetails: (detailsId) => {
    // the fullscreen interface opens on the same game after a mode switch
    if (detailsId) api().ui.select(detailsId)
    set({ detailsId })
  },
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

/**
 * Steam apps (and demo data) — the "Steam" group. Shortcuts to emulated games are always
 * "installed" and never downloaded, so they live in their Steam collections (one per platform),
 * favourites and the home screen. EmuStart games have their own platform groups.
 */
export function storeGames(games: Game[]): Game[] {
  return games.filter((g) => g.source === 'steam' || g.source === 'demo')
}

export function gamesForCategory(cat: Category, games: Game[], prefs: Prefs, collections: SteamCollection[] | null): Game[] {
  if (cat.kind === 'steam') {
    const col = collections?.find((c) => c.id === cat.steamCollectionId)
    if (!col) return []
    const ids = new Set(col.appIds)
    return games.filter((g) => (g.source === 'steam' || g.source === 'shortcut') && ids.has(g.appId))
  }
  if (cat.kind === 'emustart') return games.filter((g) => g.emu?.es === cat.emuSystem)
  const favs = new Set(prefs.favorites)
  switch (cat.smart) {
    case 'recent':
      return games
        .filter((g) => g.lastPlayed)
        .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
        .slice(0, 24)
    case 'installed':
      return storeGames(games).filter((g) => g.installed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.sortName.localeCompare(b.sortName, 'pl'))
    case 'favorites':
      return games.filter((g) => favs.has(g.id))
    case 'notInstalled':
      return storeGames(games).filter((g) => !g.installed)
    case 'all':
      return storeGames(games)
    default:
      return games.filter((g) => prefs.gameCategories[g.id]?.includes(cat.id))
  }
}

/** Steam collections (read-only) that contain this game. */
export function steamCollectionsOf(game: Game, prefs: Prefs, collections: SteamCollection[] | null): Category[] {
  if (game.source === 'demo' || game.source === 'emustart' || !collections) return []
  return sortedCategories(prefs).filter(
    (c) => c.kind === 'steam' && collections.find((col) => col.id === c.steamCollectionId)?.appIds.includes(game.appId)
  )
}

export function sortedCategories(prefs: Prefs): Category[] {
  return [...prefs.categories].sort((a, b) => a.order - b.order)
}
