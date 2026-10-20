import { describe, expect, it, vi } from 'vitest'
import type { Game } from '../src/shared/types'
import { emuArtField, emuDetails, emuGames, emuGameId, type EmuLibrary, type EmuLibraryRow } from '../src/main/emustart/mapping'
import { emuJobs, steamJobs } from '../src/main/core/jobs'
import { createFullscreenBridge, STEAM_START_TIMEOUT_MS, type BridgeDeps } from '../src/main/core/fullscreenBridge'
import type { EmuStatusRaw } from '../src/main/emustart/provider'
import { defaultPrefs, migratePrefs, ops } from '../src/main/store/prefs'
import { isModeCombo, padActions, PadRepeater } from '../src/shared/emuPad'
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

function bridge(o: Partial<BridgeDeps> = {}) {
  let now = 1_000_000
  const games = [steamGame(10, { name: 'Alpha' }), steamGame(20, { name: 'Beta', installState: 'notInstalled', installed: false })]
  const deps: BridgeDeps = {
    engineReady: () => true,
    engineMessage: () => undefined,
    engineCall: vi.fn(async (m: string) => (m === 'get_state' ? { systems: [{ es: 'snes' }], copying: [5] } : m === 'list_systems' ? [{ es: 'snes' }] : { engine: m })),
    steamGames: () => games,
    steamStatus: () => 'running',
    artUrl: (id, kind) => `lumen-art://img/${id}/${kind}`,
    steamDetails: async () => ({ ok: true, details: { appId: 10, fetchedAt: 0, source: 'steamStore', descriptionHtml: '<p>A&amp;B</p>' }, stale: false }),
    play: vi.fn(async () => ({ ok: true as const, message: 'Uruchamianie' })),
    install: vi.fn(async () => ({ ok: true as const })),
    openInSteam: vi.fn(async () => ({ ok: true as const })),
    toggleFavorite: vi.fn(async () => true),
    isFavorite: () => false,
    runningAppId: () => undefined,
    steamJobs: () => [],
    setMode: vi.fn(),
    select: vi.fn(),
    emuLumenId: (n) => (n === 7 ? 'emu:gabc' : undefined),
    pickFolder: async () => 'D:\\x',
    quit: vi.fn(),
    log: () => undefined,
    now: () => now,
    ...o
  }
  return { b: createFullscreenBridge(deps), deps, tick: (ms: number) => (now += ms) }
}

