import { describe, expect, it, beforeAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseVdf, vget, vnum, VdfParseError } from '../src/main/steam/vdf'
import { AppState, isPlayable, isToolApp, manifestProgress, mapInstallState, parseManifest } from '../src/main/steam/manifests'
import {
  accountIdToSteamId64,
  parseLibraryFolders,
  parseLocalConfigPlayStats,
  parseLoginUsers,
  readLibraryFolders,
  readLocalPlayStats,
  scanAllLibraries,
  steamId64ToAccountId
} from '../src/main/steam/local'
import { parseRegQuery } from '../src/main/steam/registry'
import { parseOwnedGames } from '../src/main/steam/webApi'
import { parseAppDetails, parseReviewSummary, parseSteamSpy, StoreMetadataProvider } from '../src/main/steam/storeMeta'
import { mergeLibrary, sortKey } from '../src/main/library/merge'

const FIX = path.join(__dirname, 'fixtures')

describe('VDF parser', () => {
  it('parses nested objects, escapes and comments', () => {
    const v = parseVdf(`// comment
"root"
{
  "a"   "1"
  "esc" "say \\"hi\\"\\n"
  child { "x" "y" }   // trailing
  "child" { "z" "w" }
}`)
    expect(vget(v, 'root', 'a')).toBe('1')
    expect(vget(v, 'root', 'esc')).toBe('say "hi"\n')
    // objects with duplicate keys are merged
    expect(vget(v, 'root', 'child')).toEqual({ x: 'y', z: 'w' })
  })

  it('looks keys up case-insensitively', () => {
    const v = parseVdf('"A" { "StateFlags" "4" }')
    expect(vnum(v, 'a', 'stateflags')).toBe(4)
  })

  it('handles a BOM and empty input', () => {
    expect(parseVdf('\ufeff"a" "b"')).toEqual({ a: 'b' })
    expect(parseVdf('')).toEqual({})
  })

  it('throws on malformed input', () => {
    expect(() => parseVdf('"a" { "b" "c"')).toThrow(VdfParseError)
    expect(() => parseVdf('"a" "unterminated')).toThrow(VdfParseError)
    expect(() => parseVdf('}')).toThrow(VdfParseError)
  })
})

describe('install state mapping', () => {
  it.each([
    [4, 'installed'],
    [6, 'updateRequired'],
    [4 | AppState.UpdateRunning | AppState.Downloading, 'updating'],
    [1026, 'installing'], // UpdateRequired | UpdateStarted, not yet installed
    [2, 'installing'],
    [4 | AppState.UpdatePaused, 'updatePaused'],
    [1, 'notInstalled'],
    [4 | AppState.Uninstalling, 'uninstalling'],
    [4 | AppState.FilesMissing, 'broken'],
    [0, 'broken']
  ] as const)('flags %i → %s', (flags, state) => {
    expect(mapInstallState(flags)).toBe(state)
  })

  it('only installed / update-required games are playable', () => {
    expect(isPlayable('installed')).toBe(true)
    expect(isPlayable('updateRequired')).toBe(true)
    expect(isPlayable('installing')).toBe(false)
    expect(isPlayable('notInstalled')).toBe(false)
  })

  it('reports progress only when Steam provides real counters', () => {
    const m = parseManifest(readFileSync(path.join(FIX, 'lib2/steamapps/appmanifest_1245620.acf'), 'utf8'))!
    expect(manifestProgress(m)).toEqual({
      bytesDownloaded: 12500000000,
      bytesToDownload: 50000000000,
      bytesStaged: 12000000000,
      bytesToStage: 50000000000
    })
    const done = parseManifest(readFileSync(path.join(FIX, 'steam/steamapps/appmanifest_620.acf'), 'utf8'))!
    expect(manifestProgress(done)).toBeUndefined()
  })

  it('recognises Steam tools', () => {
    expect(isToolApp(228980, 'Steamworks Common Redistributables')).toBe(true)
    expect(isToolApp(1, 'Proton 9.0')).toBe(true)
    expect(isToolApp(620, 'Portal 2')).toBe(false)
  })
})

