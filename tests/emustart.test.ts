import { describe, expect, it } from 'vitest'
import type { Game } from '../src/shared/types'
import { emuArtField, emuDetails, emuGames, emuGameId, isEmuGameId, type EmuLibrary, type EmuLibraryRow } from '../src/main/emustart/mapping'
import { emuJobs, steamJobs } from '../src/main/core/jobs'
import { toEngineSettings, toOptions } from '../src/main/emustart/ipc'
import type { EmuStatusRaw } from '../src/main/emustart/provider'
import { defaultPrefs, migratePrefs, ops } from '../src/main/store/prefs'
import { isModeCombo } from '../src/shared/pad'
import { gamesForCategory, storeGames } from '../src/renderer/src/store'

// All data below is synthetic (no real library, server or account).

const row = (o: Partial<EmuLibraryRow> = {}): EmuLibraryRow => ({
  id: 7,
  sid: 'gabc',
  es: 'snes',
  system: 'Super Nintendo',
  title: 'The Test Quest',
  name: 'Test Quest, The (Europe)',
  tags: '(Europe)',
  size: 2_097_152,
  cached: false,
  pinned: false,
  last: 0,
  seconds: 0,
  box: '/media/snes/box/x.webp',
  ...o
})

const lib = (games: EmuLibraryRow[]): EmuLibrary => ({
  systems: [{ es: 'snes', display: 'Super Nintendo', games: games.length, cached: 0, emulator: '' }],
  games,
  lib_version: 1,
  server: { ok: true },
  configured: true
})

const steamGame = (appId: number, o: Partial<Game> = {}): Game => ({
  id: `steam:${appId}`,
  source: 'steam',
  appId,
  name: `Steam ${appId}`,
  sortName: `steam ${appId}`,
  provenance: ['localManifest'],
  installState: 'installed',
  installed: true,
  ...o
})

describe('EmuStart → unified library', () => {
  it('uses the cross-device id and keeps EmuStart specifics', () => {
    const [g] = emuGames(lib([row({ cached: true, last: 1700000000, seconds: 3600 })]))
    expect(g.id).toBe(emuGameId('gabc'))
    expect(g.source).toBe('emustart')
    expect(g.installState).toBe('installed')
    expect(g.lastPlayed).toBe(1700000000)
    expect(g.playtimeMinutes).toBe(60)
    expect(g.emu).toMatchObject({ id: 7, es: 'snes', hasBox: true, hasSnap: false })
  })

  it('marks a running download and a game only on the server', () => {
    const games = emuGames(lib([row(), row({ id: 8, sid: 'gdef' })]), new Set([8]))
    expect(games.map((g) => g.installState)).toEqual(['notInstalled', 'installing'])
    expect(games[1].emu?.copying).toBe(true)
  })

  it('never merges by title: same title on Steam and EmuStart stays two entries', () => {
    const emu = emuGames(lib([row({ title: 'Doom' })]))
    const all = [steamGame(2280, { name: 'Doom' }), ...emu]
    expect(new Set(all.map((g) => g.id)).size).toBe(2)
  })

  it('a multi-disc set is one entry with its number of discs', () => {
    const [set, single] = emuGames(lib([row({ discs: 3 }), row({ id: 8, sid: 'gdef' })]))
    expect(set.emu?.discs).toBe(3)
    expect(single.emu?.discs).toBe(1)
  })

  it('a group of versions is an EmuStart id too (its art comes from EmuStart)', () => {
    expect(isEmuGameId('emu:g1')).toBe(true)
    expect(isEmuGameId('emugrp:abc')).toBe(true)
    expect(isEmuGameId('steam:10')).toBe(false)
    expect(emuGames(lib([row({ lb: 4879 })]))[0].emu?.lb).toBe(4879)
  })

  it('drops duplicate server ids', () => {
    expect(emuGames(lib([row(), row({ id: 9 })]))).toHaveLength(1)
  })

  it('maps art kinds and details', () => {
    expect([emuArtField('grid'), emuArtField('hero'), emuArtField('logo'), emuArtField('icon')]).toEqual(['box', 'snap', 'logo', null])
    const d = emuDetails({ id: 7, title: 'X', system: 'SNES', meta_online: true, meta: { description: 'Opis', genre: 'RPG, Action', year: '1995' } })
    expect(d.ok && d.details).toMatchObject({ source: 'emustart', descriptionText: 'Opis', genres: ['RPG', 'Action'], releaseDate: '1995', platform: 'SNES' })
    expect(emuDetails({}).ok).toBe(false)
  })
})

