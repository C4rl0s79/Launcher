import { describe, expect, it } from 'vitest'
import { STEAM, systemMeta, type TvSystem } from '../src/renderer/src/tv/data'

const sys = (o: Partial<TvSystem>): TvSystem => ({ key: '3do', display: '3DO', games: [], ready: 0, logo: true, ...o })
const games = (n: number) => Array.from({ length: n }, () => ({}) as TvSystem['games'][number])

describe('TV layout: system line under the carousel (EmuStart wording)', () => {
  it('counts games, downloaded ones and the emulator', () => {
    expect(systemMeta(sys({ games: games(1), emulator: 'RetroArch: Opera' }))).toBe('1 gra · RetroArch: Opera')
    expect(systemMeta(sys({ games: games(3), ready: 2, emulator: 'RetroArch: Opera' }))).toBe('3 gry · 2 w pamięci podręcznej · RetroArch: Opera')
    expect(systemMeta(sys({ games: games(5) }))).toBe('5 gier · brak emulatora')
  })

  it('Steam: installed games and the Steam client', () => {
    expect(systemMeta(sys({ key: STEAM, display: 'Steam', games: games(66), ready: 66, logo: false }))).toBe('66 gier · 66 zainstalowanych · klient Steam')
  })
})

import type { Game } from '../src/shared/types'
import { FILTER_DEFAULT, activeParts, apply, countWith, matches, regionsOf, valuesOf } from '../src/renderer/src/tv/filters'

const emuGame = (id: string, name: string, o: Partial<NonNullable<Game['emu']>> = {}, g: Partial<Game> = {}): Game =>
  ({
    id,
    name,
    source: 'emustart',
    installed: false,
    emu: { id: 1, sid: id, es: 'snes', system: 'SNES', tags: '(USA)', size: 1, cached: false, pinned: false, copying: false, discs: 1, ...o },
    ...g
  }) as Game

describe('TV layout: game list filters (EmuStart rules)', () => {
  const games = [
    emuGame('a', 'Chrono Trigger', { genre: 'RPG', year: '1995', players: '1', developer: 'Square', tags: '(USA)', cached: true }, { lastPlayed: 100, playtimeMinutes: 60 }),
    emuGame('b', 'Secret of Mana', { genre: 'RPG, Action', year: '1993', players: '3', developer: 'Square, Nintendo', tags: '(Europe)' }),
    emuGame('c', 'Super Mario World', { genre: 'Platform', year: '1990', players: '2', developer: 'Nintendo', tags: '(USA, Europe)', size: 9 })
  ]
  const fav = (id: string): boolean => id === 'c'

  it('filters by search, genre, decade, players, region, developer and what to show', () => {
    const f = { ...FILTER_DEFAULT }
    expect(apply(games, { ...f, q: 'mana' }, fav).map((g) => g.id)).toEqual(['b'])
    expect(apply(games, { ...f, genre: 'RPG' }, fav).map((g) => g.id)).toEqual(['a', 'b'])
    expect(apply(games, { ...f, decade: '1990' }, fav).map((g) => g.id)).toEqual(['a', 'b', 'c'])
    expect(apply(games, { ...f, players: 2 }, fav).map((g) => g.id)).toEqual(['b', 'c'])
    expect(apply(games, { ...f, region: 'Europe' }, fav).map((g) => g.id)).toEqual(['b', 'c'])
    expect(apply(games, { ...f, dev: 'Square' }, fav).map((g) => g.id)).toEqual(['a', 'b']) // first developer
    expect(apply(games, { ...f, show: 'local' }, fav).map((g) => g.id)).toEqual(['a'])
    expect(apply(games, { ...f, show: 'fav' }, fav).map((g) => g.id)).toEqual(['c'])
    expect(apply(games, { ...f, show: 'unplayed' }, fav).map((g) => g.id)).toEqual(['b', 'c'])
  })

  it('sorts and counts like EmuStart', () => {
    expect(apply(games, { ...FILTER_DEFAULT, sort: 'year' }, fav).map((g) => g.id)).toEqual(['c', 'b', 'a'])
    expect(apply(games, { ...FILTER_DEFAULT, sort: 'size' }, fav)[0].id).toBe('c')
    expect(countWith(games, { ...FILTER_DEFAULT, genre: 'RPG' }, 'region', 'Europe', fav)).toBe(1)
    expect(valuesOf(games, FILTER_DEFAULT, 'genre', fav)).toEqual([['RPG', 2], ['Action', 1], ['Platform', 1]])
    expect(valuesOf(games, { ...FILTER_DEFAULT, genre: 'RPG' }, 'genre', fav)[0]).toEqual(['RPG', 2]) // own field ignored
  })

  it('reads regions from the name and describes active filters', () => {
    expect(regionsOf(games[2])).toEqual(['USA', 'Europe'])
    expect(regionsOf(emuGame('x', 'X', { tags: '(Rev 1)' }))).toEqual([])
    expect(activeParts({ ...FILTER_DEFAULT, q: 'mario', decade: '1990', show: 'local' }, true)).toEqual(['„mario”', '1990s', 'tylko zainstalowane'])
    expect(matches({ id: 's', name: 'Portal', source: 'steam', installed: true } as Game, { ...FILTER_DEFAULT, show: 'local' }, fav)).toBe(true)
  })
})
