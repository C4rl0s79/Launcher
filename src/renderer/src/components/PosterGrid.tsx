import { useEffect, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Game } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { currentFocus } from '../nav/engine'
import { Poster } from './Poster'

// Steam-style poster grid. Column count follows the available width so posters keep a
// comfortable size from a laptop screen up to a 4K TV.

export const GRID_GAP = 22
const MIN_W = 150

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(1200)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e.contentRect.width > 0 && setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

export function columnsFor(width: number): { cols: number; itemW: number } {
  const cols = Math.max(2, Math.floor((width + GRID_GAP) / (Math.max(MIN_W, width / 9) + GRID_GAP)))
  return { cols, itemW: (width - GRID_GAP * (cols - 1)) / cols }
}

interface GridProps {
  games: Game[]
  favs: Set<string>
  onOpen: (g: Game) => void
  navGroup: string
  autofocusFirst?: boolean
}

/** Virtualised grid for whole groups (thousands of games). */
export function VirtualPosterGrid({ games, favs, onOpen, navGroup, autofocusFirst = true }: GridProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { cols, itemW } = columnsFor(useWidth(ref))
  const rowH = itemW * 1.5 + 40 + GRID_GAP
  const v = useVirtualizer({
    count: Math.ceil(games.length / cols),
    getScrollElement: () => ref.current,
    estimateSize: () => rowH,
    overscan: 3
  })
  useEffect(() => v.measure(), [rowH, v])

  return (
    <div className="grid" ref={ref} data-nav-group={navGroup}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((r) => (
          <div
            key={r.key}
            className="grid__row"
            style={{ transform: `translateY(${r.start}px)`, gridTemplateColumns: `repeat(${cols}, ${itemW}px)`, gap: GRID_GAP }}
          >
            {games.slice(r.index * cols, r.index * cols + cols).map((g, i) => (
              <Poster key={g.id} game={g} favorite={favs.has(g.id)} onOpen={onOpen} autofocus={autofocusFirst && r.index === 0 && i === 0} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Small grid limited to a number of full rows (home screen sections). */
export function PosterGridRows({
  games,
  favs,
  onOpen,
  navGroup,
  rows,
  autofocusFirst,
  onFocusGame
}: GridProps & { rows: number; onFocusGame?: (g: Game) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const { cols, itemW } = columnsFor(useWidth(ref))
  return (
    <div
      className="grid-static"
      ref={ref}
      data-nav-group={navGroup}
      style={{ gridTemplateColumns: `repeat(${cols}, ${itemW}px)`, gap: GRID_GAP }}
    >
      {games.slice(0, cols * rows).map((g, i) => (
        <Poster key={g.id} game={g} favorite={favs.has(g.id)} onOpen={onOpen} onFocusGame={onFocusGame} autofocus={autofocusFirst && i === 0} />
      ))}
    </div>
  )
}

/** X / F on a focused poster toggles favourite. Returns false when focus is not on a game. */
export function toggleFavoriteOfFocused(): boolean {
  const id = currentFocus()?.dataset.key
  const games = useStore.getState().snapshot?.games ?? []
  if (!id || !games.some((g) => g.id === id)) return false
  void attempt(api().prefs.toggleFavorite(id)).then(
    (p) => p && useStore.getState().toast(p.favorites.includes(id) ? 'Dodano do ulubionych' : 'Usunięto z ulubionych')
  )
  return true
}
