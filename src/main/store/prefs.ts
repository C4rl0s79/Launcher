import { randomUUID } from 'node:crypto'
import type { ArtChoice, ArtKind, Category, EmuSystem, GameArtPrefs, Prefs, SteamCollection } from '@shared/types'
import { JsonFile } from './jsonFile'

// User library preferences: categories, favourites, artwork choices.
// Pure functions below are unit-tested; PrefsStore adds persistence.

/** Pinned categories are the group tabs in the top bar (Start always comes first). */
// The top bar holds platforms/groups; installed / not installed is the group view's filter, so
// there are no separate built-in groups for it any more (removed in v3).
export const SMART_CATEGORIES: Category[] = [
  { id: 'smart:all', name: 'Steam', kind: 'smart', smart: 'all', pinned: true, order: 0 },
  { id: 'smart:favorites', name: 'Ulubione', kind: 'smart', smart: 'favorites', pinned: true, order: 1 },
  { id: 'smart:recent', name: 'Ostatnio grane', kind: 'smart', smart: 'recent', pinned: false, order: 2 }
]
const REMOVED_SMART = new Set(['smart:installed', 'smart:notInstalled'])

export const PREFS_VERSION = 3

export function defaultPrefs(): Prefs {
  return { version: PREFS_VERSION, categories: SMART_CATEGORIES.map((c) => ({ ...c })), gameCategories: {}, favorites: [], art: {}, versions: {} }
}

export function migratePrefs(raw: unknown): Prefs {
  const base = defaultPrefs()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<Prefs>
  let categories = Array.isArray(r.categories) ? r.categories.filter(isCategory).filter((c) => !REMOVED_SMART.has(c.id)) : []
  // make sure every smart category exists exactly once (new ones may be added in updates)
  for (const smart of base.categories) {
    if (!categories.some((c) => c.id === smart.id)) categories.push({ ...smart, order: categories.length })
  }
  if ((r.version ?? 1) < 2) {
    // v2: home screen shows "recently played" itself; pinned categories became top-bar group tabs
    categories = categories.map((c) =>
      c.id === 'smart:recent' ? { ...c, pinned: false } : c.id === 'smart:all' ? { ...c, pinned: true, order: -1 } : c
    )
  }
  if ((r.version ?? 1) < 3) {
    // v3: "all games" is the Steam platform tab (emulator platforms come from Steam collections)
    categories = categories.map((c) => (c.id === 'smart:all' ? { ...c, name: 'Steam' } : c))
  }
  const prefs: Prefs = {
    version: PREFS_VERSION,
    categories,
    gameCategories: isRecord(r.gameCategories) ? sanitizeGameCategories(r.gameCategories) : {},
    favorites: Array.isArray(r.favorites) ? r.favorites.filter((x) => typeof x === 'string') : [],
    art: isRecord(r.art) ? (r.art as Record<string, GameArtPrefs>) : {},
    versions: isRecord(r.versions)
      ? Object.fromEntries(Object.entries(r.versions).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : {}
  }
  return normalizeOrder(prefs)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isCategory(c: unknown): c is Category {
  if (!isRecord(c)) return false
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    (c.kind === 'smart' || c.kind === 'custom' || c.kind === 'steam' || c.kind === 'emustart')
  )
}

function sanitizeGameCategories(v: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, ids] of Object.entries(v)) {
    if (Array.isArray(ids)) out[k] = ids.filter((x): x is string => typeof x === 'string')
  }
  return out
}

/** Re-number `order` so it is dense and stable. */
function normalizeOrder(p: Prefs): Prefs {
  const sorted = [...p.categories].sort((a, b) => a.order - b.order)
  sorted.forEach((c, i) => (c.order = i))
  return { ...p, categories: sorted }
}

export class PrefsError extends Error {}

export const steamCategoryId = (collectionId: string): string => `steamcol:${collectionId}`
export const emuCategoryId = (es: string): string => `emusys:${es}`
const steamCategoryName = (c: SteamCollection): string => (c.kind === 'favorite' ? 'Ulubione w Steam' : c.name)

