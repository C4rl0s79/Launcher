import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BinaryVdfError, parseBinaryVdf } from '../src/main/steam/binaryVdf'
import { parseShortcuts, shortcutGameId64 } from '../src/main/steam/shortcuts'
import { shortcutGames } from '../src/main/library/merge'
import { shortcutRunUri } from '../src/main/steam/actions'
import { ArtworkService } from '../src/main/art/artwork'
import type { SgdbClient } from '../src/main/art/sgdb'

// --- tiny binary KeyValues writer for fixtures ---
type V = string | number | { [k: string]: V }
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
function encode(obj: { [k: string]: V }): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') parts.push(Buffer.from([0x01]), cstr(k), cstr(v))
    else if (typeof v === 'number') {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(v >>> 0)
      parts.push(Buffer.from([0x02]), cstr(k), b)
    } else parts.push(Buffer.from([0x00]), cstr(k), encode(v), Buffer.from([0x08]))
  }
  return Buffer.concat(parts)
}
const file = (shortcuts: { [k: string]: V }): Buffer => Buffer.concat([Buffer.from([0x00]), cstr('shortcuts'), encode(shortcuts), Buffer.from([0x08, 0x08])])

const SAMPLE = file({
  '0': {
    appid: 3537358509,
    AppName: 'Final Fantasy X',
    Exe: '"D:/Emu/pcsx2/pcsx2.exe"',
    StartDir: '"D:/Emu/pcsx2/"',
    LaunchOptions: '"D:/Roms/ps2/ffx.iso"',
    IsHidden: 0,
    LastPlayTime: 1700000000,
    tags: { '0': 'Non-Steam', '1': 'PS2' }
  },
  '1': { appid: 2222839735, appname: 'Crash Bandicoot', Exe: '"D:/Emu/duck/duckstation.exe"', IsHidden: 0, LastPlayTime: 0, tags: { '0': 'PS1' } },
  '2': { appid: 123, AppName: 'Hidden one', Exe: 'x.exe', IsHidden: 1, tags: {} },
  '3': { appid: 0, AppName: 'No id' }
})

describe('binary VDF', () => {
  it('parses nested objects, strings and uint32 values', () => {
    const v = parseBinaryVdf(SAMPLE)
    const sc = (v.shortcuts as Record<string, Record<string, unknown>>)['0']
    expect(sc.appid).toBe(3537358509) // unsigned, not negative
    expect((sc.tags as Record<string, string>)['1']).toBe('PS2')
  })

  it('rejects truncated or unknown data', () => {
    expect(() => parseBinaryVdf(SAMPLE.subarray(0, 30))).toThrow(BinaryVdfError)
    expect(() => parseBinaryVdf(Buffer.from([0x09, 0x61, 0x00]))).toThrow(BinaryVdfError)
  })
})

describe('non-Steam shortcuts', () => {
  it('reads shortcuts with case-insensitive keys, unquotes paths, keeps tags', () => {
    const list = parseShortcuts(SAMPLE)
    expect(list.map((s) => s.name)).toEqual(['Final Fantasy X', 'Crash Bandicoot', 'Hidden one'])
    expect(list[0]).toMatchObject({ appId: 3537358509, exe: 'D:/Emu/pcsx2/pcsx2.exe', startDir: 'D:/Emu/pcsx2/', lastPlayed: 1700000000, tags: ['Non-Steam', 'PS2'] })
    expect(list[1].lastPlayed).toBeUndefined()
    expect(list[2].hidden).toBe(true)
  })

  it('builds the 64-bit launch id Steam expects', () => {
    expect(shortcutGameId64(3537358509)).toBe(((3537358509n << 32n) | 0x02000000n).toString())
    expect(shortcutRunUri(shortcutGameId64(3537358509))).toBe(`steam://rungameid/${shortcutGameId64(3537358509)}`)
    expect(() => shortcutRunUri('abc')).toThrow()
  })

  it('becomes library entries; hidden ones skipped, missing programs flagged', () => {
    const games = shortcutGames(parseShortcuts(SAMPLE), (exe) => exe.includes('pcsx2'), 3537358509)
    expect(games.map((g) => g.id)).toEqual(['shortcut:3537358509', 'shortcut:2222839735'])
    expect(games[0]).toMatchObject({ source: 'shortcut', installed: true, installState: 'installed', running: true, shortcut: { tags: ['PS2'] } })
    expect(games[1]).toMatchObject({ installed: false, installState: 'broken' })
  })
})

describe('artwork for shortcuts', () => {
  const PNG = Buffer.alloc(200, 1)

  it('uses the Steam grid folder (as written by Steam ROM Manager) before anything else', async () => {
    const grid = mkdtempSync(path.join(tmpdir(), 'lumen-grid-'))
    for (const f of ['3537358509p.png', '3537358509_hero.jpg', '3537358509_logo.png', '3537358509.ico']) writeFileSync(path.join(grid, f), PNG)
    const sgdb = { enabled: true, images: vi.fn(async () => []), search: vi.fn(async () => []) } as unknown as SgdbClient
    const svc = new ArtworkService({
      cacheDir: mkdtempSync(path.join(tmpdir(), 'lumen-c-')),
      steamPath: () => undefined,
      sgdb,
      priority: () => 'sgdbFirst',
      prefsFor: () => undefined,
      userGridDir: () => grid,
      fetchBytes: async () => null
    })
    const id = 'shortcut:3537358509'
    expect(await svc.resolve(id, undefined, 'grid', 'FFX', 3537358509)).toBe(path.join(grid, '3537358509p.png'))
    expect(await svc.resolve(id, undefined, 'hero', 'FFX', 3537358509)).toBe(path.join(grid, '3537358509_hero.jpg'))
    expect(await svc.resolve(id, undefined, 'logo', 'FFX', 3537358509)).toBe(path.join(grid, '3537358509_logo.png'))
    expect(await svc.resolve(id, undefined, 'icon', 'FFX', 3537358509)).toBe(path.join(grid, '3537358509.ico'))
    expect(sgdb.images).not.toHaveBeenCalled()
  })

  it('falls back to a SteamGridDB title search (never a Steam app id lookup) for shortcuts', async () => {
    const images = vi.fn(async (_k: string, by: { gameId?: number; steamAppId?: number }) =>
      by.gameId === 5 ? [{ id: 1, url: 'https://cdn2.steamgriddb.com/grid/1.png', thumb: '', width: 600, height: 900 }] : []
    )
    const sgdb = { enabled: true, images, search: vi.fn(async () => [{ id: 5, name: 'Crash Bandicoot' }]) } as unknown as SgdbClient
    const emptyGrid = mkdtempSync(path.join(tmpdir(), 'lumen-grid-'))
    mkdirSync(emptyGrid, { recursive: true })
    const svc = new ArtworkService({
      cacheDir: mkdtempSync(path.join(tmpdir(), 'lumen-c-')),
      steamPath: () => undefined,
      sgdb,
      priority: () => 'sgdbFirst',
      prefsFor: () => undefined,
      userGridDir: () => emptyGrid,
      fetchBytes: async () => ({ bytes: PNG, contentType: 'image/png' })
    })
    expect(await svc.resolve('shortcut:2222839735', undefined, 'grid', 'Crash Bandicoot', 2222839735)).toBeTruthy()
    expect(images.mock.calls.every(([, by]) => !('steamAppId' in by))).toBe(true)
  })
})