describe('fullscreen bridge (EmuStart UI)', () => {
  it('adds Steam as the first system and passes EmuStart calls to the engine', async () => {
    const { b, deps } = bridge()
    const st = (await b.call('get_state')) as { systems: { es: string }[] }
    expect(st.systems.map((s) => s.es)).toEqual(['steam', 'snes'])
    expect(await b.call('game_options', [7])).toEqual({ engine: 'game_options' })
    expect(deps.engineCall).toHaveBeenCalledWith('game_options', [7])
  })

  it('lists Steam games in EmuStart rows with Lumen art', async () => {
    const { b, deps } = bridge()
    const rows = (await b.call('list_games', ['steam'])) as Record<string, unknown>[]
    expect(rows.map((r) => r.id)).toEqual(['steam:10', 'steam:20'])
    expect(rows[0]).toMatchObject({ cached: 1, box: 'lumen-art://img/steam:10/grid', source: 'steam' })
    expect(deps.engineCall).not.toHaveBeenCalledWith('list_games', expect.anything())
    const d = (await b.call('game_detail', ['steam:10'])) as { meta: { description: string }; steam_status: string }
    expect(d.meta.description).toBe('A&B')
    expect(d.steam_status).toContain('zainstalowana')
  })

  it('plays an installed Steam game through Steam and follows RunningAppID', async () => {
    let running: number | undefined
    const { b, deps, tick } = bridge({ runningAppId: () => running })
    expect(await b.call('launch', ['steam:10', '', false])).toEqual({ ok: true })
    expect(deps.play).toHaveBeenCalledWith('steam:10')
    expect(await b.call('launch_status')).toMatchObject({ phase: 'preparing' })
    running = 10
    expect(await b.call('launch_status')).toMatchObject({ phase: 'running' })
    running = undefined
    expect(await b.call('launch_status')).toMatchObject({ phase: 'finished' })
    await b.call('launch_dismiss')
    expect(b.steamSessionActive()).toBe(false)
    // never reported as running: the launch screen closes after the timeout
    await b.call('launch', ['steam:10'])
    tick(STEAM_START_TIMEOUT_MS + 1)
    expect(await b.call('launch_status')).toMatchObject({ phase: 'finished' })
  })

  it('a Steam game that is not installed is handed to Steam to install — not reported as installed', async () => {
    const { b, deps } = bridge()
    await b.call('launch', ['steam:20'])
    expect(deps.install).toHaveBeenCalledWith('steam:20')
    expect(deps.play).not.toHaveBeenCalled()
    const st = (await b.call('launch_status')) as { phase: string; message: string }
    expect(st.phase).toBe('steam')
    expect(st.message).toMatch(/Steam/)
  })

  it('Y on a Steam game toggles the shared favourite; EmuStart-only options refuse Steam ids', async () => {
    const { b, deps } = bridge()
    expect(await b.call('toggle_pin', ['steam:10'])).toMatchObject({ ok: true, favorite: true })
    expect(deps.toggleFavorite).toHaveBeenCalledWith('steam:10')
    expect(await b.call('remove_local', ['steam:10'])).toMatchObject({ ok: false })
  })

  it('keeps working with Steam when the engine is down', async () => {
    const { b, deps } = bridge({ engineReady: () => false, engineMessage: () => 'brak Pythona' })
    const st = (await b.call('get_state')) as { systems: { es: string }[]; engine_down: string }
    expect(st.systems.map((s) => s.es)).toEqual(['steam'])
    expect(st.engine_down).toContain('brak Pythona')
    expect(await b.call('list_games', ['steam'])).toHaveLength(2)
    expect(await b.call('launch_status')).toEqual({ phase: 'idle' })
    expect(await b.call('install_start', [['snes']])).toMatchObject({ ok: false })
    expect(deps.engineCall).not.toHaveBeenCalled()
  })

  it('mode switch, selection and quit go to Lumen', async () => {
    const { b, deps } = bridge()
    await b.call('lumen_mode', ['desktop'])
    expect(deps.setMode).toHaveBeenCalledWith('desktop')
    await b.call('lumen_selected', [7])
    expect(deps.select).toHaveBeenCalledWith('emu:gabc')
    await b.call('quit')
    expect(deps.quit).toHaveBeenCalled()
  })
})

describe('controller in the fullscreen interface', () => {
  const pad = (buttons: number, o = {}) => ({ index: 0, buttons, lt: 0, rt: 0, lx: 0, ly: 0, ...o })
  it('maps XInput to EmuStart actions', () => {
    expect(padActions(pad(0x1000 | 0x0001))).toEqual(['up', 'a'])
    expect(padActions(pad(0, { ly: -30000, rt: 255 }))).toEqual(['down', 'rt'])
    expect(isModeCombo(pad(0x0020 | 0x0010))).toBe(true)
    expect(isModeCombo(pad(0x0010))).toBe(false)
  })
  it('repeats held directions like EmuStart and releases', () => {
    const out: string[] = []
    const r = new PadRepeater((a, up) => out.push(up ? `${a}^` : a))
    r.update(new Set(['down', 'a']), 0)
    r.update(new Set(['down', 'a']), 300)
    r.update(new Set(['down', 'a']), 400)
    r.update(new Set(['down', 'a']), 480)
    r.update(new Set(), 500)
    expect(out).toEqual(['down', 'a', 'down', 'down', 'down^', 'a^'])
  })
})
