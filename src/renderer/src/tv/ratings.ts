import { useEffect, useState } from 'react'
import type { Game, GameRatings } from '@shared/types'
import { api } from '../store'
import { isRatingSort, type Filter } from './filters'

// Ratings of a whole list, only while it is sorted by one (filters.ts). Steam games not looked up in
// the store yet are fetched by the main process in the background — asked again until none is missing.

export function useRatings(games: Game[], sort: Filter['sort']): Record<string, GameRatings> {
  const [ratings, setRatings] = useState<Record<string, GameRatings>>({})
  const wanted = isRatingSort(sort)
  useEffect(() => {
    if (!wanted || !games.length) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ids = games.map((g) => g.id)
    const ask = (): void => {
      void api()
        .library.ratings(ids)
        .then((r) => {
          if (!alive) return
          setRatings(r.ratings)
          if (r.missing) timer = setTimeout(ask, 20_000)
        })
        .catch(() => undefined)
    }
    ask()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [wanted, games])
  return wanted ? ratings : {}
}