export const ops = {
  createCategory(p: Prefs, name: string, id: string = `cat:${randomUUID()}`): Prefs {
    const clean = name.trim()
    if (!clean) throw new PrefsError('Nazwa kategorii nie może być pusta.')
    if (clean.length > 60) throw new PrefsError('Nazwa kategorii jest za długa (maks. 60 znaków).')
    if (p.categories.some((c) => c.name.toLocaleLowerCase('pl') === clean.toLocaleLowerCase('pl')))
      throw new PrefsError(`Kategoria „${clean}” już istnieje.`)
    const cat: Category = { id, name: clean, kind: 'custom', pinned: false, order: p.categories.length }
    return { ...p, categories: [...p.categories, cat] }
  },

  renameCategory(p: Prefs, id: string, name: string): Prefs {
    const clean = name.trim()
    if (!clean) throw new PrefsError('Nazwa kategorii nie może być pusta.')
    if (p.categories.find((c) => c.id === id)?.kind === 'steam')
      throw new PrefsError('Nazwę kolekcji Steam można zmienić tylko w kliencie Steam.')
    if (p.categories.find((c) => c.id === id)?.kind === 'emustart')
      throw new PrefsError('Nazwa platformy pochodzi z serwera EmuStart.')
    if (p.categories.some((c) => c.id !== id && c.name.toLocaleLowerCase('pl') === clean.toLocaleLowerCase('pl')))
      throw new PrefsError(`Kategoria „${clean}” już istnieje.`)
    if (!p.categories.some((c) => c.id === id)) throw new PrefsError('Nie znaleziono kategorii.')
    return { ...p, categories: p.categories.map((c) => (c.id === id ? { ...c, name: clean } : c)) }
  },

  deleteCategory(p: Prefs, id: string): Prefs {
    const cat = p.categories.find((c) => c.id === id)
    if (!cat) throw new PrefsError('Nie znaleziono kategorii.')
    if (cat.kind === 'smart') throw new PrefsError('Kategorii wbudowanej nie można usunąć — można ją odpiąć.')
    if (cat.kind === 'steam') throw new PrefsError('Kolekcję Steam można usunąć tylko w kliencie Steam — w Lumen można ją odpiąć.')
    if (cat.kind === 'emustart') throw new PrefsError('Platformy EmuStart wynikają z biblioteki serwera — w Lumen można ją odpiąć.')
    const gameCategories: Record<string, string[]> = {}
    for (const [g, ids] of Object.entries(p.gameCategories)) {
      const rest = ids.filter((x) => x !== id)
      if (rest.length) gameCategories[g] = rest
    }
    return normalizeOrder({ ...p, categories: p.categories.filter((c) => c.id !== id), gameCategories })
  },

  setPinned(p: Prefs, id: string, pinned: boolean): Prefs {
    if (!p.categories.some((c) => c.id === id)) throw new PrefsError('Nie znaleziono kategorii.')
    return { ...p, categories: p.categories.map((c) => (c.id === id ? { ...c, pinned } : c)) }
  },

  /**
   * Move a category up/down by `delta` positions among categories with the same pinned state
   * (so moving a pinned row always changes the home screen order visibly).
   */
  moveCategory(p: Prefs, id: string, delta: number): Prefs {
    const sorted = [...p.categories].sort((a, b) => a.order - b.order)
    const item = sorted.find((c) => c.id === id)
    if (!item) throw new PrefsError('Nie znaleziono kategorii.')
    const peers = sorted.filter((c) => c.pinned === item.pinned)
    const from = peers.indexOf(item)
    const to = Math.max(0, Math.min(peers.length - 1, from + delta))
    if (to === from) return p
    const anchor = peers[to]
    const rest = sorted.filter((c) => c !== item)
    const at = rest.indexOf(anchor) + (to > from ? 1 : 0)
    rest.splice(at, 0, item)
    return { ...p, categories: rest.map((c, i) => ({ ...c, order: i })) }
  },

  setGameCategories(p: Prefs, gameId: string, categoryIds: string[]): Prefs {
    const valid = new Set(p.categories.filter((c) => c.kind === 'custom').map((c) => c.id))
    const ids = [...new Set(categoryIds.filter((x) => valid.has(x)))]
    const gameCategories = { ...p.gameCategories }
    if (ids.length) gameCategories[gameId] = ids
    else delete gameCategories[gameId]
    return { ...p, gameCategories }
  },

  /**
   * Mirror static Steam collections as read-only categories. Pin state and order chosen in
   * Lumen are kept; names follow Steam; collections deleted in Steam disappear. Dynamic and
   * hidden collections are skipped. Returns the same object when nothing changed.
   */
  syncSteamCollections(p: Prefs, collections: SteamCollection[]): Prefs {
    const wanted = collections.filter((c) => !c.dynamic && c.kind !== 'hidden')
    const byId = new Map(wanted.map((c) => [steamCategoryId(c.id), c]))
    let changed = false
    const categories: Category[] = []
    for (const cat of p.categories) {
      if (cat.kind !== 'steam') {
        categories.push(cat)
        continue
      }
      const col = byId.get(cat.id)
      if (!col) {
        changed = true
        continue
      }
      byId.delete(cat.id)
      const name = steamCategoryName(col)
      if (cat.name !== name) changed = true
      categories.push(cat.name === name ? cat : { ...cat, name })
    }
    for (const [id, col] of byId) {
      changed = true
      categories.push({ id, name: steamCategoryName(col), kind: 'steam', steamCollectionId: col.id, pinned: false, order: categories.length })
    }
    return changed ? normalizeOrder({ ...p, categories }) : p
  },

  /**
   * Platforms of the EmuStart server library as read-only categories (group tabs). New platforms
   * are pinned, so emulated games show up next to Steam without setup; pin state and order chosen
   * in Lumen are kept; platforms gone from the server library disappear. Call only with a library
   * read from the engine — never with an empty list caused by the engine not running.
   */
  syncEmustartSystems(p: Prefs, systems: EmuSystem[]): Prefs {
    const byId = new Map(systems.map((s) => [emuCategoryId(s.es), s]))
    let changed = false
    const categories: Category[] = []
    for (const cat of p.categories) {
      if (cat.kind !== 'emustart') {
        categories.push(cat)
        continue
      }
      const sys = byId.get(cat.id)
      if (!sys) {
        changed = true
        continue
      }
      byId.delete(cat.id)
      if (cat.name !== sys.display) changed = true
      categories.push(cat.name === sys.display ? cat : { ...cat, name: sys.display })
    }
    for (const [id, sys] of byId) {
      changed = true
      categories.push({ id, name: sys.display, kind: 'emustart', emuSystem: sys.es, pinned: true, order: categories.length + 1000 })
    }
    return changed ? normalizeOrder({ ...p, categories }) : p
  },

  /** Version of a game with several versions shown and played from now on (undefined = automatic). */
  chooseVersion(p: Prefs, groupId: string, versionId: string | undefined): Prefs {
    const versions = { ...p.versions }
    if (versionId) versions[groupId] = versionId
    else delete versions[groupId]
    return { ...p, versions }
  },

  toggleFavorite(p: Prefs, gameId: string): Prefs {
    const favorites = p.favorites.includes(gameId) ? p.favorites.filter((x) => x !== gameId) : [...p.favorites, gameId]
    return { ...p, favorites }
  },

  setArt(p: Prefs, gameId: string, kind: ArtKind, choice: ArtChoice | undefined): Prefs {
    const current = { ...(p.art[gameId] ?? {}) }
    if (choice) current[kind] = choice
    else delete current[kind]
    return { ...p, art: { ...p.art, [gameId]: current } }
  },

  setSgdbMatch(p: Prefs, gameId: string, sgdbGameId: number | undefined, name?: string): Prefs {
    const current: GameArtPrefs = { ...(p.art[gameId] ?? {}) }
    if (sgdbGameId) {
      current.sgdbGameId = sgdbGameId
      current.sgdbGameName = name
    } else {
      delete current.sgdbGameId
      delete current.sgdbGameName
    }
    // choices made against the old match no longer apply
    for (const k of ['grid', 'hero', 'logo', 'icon'] as const) if (current[k]?.type === 'sgdb') delete current[k]
    return { ...p, art: { ...p.art, [gameId]: current } }
  }
}

export class PrefsStore {
  private file: JsonFile<Prefs>
  private value: Prefs = defaultPrefs()

  constructor(file: string) {
    this.file = new JsonFile(file, defaultPrefs, migratePrefs)
  }

  async init(): Promise<Prefs> {
    this.value = await this.file.load()
    return this.value
  }

  get(): Prefs {
    return this.value
  }

  async update(fn: (p: Prefs) => Prefs): Promise<Prefs> {
    const next = fn(this.value)
    this.value = next
    await this.file.save(next)
    return next
  }
}