describe('platform groups', () => {
  it('adds EmuStart platforms as pinned read-only groups and follows the server', () => {
    let p = ops.syncEmustartSystems(defaultPrefs(), [{ es: 'snes', display: 'Super Nintendo', games: 3, cached: 0, emulator: '' }])
    const cat = p.categories.find((c) => c.id === 'emusys:snes')!
    expect(cat).toMatchObject({ kind: 'emustart', emuSystem: 'snes', pinned: true })
    expect(ops.syncEmustartSystems(p, [{ es: 'snes', display: 'Super Nintendo', games: 3, cached: 0, emulator: '' }])).toBe(p)
    p = ops.setPinned(p, 'emusys:snes', false)
    p = ops.syncEmustartSystems(p, [{ es: 'snes', display: 'SNES', games: 3, cached: 0, emulator: '' }])
    expect(p.categories.find((c) => c.id === 'emusys:snes')).toMatchObject({ name: 'SNES', pinned: false })
    expect(() => ops.deleteCategory(p, 'emusys:snes')).toThrow()
    expect(() => ops.renameCategory(p, 'emusys:snes', 'x')).toThrow()
    p = ops.syncEmustartSystems(p, [])
    expect(p.categories.some((c) => c.kind === 'emustart')).toBe(false)
  })

  it('keeps EmuStart groups through a prefs migration', () => {
    const p = ops.syncEmustartSystems(defaultPrefs(), [{ es: 'psx', display: 'PlayStation', games: 1, cached: 0, emulator: '' }])
    expect(migratePrefs(JSON.parse(JSON.stringify(p))).categories.some((c) => c.id === 'emusys:psx')).toBe(true)
  })

  it('filters games per platform; the Steam group shows Steam only', () => {
    const p = ops.syncEmustartSystems(defaultPrefs(), [{ es: 'snes', display: 'SNES', games: 1, cached: 0, emulator: '' }])
    const games = [steamGame(10), ...emuGames(lib([row()]))]
    const snes = p.categories.find((c) => c.id === 'emusys:snes')!
    expect(gamesForCategory(snes, games, p, null).map((g) => g.id)).toEqual(['emu:gabc'])
    expect(storeGames(games).map((g) => g.id)).toEqual(['steam:10'])
  })
})

const status = (o: Partial<EmuStatusRaw> = {}): EmuStatusRaw => ({
  launch: { phase: 'idle' },
  copies: [],
  install: null,
  emu_sync: null,
  post: '',
  scan: { running: false, text: '', done: 0, total: 0 },
  server: null,
  conflicts: [],
  lib_version: 0,
  ...o
})