describe('local Steam files', () => {
  let steamDir: string
  let lib2: string

  beforeAll(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'lumen-steam-'))
    steamDir = path.join(root, 'Steam')
    lib2 = path.join(root, 'Lib Two')
    cpSync(path.join(FIX, 'steam'), steamDir, { recursive: true })
    cpSync(path.join(FIX, 'lib2'), lib2, { recursive: true })
    const lf = path.join(steamDir, 'steamapps', 'libraryfolders.vdf')
    const esc = (p: string): string => p.replace(/\\/g, '\\\\')
    writeFileSync(lf, readFileSync(lf, 'utf8').replace('__STEAM__', esc(steamDir)).replace('__LIB2__', esc(lib2)))
  })

  it('reads all library folders without duplicates', async () => {
    const folders = await readLibraryFolders(steamDir)
    expect(folders.map((f) => path.normalize(f))).toEqual([path.normalize(steamDir), path.normalize(lib2)])
  })

  it('parses legacy flat libraryfolders format', () => {
    const v = parseLibraryFolders('"LibraryFolders" { "TimeNextStatsReport" "1" "1" "E:\\\\Games" }')
    expect(v).toEqual([path.normalize('E:\\Games')])
  })

  it('scans manifests across libraries and skips broken files', async () => {
    const manifests = await scanAllLibraries(await readLibraryFolders(steamDir))
    const ids = manifests.map((m) => m.appId).sort((a, b) => a - b)
    expect(ids).toEqual([620, 228980, 1245620])
    expect(manifests.find((m) => m.appId === 1245620)!.libraryPath).toBe(path.normalize(lib2))
  })

  it('returns an empty list for a missing library folder', async () => {
    expect(await scanAllLibraries([path.join(steamDir, 'does-not-exist')])).toEqual([])
  })

  it('reads play stats from localconfig.vdf', async () => {
    const stats = await readLocalPlayStats(steamDir, 12345)
    expect(stats.get(620)).toEqual({ lastPlayed: 1710000000, playtimeMinutes: 754 })
    expect(stats.get(1245620)).toEqual({ lastPlayed: undefined, playtimeMinutes: 0 })
    expect(stats.has(440)).toBe(false)
    expect((await readLocalPlayStats(steamDir, 999)).size).toBe(0)
  })

  it('handles malformed localconfig gracefully', () => {
    expect(() => parseLocalConfigPlayStats('"UserLocalConfigStore" { }')).not.toThrow()
  })

  it('orders login users by MostRecent first', () => {
    const users = parseLoginUsers(readFileSync(path.join(FIX, 'steam/config/loginusers.vdf'), 'utf8'))
    expect(users.map((u) => u.accountName)).toEqual(['me', 'other'])
  })

  it('converts between account id and SteamID64', () => {
    expect(accountIdToSteamId64(12345)).toBe('76561197960278073')
    expect(steamId64ToAccountId('76561197960278073')).toBe(12345)
    expect(steamId64ToAccountId('123')).toBeUndefined()
    expect(steamId64ToAccountId('abc')).toBeUndefined()
  })
})

describe('registry output parsing', () => {
  it('parses reg.exe query output', () => {
    const out = `
HKEY_CURRENT_USER\\Software\\Valve\\Steam
    SteamPath    REG_SZ    c:/program files (x86)/steam
    RunningAppID    REG_DWORD    0x26c
    BetaName    REG_SZ
`
    expect(parseRegQuery(out)).toEqual({ SteamPath: 'c:/program files (x86)/steam', RunningAppID: 620, BetaName: '' })
  })
})

describe('Steam Web API', () => {
  it('parses owned games', () => {
    const r = parseOwnedGames({
      response: {
        game_count: 2,
        games: [
          { appid: 620, name: 'Portal 2', playtime_forever: 60, rtime_last_played: 1700000000 },
          { appid: 10, playtime_forever: 0, rtime_last_played: 0 },
          { name: 'no id' }
        ]
      }
    })
    expect(r).toEqual({
      kind: 'ok',
      games: [
        { appId: 620, name: 'Portal 2', playtimeMinutes: 60, lastPlayed: 1700000000 },
        { appId: 10, name: undefined, playtimeMinutes: 0, lastPlayed: undefined }
      ]
    })
  })

  it('treats an empty response as a private profile', () => {
    expect(parseOwnedGames({ response: {} })).toEqual({ kind: 'private' })
    expect(parseOwnedGames(null)).toEqual({ kind: 'private' })
  })
})

