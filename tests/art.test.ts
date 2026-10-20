import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ArtKind, ArtOption, GameArtPrefs, SgdbGame } from '@shared/types'
import { ArtworkService } from '../src/main/art/artwork'
import { pickBestMatch, pickExactMatch, queryFor, toOptions, SgdbAuthError, type SgdbClient } from '../src/main/art/sgdb'
import { NetworkError } from '../src/main/net'

const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'lumen-art-'))
const opt = (id: number): ArtOption => ({ id, url: `https://cdn2.steamgriddb.com/grid/${id}.png`, thumb: '', width: 600, height: 900 })
const PNG = Buffer.alloc(200, 1)

function fakeSgdb(over: Partial<Record<'images' | 'search', unknown>> = {}, enabled = true) {
  return {
    enabled,
    images: vi.fn(async (_k: ArtKind, by: { steamAppId?: number; gameId?: number }) => (by.steamAppId ? [opt(1), opt(2)] : [opt(9)])),
    search: vi.fn(async (): Promise<SgdbGame[]> => []),
    ...over
  } as unknown as SgdbClient & { images: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> }
}

function service(opts: {
  sgdb?: ReturnType<typeof fakeSgdb>
  steamPath?: string
  prefs?: Record<string, GameArtPrefs>
  priority?: 'sgdbFirst' | 'steamFirst'
  fetch?: (url: string) => Promise<{ bytes: Buffer; contentType?: string } | null>
  cacheDir?: string
}) {
  const fetchBytes = vi.fn(opts.fetch ?? (async () => ({ bytes: PNG, contentType: 'image/png' })))
  const sgdb = opts.sgdb ?? fakeSgdb()
  const svc = new ArtworkService({
    cacheDir: opts.cacheDir ?? tmp(),
    steamPath: () => opts.steamPath,
    sgdb,
    priority: () => opts.priority ?? 'sgdbFirst',
    prefsFor: (id) => opts.prefs?.[id],
    fetchBytes
  })
  return { svc, fetchBytes, sgdb }
}

describe('SteamGridDB helpers', () => {
  it('requests only display-sized, static, safe images', () => {
    expect(queryFor('grid')).toMatchObject({ dimensions: '600x900,660x930', types: 'static', nsfw: 'false', humor: 'false' })
    expect(queryFor('hero').dimensions).toContain('1920x620')
  })

  it('filters NSFW / epilepsy images from API data', () => {
    const r = toOptions([
      { id: 1, url: 'u1', thumb: 't1', width: 1, height: 1 },
      { id: 2, url: 'u2', thumb: 't2', width: 1, height: 1, nsfw: true },
      { id: 3, url: 'u3', thumb: '', width: 1, height: 1, epilepsy: true },
      { bogus: 1 }
    ])
    expect(r.map((o) => o.id)).toEqual([1])
    expect(toOptions(null)).toEqual([])
  })

  it('exact match ignores articles and punctuation, never a loose hit', () => {
    expect(pickExactMatch(['Daedalus Encounter, The'], [{ id: 1, name: 'Daedalus' }, { id: 2, name: 'The Daedalus Encounter' }])?.id).toBe(2)
    expect(pickExactMatch(['D'], [{ id: 3, name: 'D-Day' }, { id: 4, name: 'Dd' }])).toBeUndefined()
    expect(pickExactMatch(['Makaimura', "Ghosts'n Goblins"], [{ id: 5, name: "Ghosts 'n Goblins" }])?.id).toBe(5)
  })

  it('picks the best title match', () => {
    const results = [
      { id: 1, name: 'Portal 2: Desolation' },
      { id: 2, name: 'Portal 2' }
    ]
    expect(pickBestMatch('PORTAL™ 2', results)?.id).toBe(2)
    expect(pickBestMatch('Pokémon Snap', [{ id: 3, name: 'Pokemon Snap' }])?.id).toBe(3)
    expect(pickBestMatch('Celeste', [{ id: 4, name: 'Hollow Knight' }])).toBeUndefined()
    expect(pickBestMatch('Celeste', [])).toBeUndefined()
  })
})