describe('job list', () => {
  it('shows Steam downloads only with real counters and as managed by Steam', () => {
    const jobs = steamJobs([
      steamGame(1, { installState: 'installing', installed: false, progress: { bytesDownloaded: 50, bytesToDownload: 200, bytesStaged: 0, bytesToStage: 0 } }),
      steamGame(2, { installState: 'updating' }),
      steamGame(3)
    ])
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ managedBySteam: true, cancellable: false, progress: { done: 50, total: 200 } })
    expect(jobs[1].progress).toBeUndefined()
    expect(jobs[1].message).toMatch(/nie podaje/)
  })

  it('maps EmuStart launch phases, copies, emulator installs and save uploads', () => {
    const id = (n: number): string | undefined => (n === 7 ? 'emu:gabc' : undefined)
    const jobs = emuJobs(
      status({
        launch: { phase: 'downloading', game_id: 7, title: 'T', progress: { done: 1, total: 4, speed: 2, eta: 3 } },
        copies: [{ game_id: 7, title: 'T', done: 5, total: 10 }],
        install: { running: true, step: 1, steps: 2, current: 'RetroArch', done: 0, total: 0, errors: [], installed: [], postponed: [], cancelled: false },
        post: 'Gracz'
      }),
      id
    )
    expect(jobs.map((j) => j.kind)).toEqual(['emuLaunch', 'emuDownload', 'emuInstall', 'saveUpload'])
    expect(jobs[0]).toMatchObject({ gameId: 'emu:gabc', phase: 'Pobieranie z serwera', cancellable: true, progress: { done: 1, total: 4 } })
    expect(jobs[2].phase).toContain('(1/2)')
  })

  it('a save conflict waits for the player and cannot be cancelled away', () => {
    const [j] = emuJobs(
      status({
        launch: {
          phase: 'conflict',
          title: 'T',
          message: 'Zapisy tej gry zmieniły się na tym urządzeniu i na innym.',
          conflict: [{ emulator: 'retroarch', core: 'snes9x', kind: 'saves', server_revision: 3, server_time: 2, server_device: 'Telefon', local_time: 1, local_files: 1 }]
        }
      }),
      () => undefined
    )
    expect(j).toMatchObject({ state: 'waiting', phase: expect.stringContaining('Konflikt zapisów'), cancellable: false })
  })

  it('an error is a job state, not hidden; a finished install drops off', () => {
    const jobs = emuJobs(
      status({
        launch: { phase: 'error', message: 'Brak BIOS-u' },
        install: { running: false, step: 2, steps: 2, current: '', done: 0, total: 0, errors: ['x'], installed: [], postponed: [], cancelled: false }
      }),
      () => undefined
    )
    expect(jobs).toEqual([expect.objectContaining({ kind: 'emuLaunch', state: 'error', message: 'Brak BIOS-u', cancellable: false })])
    expect(emuJobs(null, () => undefined)).toEqual([])
  })
})

describe('View + Start switches the layout', () => {
  const pad = (buttons: number) => ({ index: 0, buttons, lt: 0, rt: 0, lx: 0, ly: 0 })
  it('needs both buttons', () => {
    expect(isModeCombo(pad(0x0020 | 0x0010))).toBe(true)
    expect(isModeCombo(pad(0x0010))).toBe(false)
    expect(isModeCombo(pad(0x0020))).toBe(false)
  })
})


describe('test mode: login only to a local test server', () => {
  it('accepts loopback addresses and links whose every endpoint is local', async () => {
    const { loopbackLogin } = await import('../src/main/emustart/ipc')
    const link = (e: { u: string }[]): string => 'emustart://login?d=' + Buffer.from(JSON.stringify({ v: 1, e })).toString('base64url')
    expect(loopbackLogin('127.0.0.1:47740')).toBe(true)
    expect(loopbackLogin('https://localhost:47741')).toBe(true)
    expect(loopbackLogin(link([{ u: 'https://127.0.0.1:47741' }]))).toBe(true)
    expect(loopbackLogin('emustart.emucloud.org')).toBe(false)
    expect(loopbackLogin(link([{ u: 'https://127.0.0.1:47741' }, { u: 'https://emustart.emucloud.org' }]))).toBe(false)
    expect(loopbackLogin('emustart://login?d=zepsute')).toBe(false)
    expect(loopbackLogin('')).toBe(false)
  })
})

describe('EmuStart settings shared by both layouts', () => {
  it('maps the desktop options to the engine settings and back', () => {
    expect(toEngineSettings({ hide: { beta: true }, arcadeClones: false, cacheRecent: 250, gamesLogo: true, machineProfile: 2 })).toEqual({
      hide_beta: true,
      hide_arcade_clones: false,
      cache_recent: 100,
      games_logo: true,
      machine_profile: 2
    })
    const o = toOptions({ hide_demo: true, games_logo: true, stream_play: false, systems: [] }, [{ id: 1, name: 'Gracz' }])
    expect(o.hide.demo).toBe(true)
    expect(o.gamesLogo).toBe(true)
    expect(o.streamPlay).toBe(false)
    expect(o.arcadeClones).toBe(true) // EmuStart's default
  })
})
