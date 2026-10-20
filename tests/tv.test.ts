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
