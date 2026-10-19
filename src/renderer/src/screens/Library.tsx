import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Game } from '@shared/types'
import { api, attempt, gamesForCategory, sortedCategories, useStore } from '../store'
import { useActions } from '../nav/input'
import { currentFocus, focusEl, focusFirst } from '../nav/engine'
import { Poster } from '../components/Poster'
import { TextField } from '../components/TextField'
import { LibraryNotice } from '../components/LibraryNotice'
import { Modal } from '../components/Modal'
import { gameCountLabel } from '../lib/format'

type Filter = 'all' | 'installed' | 'notInstalled'
type Sort = 'name' | 'recent' | 'playtime'

const FILTERS: [Filter, string][] = [
  ['all', 'Wszystkie'],
  ['installed', 'Zainstalowane'],
  ['notInstalled', 'Niezainstalowane']
]
const SORTS: [Sort, string][] = [
  ['name', 'Nazwa'],
  ['recent', 'Ostatnio grane'],
  ['playtime', 'Czas gry']
]

function loadView(): { filter: Filter; sort: Sort; category: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem('lumen.libraryView') ?? '{}')
    return { filter: v.filter ?? 'all', sort: v.sort ?? 'name', category: v.category ?? null }
  } catch {
    return { filter: 'all', sort: 'name', category: null }
  }
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')

