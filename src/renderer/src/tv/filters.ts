import type { Game, GameRatings } from '@shared/types'

// Game list filters of the TV layout — EmuStart's filters (engine/web/options.js: FL) for Lumen's
// games: search in the title, genre, decade, players, region, developer, what to show and the
// order. Kept per system (like EmuStart). Pure functions — tested in tests/tv.test.ts.

export interface Filter {
  q: string
  genre: string
  decade: string
  players: number
  region: string
  dev: string
  show: 'all' | 'local' | 'pinned' | 'fav' | 'played' | 'unplayed'
  sort: 'title' | 'year' | 'last' | 'time' | 'size' | RatingSort
}

/** sorting by a rating: LaunchBox community, critics (Metacritic), players (Steam reviews) */
export type RatingSort = 'launchbox' | 'critic' | 'players'
export const RATING_SORTS: readonly RatingSort[] = ['launchbox', 'critic', 'players']
export const isRatingSort = (s: Filter['sort']): s is RatingSort => (RATING_SORTS as readonly string[]).includes(s)

export const FILTER_DEFAULT: Filter = { q: '', genre: '', decade: '', players: 0, region: '', dev: '', show: 'all', sort: 'title' }

export const SORT: Record<Filter['sort'], string> = {
  title: 'tytuł',
  year: 'rok premiery',
  last: 'ostatnio grane',
  time: 'czas gry',
  size: 'rozmiar',
  launchbox: 'ocena LaunchBox',
  critic: 'ocena krytyków (Metacritic)',
  players: 'ocena graczy (recenzje Steam)'
}
export const PLAYERS: Record<number, string> = { 0: 'dowolna', 1: '1 gracz', 2: '2 i więcej', 3: '3 i więcej', 4: '4 i więcej' }
/** "local": EmuStart — in the game cache, Steam — installed */
export function showLabels(steam: boolean): Record<Filter['show'], string> {
  return {
    all: 'wszystkie',
    local: steam ? 'tylko zainstalowane' : 'tylko lokalne (w cache)',
    pinned: 'tylko zachowane na dysku',
    fav: 'tylko ulubione',
    played: 'grane',
    unplayed: 'niegrane'
  }
}

export type FilterKey = 'genre' | 'decade' | 'region' | 'dev'

const decadeOf = (y?: string): string => (/^\d{4}/.test(y ?? '') ? y!.slice(0, 3) + '0' : '')
const devOf = (g: Game): string => (g.emu?.developer ?? '').split(/,\s*/)[0] ?? ''
const genresOf = (g: Game): string[] => (g.emu?.genre ?? '').split(/,\s*/).filter(Boolean)
const playersOf = (g: Game): number => parseInt(g.emu?.players ?? '', 10) || 0

/** Regions of a No-Intro / Redump name: "(USA, Europe)" → USA, Europe */
export function regionsOf(g: Game): string[] {
  const tags = g.emu?.tags ?? ''
  const first = /\(([^)]+)\)/.exec(tags)?.[1] ?? ''
  const known = /^(USA|Europe|Japan|World|Asia|Korea|China|Taiwan|Australia|Brazil|Canada|France|Germany|Italy|Spain|Netherlands|Sweden|Scandinavia|UK|Poland|Russia)$/i
  return first
    .split(/,\s*/)
    .map((x) => x.trim())
    .filter((x) => known.test(x))
}

export function matches(g: Game, f: Filter, fav: (id: string) => boolean, skip?: keyof Filter): boolean {
  if (skip !== 'q' && f.q && !`${g.name} ${g.emu?.tags ?? ''}`.toLowerCase().includes(f.q.toLowerCase())) return false
  if (skip !== 'genre' && f.genre && !genresOf(g).includes(f.genre)) return false
  if (skip !== 'decade' && f.decade && decadeOf(g.emu?.year) !== f.decade) return false
  if (skip !== 'players' && f.players && playersOf(g) < f.players) return false
  if (skip !== 'region' && f.region && !regionsOf(g).includes(f.region)) return false
  if (skip !== 'dev' && f.dev && devOf(g) !== f.dev) return false
  if (skip !== 'show') {
    const local = g.emu ? g.emu.cached : g.installed
    if (f.show === 'local' && !local) return false
    if (f.show === 'pinned' && !g.emu?.pinned) return false
    if (f.show === 'fav' && !fav(g.id)) return false
    if (f.show === 'played' && !g.lastPlayed) return false
    if (f.show === 'unplayed' && g.lastPlayed) return false
  }
  return true
}

/** Filtered and sorted games (title order is the list's own). Rating sorts: highest first, games without one last. */
export function apply(all: Game[], f: Filter, fav: (id: string) => boolean, ratings: Record<string, GameRatings> = {}): Game[] {
  const out = all.filter((g) => matches(g, f, fav))
  const size = (g: Game): number => g.emu?.size ?? g.sizeOnDisk ?? 0
  const by: Partial<Record<Filter['sort'], (a: Game, b: Game) => number>> = {
    year: (a, b) => (a.emu?.year || '9999').localeCompare(b.emu?.year || '9999') || a.name.localeCompare(b.name),
    last: (a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0),
    time: (a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0),
    size: (a, b) => size(b) - size(a)
  }
  if (isRatingSort(f.sort)) {
    const key = f.sort
    const r = (g: Game): number => ratings[g.id]?.[key] ?? -1
    by[key] = (a, b) => r(b) - r(a) || a.name.localeCompare(b.name)
  }
  const cmp = by[f.sort]
  return cmp ? out.sort(cmp) : out
}

/** How many games remain with `key` set to `val` (the other filters kept). */
export function countWith<K extends keyof Filter>(all: Game[], f: Filter, key: K, val: Filter[K], fav: (id: string) => boolean): number {
  const g = { ...f, [key]: val }
  return all.filter((x) => matches(x, g, fav)).length
}

/** Values of a field among the games the other filters leave, most frequent first (decades in order). */
export function valuesOf(all: Game[], f: Filter, key: FilterKey, fav: (id: string) => boolean): [string, number][] {
  const counts = new Map<string, number>()
  for (const g of all) {
    if (!matches(g, f, fav, key)) continue
    const vals = key === 'genre' ? genresOf(g) : key === 'decade' ? [decadeOf(g.emu?.year)] : key === 'region' ? regionsOf(g) : [devOf(g)]
    for (const v of new Set(vals.filter(Boolean))) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const arr = [...counts.entries()]
  arr.sort(key === 'decade' ? (a, b) => a[0].localeCompare(b[0]) : (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return arr
}

/** Active filters in words (shown above the list): „mario”, Platformówka, 1990s… */
export function activeParts(f: Filter, steam: boolean): string[] {
  const out: string[] = []
  if (f.q) out.push(`„${f.q}”`)
  if (f.genre) out.push(f.genre)
  if (f.decade) out.push(`${f.decade}s`)
  if (f.players) out.push(PLAYERS[f.players])
  if (f.region) out.push(f.region)
  if (f.dev) out.push(f.dev)
  if (f.show !== 'all') out.push(showLabels(steam)[f.show])
  return out
}

const KEY = (sys: string): string => `lumen.filter.${sys}`
export function loadFilter(sys: string): Filter {
  try {
    return { ...FILTER_DEFAULT, ...(JSON.parse(localStorage.getItem(KEY(sys)) ?? '{}') as Partial<Filter>) }
  } catch {
    return { ...FILTER_DEFAULT }
  }
}
export function saveFilter(sys: string, f: Filter): void {
  try {
    localStorage.setItem(KEY(sys), JSON.stringify(f))
  } catch {
    /* no browser storage — the filter lasts until the program closes */
  }
}
