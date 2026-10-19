import { randomUUID } from 'node:crypto'
import type { ArtChoice, ArtKind, Category, GameArtPrefs, Prefs } from '@shared/types'
import { JsonFile } from './jsonFile'

// User library preferences: categories, favourites, artwork choices.
// Pure functions below are unit-tested; PrefsStore adds persistence.

export const SMART_CATEGORIES: Category[] = [
  { id: 'smart:recent', name: 'Ostatnio grane', kind: 'smart', smart: 'recent', pinned: true, order: 0 },
  { id: 'smart:installed', name: 'Zainstalowane', kind: 'smart', smart: 'installed', pinned: true, order: 1 },
  { id: 'smart:favorites', name: 'Ulubione', kind: 'smart', smart: 'favorites', pinned: true, order: 2 },
  { id: 'smart:notInstalled', name: 'Do zainstalowania', kind: 'smart', smart: 'notInstalled', pinned: false, order: 3 },
  { id: 'smart:all', name: 'Wszystkie gry', kind: 'smart', smart: 'all', pinned: false, order: 4 }
]

export function defaultPrefs(): Prefs {
  return { version: 1, categories: SMART_CATEGORIES.map((c) => ({ ...c })), gameCategories: {}, favorites: [], art: {} }
}

export function migratePrefs(raw: unknown): Prefs {
  const base = defaultPrefs()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<Prefs>
  const categories = Array.isArray(r.categories) ? r.categories.filter(isCategory) : []
  // make sure every smart category exists exactly once (new ones may be added in updates)
  for (const smart of base.categories) {
    if (!categories.some((c) => c.id === smart.id)) categories.push({ ...smart, order: categories.length })
  }
  const prefs: Prefs = {
    version: 1,
    categories,
    gameCategories: isRecord(r.gameCategories) ? sanitizeGameCategories(r.gameCategories) : {},
    favorites: Array.isArray(r.favorites) ? r.favorites.filter((x) => typeof x === 'string') : [],
    art: isRecord(r.art) ? (r.art as Record<string, GameArtPrefs>) : {}
  }
  return normalizeOrder(prefs)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isCategory(c: unknown): c is Category {
  if (!isRecord(c)) return false
  return typeof c.id === 'string' && typeof c.name === 'string' && (c.kind === 'smart' || c.kind === 'custom')
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
    if (p.categories.some((c) => c.id !== id && c.name.toLocaleLowerCase('pl') === clean.toLocaleLowerCase('pl')))
      throw new PrefsError(`Kategoria „${clean}” już istnieje.`)
    if (!p.categories.some((c) => c.id === id)) throw new PrefsError('Nie znaleziono kategorii.')
    return { ...p, categories: p.categories.map((c) => (c.id === id ? { ...c, name: clean } : c)) }
  },

  deleteCategory(p: Prefs, id: string): Prefs {
    const cat = p.categories.find((c) => c.id === id)
    if (!cat) throw new PrefsError('Nie znaleziono kategorii.')
    if (cat.kind === 'smart') throw new PrefsError('Kategorii wbudowanej nie można usunąć — można ją odpiąć.')
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

  /** Move a category up/down by `delta` positions in the global order. */
  moveCategory(p: Prefs, id: string, delta: number): Prefs {
    const sorted = [...p.categories].sort((a, b) => a.order - b.order)
    const idx = sorted.findIndex((c) => c.id === id)
    if (idx < 0) throw new PrefsError('Nie znaleziono kategorii.')
    const target = Math.max(0, Math.min(sorted.length - 1, idx + delta))
    const [item] = sorted.splice(idx, 1)
    sorted.splice(target, 0, item)
    return { ...p, categories: sorted.map((c, i) => ({ ...c, order: i })) }
  },

  setGameCategories(p: Prefs, gameId: string, categoryIds: string[]): Prefs {
    const valid = new Set(p.categories.filter((c) => c.kind === 'custom').map((c) => c.id))
    const ids = [...new Set(categoryIds.filter((x) => valid.has(x)))]
    const gameCategories = { ...p.gameCategories }
    if (ids.length) gameCategories[gameId] = ids
    else delete gameCategories[gameId]
    return { ...p, gameCategories }
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