export function LibraryScreen({ active }: { active: boolean }) {
  const snapshot = useStore((s) => s.snapshot)!
  const prefs = useStore((s) => s.prefs)!
  const openDetails = useStore((s) => s.openDetails)
  const [query, setQuery] = useState('')
  const initial = useMemo(loadView, [])
  const [filter, setFilter] = useState<Filter>(initial.filter)
  const [sort, setSort] = useState<Sort>(initial.sort)
  const [category, setCategory] = useState<string | null>(initial.category)
  const [pickCat, setPickCat] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const request = useStore((s) => s.libraryRequest)

  useEffect(() => {
    if (!request) return
    setCategory(request.category)
    setFilter('all')
    setQuery('')
  }, [request])

  useEffect(() => {
    try {
      localStorage.setItem('lumen.libraryView', JSON.stringify({ filter, sort, category }))
    } catch {
      /* ignore */
    }
  }, [filter, sort, category])

  const cats = sortedCategories(prefs)
  const cat = cats.find((c) => c.id === category) ?? null
  const hasPlaytime = snapshot.games.some((g) => g.playtimeMinutes !== undefined)
  const hasRecent = snapshot.games.some((g) => g.lastPlayed)

  const games = useMemo(() => {
    let list = cat ? gamesForCategory(cat, snapshot.games, prefs, snapshot.collections) : snapshot.games
    if (filter === 'installed') list = list.filter((g) => g.installed)
    if (filter === 'notInstalled') list = list.filter((g) => !g.installed)
    const q = norm(query.trim())
    if (q) list = list.filter((g) => norm(g.name).includes(q))
    const byName = (a: Game, b: Game): number => a.sortName.localeCompare(b.sortName, 'pl')
    const sorted = [...list]
    if (sort === 'name') sorted.sort(byName)
    if (sort === 'recent') sorted.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || byName(a, b))
    if (sort === 'playtime') sorted.sort((a, b) => (b.playtimeMinutes ?? -1) - (a.playtimeMinutes ?? -1) || byName(a, b))
    return sorted
  }, [snapshot.games, prefs, cat, filter, query, sort])

  const favs = useMemo(() => new Set(prefs.favorites), [prefs.favorites])

  useActions(
    {
      y: () => {
        searchRef.current && focusEl(searchRef.current)
        return true
      },
      view: () => {
        const i = FILTERS.findIndex(([f]) => f === filter)
        setFilter(FILTERS[(i + 1) % FILTERS.length][0])
        return true
      },
      x: () => {
        const id = currentFocus()?.dataset.key
        if (!id || !snapshot.games.some((g) => g.id === id)) return false
        void attempt(api().prefs.toggleFavorite(id)).then((p) =>
          p && useStore.getState().toast(p.favorites.includes(id) ? 'Dodano do ulubionych' : 'Usunięto z ulubionych')
        )
        return true
      },
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
        { action: 'view', label: 'Filtr' },
        { action: 'back', label: query ? 'Wyczyść' : 'Start' }
      ]
    }
  )

  return (
    <div className="library">
      <div className="toolbar" data-nav-group="library-toolbar">
        <div className="toolbar__search">
          <span className="toolbar__icon" aria-hidden>
            ⌕
          </span>
          <TextField
            inputRef={searchRef}
            navKey="search"
            label="Szukaj gry"
            placeholder="Szukaj po nazwie…"
            value={query}
            onChange={setQuery}
            onSubmit={() => {
              const grid = document.querySelector<HTMLElement>('.grid')
              if (grid) focusFirst(grid)
            }}
          />
        </div>
        <div className="segmented" role="group" aria-label="Status instalacji">
          {FILTERS.map(([f, label]) => (
            <button key={f} data-nav data-key={`filter-${f}`} className={`seg ${filter === f ? 'is-on' : ''}`} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn btn--ghost" data-nav data-key="category" onClick={() => setPickCat(true)}>
          Kategoria: <strong>{cat ? cat.name : 'Wszystkie'}</strong>
        </button>
        <button
          className="btn btn--ghost"
          data-nav
          data-key="sort"
          onClick={() => {
            const avail = SORTS.filter(([s]) => s === 'name' || (s === 'recent' ? hasRecent : hasPlaytime))
            const i = avail.findIndex(([s]) => s === sort)
            setSort(avail[(i + 1) % avail.length][0])
          }}
        >
          Sortuj: <strong>{SORTS.find(([s]) => s === sort)![1]}</strong>
        </button>
        <span className="toolbar__count">{gameCountLabel(games.length)}</span>
      </div>
      <LibraryNotice />
      {games.length ? (
        <Grid games={games} favs={favs} onOpen={(g) => openDetails(g.id)} />
      ) : (
        <div className="empty empty--inline">
          <h2>Brak wyników</h2>
          <p>{query ? `Żadna gra nie pasuje do „${query}”.` : 'Żadna gra nie spełnia wybranych filtrów.'}</p>
        </div>
      )}
      {pickCat && (
        <Modal title="Pokaż kategorię" onClose={() => setPickCat(false)}>
          <div className="list">
            <button
              className={`list__item ${!cat ? 'is-on' : ''}`}
              data-nav
              data-autofocus={!cat || undefined}
              onClick={() => {
                setCategory(null)
                setPickCat(false)
              }}
            >
              Wszystkie gry
            </button>
            {cats
              .filter((c) => c.smart !== 'all')
              .map((c) => (
                <button
                  key={c.id}
                  className={`list__item ${cat?.id === c.id ? 'is-on' : ''}`}
                  data-nav
                  data-autofocus={cat?.id === c.id || undefined}
                  onClick={() => {
                    setCategory(c.id)
                    setPickCat(false)
                  }}
                >
                  {c.name}
                  <span className="list__meta">{gameCountLabel(gamesForCategory(c, snapshot.games, prefs, snapshot.collections).length)}</span>
                </button>
              ))}
          </div>
        </Modal>
      )}
    </div>
  )
}

const GAP = 22
const MIN_W = 150

function Grid({ games, favs, onOpen }: { games: Game[]; favs: Set<string>; onOpen: (g: Game) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1200)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e.contentRect.width > 0 && setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = Math.max(2, Math.floor((width + GAP) / (Math.max(MIN_W, width / 9) + GAP)))
  const itemW = (width - GAP * (cols - 1)) / cols
  const rowH = itemW * 1.5 + 44 + GAP
  const rows = Math.ceil(games.length / cols)

  const v = useVirtualizer({
    count: rows,
    getScrollElement: () => ref.current,
    estimateSize: () => rowH,
    overscan: 3
  })
  useEffect(() => v.measure(), [rowH, v])

  return (
    <div className="grid" ref={ref} data-nav-group="library-grid">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((r) => (
          <div
            key={r.key}
            className="grid__row"
            style={{ transform: `translateY(${r.start}px)`, gridTemplateColumns: `repeat(${cols}, ${itemW}px)`, gap: GAP }}
          >
            {games.slice(r.index * cols, r.index * cols + cols).map((g, i) => (
              <Poster key={g.id} game={g} favorite={favs.has(g.id)} onOpen={onOpen} autofocus={r.index === 0 && i === 0} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