describe('ArtworkService', () => {
  it('downloads the top SteamGridDB grid once and serves it from cache afterwards', async () => {
    const cacheDir = tmp()
    const { svc, fetchBytes, sgdb } = service({ cacheDir })
    const f1 = await svc.resolve('steam:620', 620, 'grid', 'Portal 2')
    expect(f1 && existsSync(f1)).toBe(true)
    expect(fetchBytes).toHaveBeenCalledWith('https://cdn2.steamgriddb.com/grid/1.png')
    await svc.flush()

    // a new service instance (= app restart) must not hit the network again
    const second = service({ cacheDir, sgdb })
    const f2 = await second.svc.resolve('steam:620', 620, 'grid', 'Portal 2')
    expect(f2).toBe(f1)
    expect(second.fetchBytes).not.toHaveBeenCalled()
    expect(sgdb.images).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent requests for the same image', async () => {
    const { svc, sgdb } = service({})
    await Promise.all([1, 2, 3].map(() => svc.resolve('steam:1', 1, 'grid', 'X')))
    expect(sgdb.images).toHaveBeenCalledTimes(1)
  })

  it('falls back to search by name when the Steam id is unknown to SteamGridDB', async () => {
    const sgdb = fakeSgdb({
      images: vi.fn(async (_k: ArtKind, by: { steamAppId?: number; gameId?: number }) => (by.gameId === 77 ? [opt(77)] : [])),
      search: vi.fn(async () => [{ id: 77, name: 'Some Game' }])
    })
    const { svc, fetchBytes } = service({ sgdb })
    const f = await svc.resolve('steam:5', 5, 'grid', 'Some Game')
    expect(f).toBeTruthy()
    expect(sgdb.search).toHaveBeenCalledWith('Some Game')
    expect(fetchBytes).toHaveBeenCalledWith('https://cdn2.steamgriddb.com/grid/77.png')
  })

  it('uses a manual match when the user corrected it', async () => {
    const { svc, sgdb } = service({ prefs: { 'steam:5': { sgdbGameId: 9 } } })
    await svc.resolve('steam:5', 5, 'grid', 'X')
    expect(sgdb.images).toHaveBeenCalledWith('grid', { gameId: 9 })
  })

  it('remembers misses so it does not query again on every start', async () => {
    const cacheDir = tmp()
    const sgdb = fakeSgdb({ images: vi.fn(async () => []) })
    const { svc } = service({ sgdb, cacheDir, fetch: async () => null })
    expect(await svc.resolve('steam:5', 5, 'logo', undefined)).toBeNull()
    await svc.flush()
    const again = service({ sgdb, cacheDir, fetch: async () => null })
    expect(await again.svc.resolve('steam:5', 5, 'logo', undefined)).toBeNull()
    expect(sgdb.images).toHaveBeenCalledTimes(1)
    expect(again.fetchBytes).not.toHaveBeenCalled()
  })

  it('works without a SteamGridDB key using Steam local artwork', async () => {
    const steamPath = tmp()
    const dir = path.join(steamPath, 'appcache', 'librarycache', '620', 'abcdef')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'library_600x900_2x.jpg'), PNG)
    const sgdb = fakeSgdb({}, false)
    const { svc, fetchBytes } = service({ sgdb, steamPath })
    expect(await svc.resolve('steam:620', 620, 'grid', 'Portal 2')).toBe(path.join(dir, 'library_600x900_2x.jpg'))
    expect(sgdb.images).not.toHaveBeenCalled()
    expect(fetchBytes).not.toHaveBeenCalled()
  })

  it('falls back to the Steam CDN when nothing is local', async () => {
    const { svc, fetchBytes } = service({ sgdb: fakeSgdb({}, false), priority: 'steamFirst' })
    expect(await svc.resolve('steam:620', 620, 'hero', 'P')).toBeTruthy()
    expect(fetchBytes.mock.calls[0][0]).toMatch(/\/steam\/apps\/620\/library_hero\.jpg$/)
  })

  it('honours explicit user choices', async () => {
    const custom = path.join(tmp(), 'my.png')
    writeFileSync(custom, PNG)
    const { svc, sgdb, fetchBytes } = service({
      prefs: {
        'steam:1': { grid: { type: 'file', file: custom }, logo: { type: 'none' }, hero: { type: 'sgdb', imageId: 5, url: 'https://cdn2.steamgriddb.com/hero/5.png' } }
      }
    })
    expect(await svc.resolve('steam:1', 1, 'grid', 'X')).toBe(custom)
    expect(await svc.resolve('steam:1', 1, 'logo', 'X')).toBeNull()
    expect(await svc.resolve('steam:1', 1, 'hero', 'X')).toBeTruthy()
    expect(fetchBytes).toHaveBeenCalledWith('https://cdn2.steamgriddb.com/hero/5.png')
    expect(sgdb.images).not.toHaveBeenCalled()
  })

  it('survives network failures and an invalid key without throwing', async () => {
    const offline = service({ fetch: async () => Promise.reject(new NetworkError('offline')) })
    expect(await offline.svc.resolve('steam:1', 1, 'grid', 'X')).toBeNull()
    const badKey = service({ sgdb: fakeSgdb({ images: vi.fn(async () => Promise.reject(new SgdbAuthError('401'))) }), fetch: async () => null })
    expect(await badKey.svc.resolve('steam:1', 1, 'grid', 'X')).toBeNull()
  })

  it('EmuStart games: SteamGridDB poster by an exact title match (any of the names)', async () => {
    const sgdb = fakeSgdb({
      search: vi.fn(async (t: string): Promise<SgdbGame[]> =>
        t === 'Daedalus Encounter, The' ? [{ id: 7, name: 'The Daedalus Encounter' }] : [{ id: 8, name: 'Something Else' }]
      )
    })
    const { svc } = service({ sgdb })
    const f = await svc.resolveTitled('emugrp:abc', 'grid', ['Daedalus Encounter Episode 1', 'Daedalus Encounter, The'])
    expect(f).toBeTruthy()
    expect(sgdb.search).toHaveBeenCalledTimes(2)
    expect(sgdb.images).toHaveBeenCalledWith('grid', { gameId: 7 })
  })

  it('EmuStart games: no exact match or no key = the source art (undefined), choices win', async () => {
    const loose = fakeSgdb({ search: vi.fn(async (): Promise<SgdbGame[]> => [{ id: 1, name: 'D-Day' }]) })
    expect(await service({ sgdb: loose }).svc.resolveTitled('emu:1', 'grid', ['D'])).toBeUndefined()
    expect(await service({ sgdb: fakeSgdb({}, false) }).svc.resolveTitled('emu:1', 'grid', ['D'])).toBeUndefined()
    const { svc, sgdb } = service({ prefs: { 'emu:2': { grid: { type: 'steam' }, hero: { type: 'none' } } } })
    expect(await svc.resolveTitled('emu:2', 'grid', ['X'])).toBeUndefined()
    expect(await svc.resolveTitled('emu:2', 'hero', ['X'])).toBeNull()
    expect(await svc.resolveTitled('emu:3', 'logo', ['X'], false)).toBeUndefined()
    expect(sgdb.search).not.toHaveBeenCalled()
  })

  it('clears the cache directory and reports stats', async () => {
    const cacheDir = tmp()
    const { svc } = service({ cacheDir })
    await svc.resolve('steam:620', 620, 'grid', 'Portal 2')
    await svc.flush()
    expect((await svc.stats()).files).toBeGreaterThan(0)
    await svc.clear()
    expect(await svc.stats()).toEqual({ files: 0, bytes: 0 })
  })
})
