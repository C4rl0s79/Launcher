import { useEffect, useMemo, useRef, useState } from 'react'
import type { Category, Game } from '@shared/types'
import { gamesForCategory, useStore } from '../store'
import { useActions } from '../nav/input'
import { focusEl, focusFirst } from '../nav/engine'
import { TextField } from '../components/TextField'
import { LibraryNotice } from '../components/LibraryNotice'
import { toggleFavoriteOfFocused, VirtualPosterGrid } from '../components/PosterGrid'
import { gameCountLabel } from '../lib/format'

// One group (tab in the top bar): every game of the category as a Steam-style poster grid.

type Filter = 'all' | 'installed' | 'notInstalled'
type Sort = 'name' | 'recent' | 'added' | 'playtime'

const FILTERS: [Filter, string][] = [
  ['all', 'Wszystkie'],
  ['installed', 'Zainstalowane'],
  ['notInstalled', 'Niezainstalowane']
]
const SORTS: [Sort, string][] = [
  ['name', 'Nazwa'],
  ['recent', 'Ostatnio grane'],
  ['added', 'Nowo dodane'],
  ['playtime', 'Czas gry']
]

const viewKey = (catId: string): string => `lumen.group.${catId}`

function loadView(catId: string): { filter: Filter; sort: Sort } {
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(catId)) ?? '{}')
    return { filter: v.filter ?? 'all', sort: v.sort ?? 'name' }
  } catch {
    return { filter: 'all', sort: 'name' }
  }
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')

export function GroupScreen({ category, active }: { category: Category; active: boolean }) {
  const snapshot = useStore((s) => s.snapshot)!
  const prefs = useStore((s) => s.prefs)!
  const openDetails = useStore((s) => s.openDetails)
  const initial = useMemo(() => loadView(category.id), [category.id])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>(initial.filter)
  const [sort, setSort] = useState<Sort>(initial.sort)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(viewKey(category.id), JSON.stringify({ filter, sort }))
    } catch {
      /* ignore */
    }
  }, [category.id, filter, sort])

  const all = useMemo(() => gamesForCategory(category, snapshot.games, prefs, snapshot.collections), [category, snapshot, prefs])
  // emulator shortcuts are always installed — the install filter only matters when Steam games are in the group
  const hasInstallState = all.some((g) => g.source !== 'shortcut')
  const effectiveFilter: Filter = hasInstallState ? filter : 'all'
  const has = {
    recent: all.some((g) => g.lastPlayed),
    added: all.some((g) => g.addedAt),
    playtime: all.some((g) => g.playtimeMinutes !== undefined)
  }

  const games = useMemo(() => {
    let list = all
    if (effectiveFilter === 'installed') list = list.filter((g) => g.installed)
    if (effectiveFilter === 'notInstalled') list = list.filter((g) => !g.installed)
    const q = norm(query.trim())
    if (q) list = list.filter((g) => norm(g.name).includes(q))
    const byName = (a: Game, b: Game): number => a.sortName.localeCompare(b.sortName, 'pl')
    const sorted = [...list]
    if (sort === 'name') sorted.sort(byName)
    if (sort === 'recent') sorted.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || byName(a, b))
    if (sort === 'added') sorted.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || byName(a, b))
    if (sort === 'playtime') sorted.sort((a, b) => (b.playtimeMinutes ?? -1) - (a.playtimeMinutes ?? -1) || byName(a, b))
    return sorted
  }, [all, effectiveFilter, query, sort])

  const favs = useMemo(() => new Set(prefs.favorites), [prefs.favorites])

  useActions(
    {
      y: () => {
        searchRef.current && focusEl(searchRef.current)
        return true
      },
      view: () => {
        if (!hasInstallState) return true
        const i = FILTERS.findIndex(([f]) => f === filter)
        setFilter(FILTERS[(i + 1) % FILTERS.length][0])
        return true
      },
      x: toggleFavoriteOfFocused,
      back: () => {
        if (query) {
          setQuery('')
          return true
        }
        useStore.getState().setTab('home')
        return true
      }
    },
    {
      enabled: active,
      hints: [
        { action: 'confirm', label: 'Otwórz' },
        { action: 'x', label: 'Ulubiona' },
        { action: 'y', label: 'Szukaj' },
        ...(hasInstallState ? [{ action: 'view' as const, label: 'Filtr' }] : []),
        { action: 'lb', label: 'Poprzednia grupa' },
        { action: 'rb', label: 'Następna' },
        { action: 'back', label: query ? 'Wyczyść' : 'Start' }
      ]
    }
  )

  const nextSort = (): void => {
    const avail = SORTS.filter(([s]) => s === 'name' || has[s as keyof typeof has])
    const i = avail.findIndex(([s]) => s === sort)
    setSort(avail[(i + 1) % avail.length][0])
  }

  return (
    <div className="group">
      <header className="group__head">
        <h1>{category.name}</h1>
        <span className="group__count">{gameCountLabel(games.length)}</span>
        {category.kind === 'steam' && <span className="pill">kolekcja Steam</span>}
        {(category.smart === 'all' || category.smart === 'installed' || category.smart === 'notInstalled') && (
          <span className="pill">tylko gry Steam</span>
        )}
      </header>
      <div className="toolbar" data-nav-group={`toolbar-${category.id}`}>
        <div className="toolbar__search">
          <span className="toolbar__icon" aria-hidden>
            ⌕
          </span>
          <TextField
            inputRef={searchRef}
            navKey="search"
            label={`Szukaj w grupie ${category.name}`}
            placeholder="Szukaj po nazwie…"
            value={query}
            onChange={setQuery}
            onSubmit={() => {
              const grid = searchRef.current?.closest('.group')?.querySelector<HTMLElement>('.grid')
              if (grid) focusFirst(grid)
            }}
          />
        </div>
        {hasInstallState && (
        <div className="segmented" role="group" aria-label="Status instalacji">
          {FILTERS.map(([f, label]) => (
            <button key={f} data-nav data-key={`filter-${f}`} className={`seg ${filter === f ? 'is-on' : ''}`} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        )}
        <button className="btn btn--ghost" data-nav data-key="sort" onClick={nextSort}>
          Sortuj: <strong>{SORTS.find(([s]) => s === sort)![1]}</strong>
        </button>
      </div>
      {category.smart === 'all' && <LibraryNotice />}
      {games.length ? (
        <VirtualPosterGrid games={games} favs={favs} onOpen={(g) => openDetails(g.id)} navGroup={`grid-${category.id}`} />
      ) : (
        <div className="empty empty--inline">
          <h2>{all.length ? 'Brak wyników' : 'Pusta grupa'}</h2>
          <p>
            {query
              ? `Żadna gra nie pasuje do „${query}”.`
              : all.length
                ? 'Żadna gra nie spełnia wybranych filtrów.'
                : category.kind === 'custom'
                  ? 'Przypisz gry w ekranie gry → „Kategorie”.'
                  : category.smart === 'favorites'
                    ? 'Naciśnij X (lub F) na plakacie, aby dodać grę do ulubionych.'
                    : 'Brak gier w tej grupie.'}
          </p>
        </div>
      )}
    </div>
  )
}
