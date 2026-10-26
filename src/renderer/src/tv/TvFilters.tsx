import { useEffect, useRef, useState } from 'react'
import type { Game } from '@shared/types'
import { askText, useStore } from '../store'
import { focusEl, focusFirst } from '../nav/engine'
import { plural } from '../lib/format'
import { Modal } from '../components/Modal'
import { FILTER_DEFAULT, PLAYERS, SORT, activeParts, countWith, matches, showLabels, valuesOf, type Filter, type FilterKey } from './filters'

// Game list filters (X on the TV game list) — EmuStart's filter window: search, genre, decade,
// players, region, developer, what to show, order; "Pokaż gry" closes with the result.

type Page = 'main' | FilterKey | 'players' | 'show' | 'sort'

const TITLES: Record<Page, string> = {
  main: 'Filtry',
  genre: 'Gatunek',
  decade: 'Dekada',
  players: 'Gracze',
  region: 'Region',
  dev: 'Producent',
  show: 'Pokaż',
  sort: 'Sortuj'
}
/** Steam games carry no EmuStart metadata — these filters (and sorting by year) are EmuStart's only */
const META = ['genre', 'decade', 'players', 'region', 'dev']

/** sort options that have data in this list: year and LaunchBox for EmuStart games, critics and players for Steam games */
function sortFits(v: Filter['sort'], steam: boolean, games: Game[]): boolean {
  if (v === 'year' || v === 'launchbox') return !steam
  if (v === 'critic' || v === 'players') return games.some((g) => !g.emu)
  return true
}

export function TvFilters({
  system,
  games,
  steam,
  filter,
  onChange,
  onClose
}: {
  system: string
  games: Game[]
  steam: boolean
  filter: Filter
  onChange: (f: Filter) => void
  onClose: () => void
}) {
  const favorites = useStore((s) => s.prefs?.favorites)
  const fav = (id: string): boolean => !!favorites?.includes(id)
  const [page, setPage] = useState<Page>('main')
  const [back, setBack] = useState('q') // the main row to return to
  const listRef = useRef<HTMLDivElement>(null)
  const f = filter
  useEffect(() => {
    const t = setTimeout(() => {
      const el = listRef.current
      if (!el) return
      const row = page === 'main' ? el.querySelector<HTMLElement>(`[data-row="${back}"]`) : null
      if (row) focusEl(row, false)
      else focusFirst(el)
    }, 0)
    return () => clearTimeout(t)
  }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Filter>(key: K, val: Filter[K]): void => {
    onChange({ ...f, [key]: val })
    setBack(key)
    setPage('main')
  }
  const open = (p: Page): void => {
    setBack(p)
    setPage(p)
  }

  type Row = { id?: string; label: string; value?: string; act: () => void }
  const shown = games.filter((g) => matches(g, f, fav)).length
  const SHOW = showLabels(steam)
  const any = {
    genre: 'wszystkie gatunki',
    decade: 'wszystkie dekady',
    region: 'wszystkie regiony',
    dev: 'wszyscy producenci'
  }
  const rows: Row[] =
    page === 'main'
      ? [
          {
            id: 'q',
            label: 'Szukaj w tytule',
            value: f.q || '—',
            act: async () => {
              const v = await askText('Szukaj w tytule', { initial: f.q })
              if (v !== null) set('q', v.trim())
            }
          },
          {
            id: 'genre',
            label: 'Gatunek',
            value: f.genre || 'wszystkie',
            act: () => open('genre')
          },
          {
            id: 'decade',
            label: 'Dekada',
            value: f.decade ? `${f.decade}s` : 'wszystkie',
            act: () => open('decade')
          },
          {
            id: 'players',
            label: 'Gracze',
            value: PLAYERS[f.players],
            act: () => open('players')
          },
          {
            id: 'region',
            label: 'Region',
            value: f.region || 'wszystkie',
            act: () => open('region')
          },
          {
            id: 'dev',
            label: 'Producent',
            value: f.dev || 'wszyscy',
            act: () => open('dev')
          },
          {
            id: 'show',
            label: 'Pokaż',
            value: SHOW[f.show],
            act: () => open('show')
          },
          {
            id: 'sort',
            label: 'Sortuj',
            value: SORT[f.sort],
            act: () => open('sort')
          },
          ...(activeParts(f, steam).length || f.sort !== 'title'
            ? [
                {
                  label: 'Wyczyść filtry',
                  act: () => {
                    onChange({ ...FILTER_DEFAULT })
                    // the row disappears with the filters: back to the first one
                    setTimeout(() => focusFirst(listRef.current ?? undefined), 0)
                  }
                }
              ]
            : []),
          { label: 'Pokaż gry', value: String(shown), act: onClose }
        ].filter((r) => !(steam && META.includes(r.id ?? '')))
      : page === 'players'
        ? Object.entries(PLAYERS).map(([v, label]) => ({
            label,
            value: `${countWith(games, f, 'players', Number(v), fav)}${f.players === Number(v) ? '  ✓' : ''}`,
            act: () => set('players', Number(v))
          }))
        : page === 'show'
          ? (Object.keys(SHOW) as Filter['show'][])
              .filter((v) => !(steam && v === 'pinned'))
              .map((v) => ({
                label: SHOW[v],
                value: `${countWith(games, f, 'show', v, fav)}${f.show === v ? '  ✓' : ''}`,
                act: () => set('show', v)
              }))
          : page === 'sort'
            ? (Object.keys(SORT) as Filter['sort'][])
                .filter((v) => sortFits(v, steam, games))
                .map((v) => ({
                  label: SORT[v],
                  value: f.sort === v ? '✓' : '',
                  act: () => set('sort', v)
                }))
            : [
                {
                  label: any[page],
                  value: `${countWith(games, f, page, '', fav)}${f[page] ? '' : '  ✓'}`,
                  act: () => set(page, '')
                },
                ...valuesOf(games, f, page, fav).map(([v, n]) => ({
                  label: page === 'decade' ? `${v}s` : v,
                  value: `${n}${f[page] === v ? '  ✓' : ''}`,
                  act: () => set(page, v)
                }))
              ]

  return (
    <Modal
      title={`${TITLES[page]} — ${system}`}
      onClose={onClose}
      wide
      className="gopt"
      handlers={{
        back: () => (page === 'main' ? onClose() : setPage('main'), true),
        x: () => (onClose(), true)
      }}
      hints={
        page === 'main'
          ? [
              { action: 'confirm', label: 'Wybierz' },
              { action: 'x', label: 'Pokaż gry' },
              { action: 'back', label: 'Zamknij' }
            ]
          : [
              { action: 'confirm', label: 'Wybierz' },
              { action: 'back', label: 'Wstecz' }
            ]
      }
    >
      {page === 'main' && (
        <p className="details__muted">
          {shown} z {games.length} {plural(games.length, 'gry', 'gier', 'gier')}
          {!steam && !games.some((g) => g.emu?.genre) ? ' · brak metadanych dla tego systemu' : ''}
        </p>
      )}
      <div className="gopt__list" ref={listRef} key={page}>
        {rows.map((r, i) => (
          <button key={r.label + i} className="gopt__row" data-nav data-row={r.id} onClick={r.act}>
            <span className="gopt__label">{r.label}</span>
            {r.value && <span className="gopt__value">{r.value}</span>}
          </button>
        ))}
      </div>
    </Modal>
  )
}