describe('Steam store metadata', () => {
  it('maps appdetails and omits empty fields', () => {
    const d = parseAppDetails(620, {
      '620': {
        success: true,
        data: {
          name: 'Portal 2',
          short_description: 'Puzzle &amp; co',
          genres: [{ description: 'Akcja' }, { description: '' }],
          release_date: { coming_soon: false, date: '18 kwi 2011' },
          developers: ['Valve'],
          publishers: []
        }
      }
    })!
    expect(d.shortDescription).toBe('Puzzle & co')
    expect(d.genres).toEqual(['Akcja'])
    expect(d.developers).toEqual(['Valve'])
    expect(d.publishers).toBeUndefined()
    expect(d.criticScore).toBeUndefined()
  })

  it('reads Metacritic, co-op, the age rating and the Steam reviews summary', () => {
    const d = parseAppDetails(620, {
      '620': {
        success: true,
        data: { name: 'Portal 2', metacritic: { score: 95 }, categories: [{ id: 2 }, { id: 9 }], ratings: { pegi: { rating: '12' }, esrb: { rating: 'e10' } } }
      }
    })!
    expect(d).toMatchObject({ criticScore: 95, coop: true, esrb: 'PEGI 12', version: 3 })
    expect(parseReviewSummary({ success: 1, query_summary: { total_positive: 980, total_reviews: 1000 } })).toEqual({ playerScore: 98, playerReviews: 1000 })
    expect(parseReviewSummary({ success: 1, query_summary: { total_reviews: 0 } })).toEqual({})
    expect(parseSteamSpy({ positive: 427835, negative: 5675 })).toEqual({ playerScore: 99, playerReviews: 433510 })
    expect(parseSteamSpy({})).toEqual({})
  })

  it('returns null for failed lookups', () => {
    expect(parseAppDetails(1, { '1': { success: false } })).toBeNull()
    expect(parseAppDetails(1, {})).toBeNull()
  })
})

describe('library merge', () => {
  const manifests = [
    { appId: 620, name: 'Portal 2', stateFlags: 4, libraryPath: 'C:\\S', bytesToDownload: 0, bytesDownloaded: 0, bytesToStage: 0, bytesStaged: 0 },
    { appId: 228980, name: 'Steamworks Common Redistributables', stateFlags: 4, libraryPath: 'C:\\S', bytesToDownload: 0, bytesDownloaded: 0, bytesToStage: 0, bytesStaged: 0 },
    { appId: 5, name: 'The Witness', stateFlags: 1026, libraryPath: 'D:\\L', bytesToDownload: 100, bytesDownloaded: 10, bytesToStage: 0, bytesStaged: 0 }
  ]

  it('uses local data only when no account data is available', () => {
    const games = mergeLibrary({ manifests, localStats: new Map([[620, { lastPlayed: 100, playtimeMinutes: 5 }]]), showTools: false })
    expect(games.map((g) => g.id)).toEqual(['steam:620', 'steam:5'])
    expect(games.every((g) => g.provenance.join() === 'localManifest')).toBe(true)
    expect(games[0]).toMatchObject({ installed: true, lastPlayed: 100, playtimeMinutes: 5 })
    expect(games[1]).toMatchObject({ installState: 'installing', installed: false, progress: { bytesDownloaded: 10, bytesToDownload: 100 } })
  })

  it('adds owned-but-not-installed games and prefers account playtime', () => {
    const games = mergeLibrary({
      manifests,
      owned: [
        { appId: 620, name: 'Portal 2', playtimeMinutes: 900, lastPlayed: 50 },
        { appId: 70, name: 'Half-Life', playtimeMinutes: 0 }
      ],
      localStats: new Map([[620, { lastPlayed: 100, playtimeMinutes: 5 }]]),
      runningAppId: 620,
      showTools: false
    })
    const portal = games.find((g) => g.appId === 620)!
    expect(portal.provenance).toEqual(['localManifest', 'accountApi'])
    expect(portal.playtimeMinutes).toBe(900)
    expect(portal.lastPlayed).toBe(100) // newest of local and account
    expect(portal.running).toBe(true)
    const hl = games.find((g) => g.appId === 70)!
    expect(hl).toMatchObject({ installed: false, installState: 'notInstalled', provenance: ['accountApi'] })
  })

  it('shows tools only on request', () => {
    expect(mergeLibrary({ manifests, localStats: new Map(), showTools: true }).some((g) => g.appId === 228980)).toBe(true)
  })

  it('sorts ignoring leading articles', () => {
    expect(sortKey('The Witness')).toBe('witness')
    const games = mergeLibrary({ manifests, localStats: new Map(), showTools: false })
    expect(games.map((g) => g.name)).toEqual(['Portal 2', 'The Witness'])
  })
})

describe('ratings for sorting', () => {
  it('asks the store once per run for an app it has no data for (no endless lookups)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lumen-meta-'))
    // a delisted app: the store answers success: false
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ '42': { success: false } })))
    const meta = new StoreMetadataProvider(dir, () => 'polish')
    await meta.prefetch([42])
    expect(meta.wasTried(42)).toBe(true)
    expect(await meta.cachedRatings(42)).toBeUndefined()
    const calls = fetchMock.mock.calls.length
    await meta.prefetch([42]) // the list asks again 20 s later
    expect(fetchMock.mock.calls.length).toBe(calls)
    fetchMock.mockRestore()
  })
})
