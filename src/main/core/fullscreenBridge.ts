import type { ActionResult, DetailsResult, Game, Job, SteamClientStatus, UpdateState } from '@shared/types'

// The fullscreen interface is EmuStart's own UI (engine/web) running in Lumen's window. It talks
// to `window.pywebview.api` — with `?lumen` that proxy calls Lumen's main process, which ends up
// here. EmuStart methods go to the engine unchanged; Steam games appear as one more system,
// "Steam", whose actions are answered by Lumen's Steam integration (the same code the desktop
// interface uses). Nothing here downloads, launches or syncs on its own.

export const STEAM_ES = 'steam'

export interface BridgeDeps {
  engineReady(): boolean
  engineMessage(): string | undefined
  engineCall(method: string, args: unknown[]): Promise<unknown>
  steamGames(): Game[]
  steamStatus(): SteamClientStatus
  /** lumen-art:// address of a game's image */
  artUrl(gameId: string, kind: 'grid' | 'hero' | 'logo'): string
  steamDetails(gameId: string): Promise<DetailsResult>
  play(gameId: string): Promise<ActionResult>
  install(gameId: string): Promise<ActionResult>
  openInSteam(gameId: string, view: 'details' | 'store' | 'downloads'): Promise<ActionResult>
  toggleFavorite(gameId: string): Promise<boolean>
  isFavorite(gameId: string): boolean
  runningAppId(): number | undefined
  steamJobs(): Job[]
  setMode(mode: 'desktop' | 'fullscreen'): void
  select(gameId: string | null): void
  /** Lumen id of an EmuStart engine game number */
  emuLumenId(engineId: number): string | undefined
  quit(): void
  log(msg: string): void
  /** EmuStart settings / profile changed from the TV interface (the desktop library re-reads) */
  onEmuChanged?: () => void
  /** Lumen's own updater (TV menu "Aktualizuj Lumen" — EmuStart's update screens, Lumen's update) */
  updater?: { state: UpdateState; check(): Promise<UpdateState>; download(): Promise<UpdateState>; apply(): Promise<UpdateState> }
  now?: () => number
}

const isSteamId = (id: unknown): id is string => typeof id === 'string' && id.startsWith('steam:')

/** EmuStart launch session for a Steam game (Steam itself starts the game). */
interface SteamSession {
  gameId: string
  title: string
  appId: number
  kind: 'play' | 'install'
  startedAt: number
  seenRunning: boolean
  message?: string
  error?: string
}

/** How long to wait for Steam to report the game as running before closing the launch screen. */
export const STEAM_START_TIMEOUT_MS = 30_000

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function steamStatusLabel(g: Game, steam: SteamClientStatus): string {
  if (steam === 'notInstalled') return 'Steam nie jest zainstalowany'
  if (g.running) return 'gra działa'
  switch (g.installState) {
    case 'installed':
      return 'zainstalowana (Steam)'
    case 'updateRequired':
      return 'wymaga aktualizacji (Steam)'
    case 'installing':
      return 'instaluje się w Steam'
    case 'updating':
      return 'aktualizuje się w Steam'
    case 'updatePaused':
      return 'pobieranie wstrzymane w Steam'
    case 'uninstalling':
      return 'odinstalowywanie'
    case 'broken':
      return 'wymaga naprawy w Steam'
    default:
      return 'niezainstalowana — instalacja przez Steam'
  }
}

export function createFullscreenBridge(deps: BridgeDeps) {
  const now = deps.now ?? Date.now
  let steamSession: SteamSession | null = null

  const steamList = (): Game[] => deps.steamGames().filter((g) => g.source === 'steam')
  const steamGame = (id: string): Game | undefined => steamList().find((g) => g.id === id)

  function steamSystem(): Record<string, unknown> | null {
    const games = steamList()
    if (!games.length) return null
    return {
      es: STEAM_ES,
      display: 'Steam',
      games: games.length,
      cached: games.filter((g) => g.installed).length,
      logo: '',
      logo_glow: false,
      emulator: deps.steamStatus() === 'notInstalled' ? 'brak klienta Steam' : 'klient Steam',
      kind: 'pc',
      source: 'steam'
    }
  }

  function withSteam(systems: unknown): unknown[] {
    const list = Array.isArray(systems) ? systems : []
    const s = steamSystem()
    return s ? [s, ...list] : list
  }

  function steamRow(g: Game): Record<string, unknown> {
    return {
      id: g.id,
      name: g.name,
      title: g.name,
      tags: '',
      size: g.sizeOnDisk ?? 0,
      is_dir: 0,
      parent: '',
      art_box: 1,
      art_snap: 1,
      art_logo: 1,
      cached: g.installed ? 1 : 0,
      pinned: deps.isFavorite(g.id) ? 1 : 0,
      last: g.lastPlayed ?? 0,
      seconds: (g.playtimeMinutes ?? 0) * 60,
      favorite: deps.isFavorite(g.id) ? 1 : 0,
      genre: '',
      year: '',
      players: '',
      developer: '',
      publisher: '',
      regions: [],
      box: deps.artUrl(g.id, 'grid'),
      snap: deps.artUrl(g.id, 'hero'),
      logo: deps.artUrl(g.id, 'logo'),
      source: 'steam',
      installing: g.installState === 'installing' || g.installState === 'updating'
    }
  }

  async function steamDetail(id: string): Promise<Record<string, unknown>> {
    const g = steamGame(id)
    if (!g) return {}
    const d = await deps.steamDetails(id).catch(() => null)
    const det = d?.ok ? d.details : undefined
    const meta: Record<string, string> = {}
    const desc = det?.descriptionHtml ? stripHtml(det.descriptionHtml) : (det?.descriptionText ?? det?.shortDescription ?? '')
    if (desc) meta.description = desc
    if (det?.developers?.length) meta.developer = det.developers.join(', ')
    if (det?.publishers?.length) meta.publisher = det.publishers.join(', ')
    if (det?.releaseDate) meta.year = det.releaseDate
    if (det?.genres?.length) meta.genre = det.genres.join(', ')
    if (det?.players) meta.players = det.players
    return {
      id: g.id,
      title: g.name,
      tags: '',
      name: g.name,
      meta,
      meta_online: true,
      meta_edits: {},
      system: 'Steam',
      size: g.sizeOnDisk ?? 0,
      files: 1,
      file: '',
      cached: g.installed,
      local: g.sizeOnDisk ?? 0,
      pinned: deps.isFavorite(g.id),
      plays: 0,
      seconds: (g.playtimeMinutes ?? 0) * 60,
      last: g.lastPlayed ?? 0,
      copying: g.installState === 'installing' || g.installState === 'updating',
      es: STEAM_ES,
      rel: '',
      variants: [],
      variant: 0,
      variant_label: '',
      source: 'steam',
      steam_status: steamStatusLabel(g, deps.steamStatus()),
      favorite: deps.isFavorite(g.id)
    }
  }

  async function steamLaunch(id: string): Promise<Record<string, unknown>> {
    const g = steamGame(id)
    if (!g) return { ok: false, reason: 'Nie ma tej gry w bibliotece Steam.' }
    if (deps.steamStatus() === 'notInstalled') return { ok: false, reason: 'Nie znaleziono klienta Steam na tym komputerze.' }
    const installed = g.installState === 'installed' || g.installState === 'updateRequired'
    const r = installed ? await deps.play(id) : g.installState === 'notInstalled' ? await deps.install(id) : await deps.openInSteam(id, 'downloads')
    if (!r.ok) return { ok: false, reason: r.error }
    steamSession = {
      gameId: id,
      title: g.name,
      appId: g.appId,
      kind: installed ? 'play' : 'install',
      startedAt: now(),
      seenRunning: false,
      message: r.message
    }
    return { ok: true }
  }

  function steamLaunchStatus(s: SteamSession): Record<string, unknown> {
    const base = { game_id: s.gameId, title: s.title, system: 'Steam', source: 'steam' }
    if (s.kind === 'install') {
      const g = steamGame(s.gameId)
      return {
        ...base,
        phase: 'steam',
        message:
          g && (g.installState === 'installing' || g.installState === 'updating')
            ? 'Steam pobiera grę. Postęp widać na pasku u góry (⬇) i w oknie pobierania Steam.'
            : (s.message ?? 'Steam otworzy okno instalacji — potwierdź tam lokalizację. Instalacją zarządza klient Steam.')
      }
    }
    const running = deps.runningAppId() === s.appId
    if (running) s.seenRunning = true
    if (s.seenRunning && !running) return { ...base, phase: 'finished' }
    if (!s.seenRunning && now() - s.startedAt > STEAM_START_TIMEOUT_MS)
      return { ...base, phase: 'finished', message: 'Steam nie zgłosił uruchomienia gry.' }
    return s.seenRunning
      ? { ...base, phase: 'running', message: 'Gra działa (uruchomiona przez Steam).' }
      : { ...base, phase: 'preparing', message: s.message ?? 'Uruchamianie przez Steam…' }
  }

  function steamCopies(): Record<string, unknown>[] {
    return deps.steamJobs().map((j) => ({
      game_id: j.gameId,
      title: `Steam: ${j.title}`,
      done: j.progress?.done ?? 0,
      total: j.progress?.total ?? 0,
      eta: null,
      steam: true
    }))
  }

  /** Answers for EmuStart methods while the engine is not running (Steam keeps working). */
  function offline(name: string): unknown {
    const why = `Silnik EmuStart nie działa${deps.engineMessage() ? `: ${deps.engineMessage()}` : '.'}`
    switch (name) {
      case 'get_state':
        return {
          version: '',
          configured: true,
          server: null,
          lib_version: 0,
          admin: false,
          account: '',
          systems: withSteam([]),
          scan: { running: false, text: '', done: 0, total: 0, result: null },
          cache: { games: 0, bytes: 0, pinned: 0 },
          copying: [],
          py_pad: false,
          pad_backend: 'none',
          games_logo: false,
          look: {},
          setup_needed: false,
          ask_profile: false,
          conflicts: [],
          profile: null,
          profiles: 0,
          engine_down: why
        }
      case 'list_systems':
        return withSteam([])
      case 'list_games':
        return []
      case 'system_info':
      case 'game_detail':
      case 'game_options':
        return {}
      case 'art_for':
        return {}
      case 'post_status':
        return ''
      case 'copy_status':
        return steamCopies()
      case 'launch_status':
        return { phase: 'idle' }
      case 'emu_sync_status':
      case 'install_status':
        return null
      case 'ingame_poll':
        return { open: false, inputs: [] }
      case 'ui_pad_poll':
        return []
      case 'enroll_pending':
        return { requests: [] }
      case 'server_enroll_poll':
        return { status: 'none' }
      case 'account_requests_poll':
        return { done: [] }
      case 'profile_pin_check':
        return { state: 'ok' }
      case 'request_art':
      case 'launch_dismiss':
      case 'launch_cancel':
      case 'menu_input':
        return null
      case 'get_settings':
        return { systems: [], engine_down: why }
      default:
        return { ok: false, reason: why }
    }
  }

  async function engine(name: string, args: unknown[]): Promise<unknown> {
    if (!deps.engineReady()) return offline(name)
    return deps.engineCall(name, args)
  }

  async function call(name: string, args: unknown[] = []): Promise<unknown> {
    const a0 = args[0]
    switch (name) {
      // ── Lumen additions used by the patched UI ──
      case 'lumen_mode':
        deps.setMode(a0 === 'fullscreen' ? 'fullscreen' : 'desktop')
        return null
      case 'lumen_selected': {
        if (a0 === null || a0 === undefined) deps.select(null)
        else if (isSteamId(a0)) deps.select(a0)
        else if (typeof a0 === 'number') deps.select(deps.emuLumenId(a0) ?? null)
        return null
      }
      case 'steam_action': {
        const id = String(a0 ?? '')
        const action = String(args[1] ?? '')
        if (!steamGame(id)) return { ok: false, reason: 'Nie ma tej gry w bibliotece Steam.' }
        if (action === 'favorite') return { ok: true, favorite: await deps.toggleFavorite(id) }
        if (action === 'details' || action === 'store' || action === 'downloads') {
          const r = await deps.openInSteam(id, action)
          return r.ok ? { ok: true } : { ok: false, reason: r.error }
        }
        if (action === 'install') {
          const r = await deps.install(id)
          return r.ok ? { ok: true, message: r.message } : { ok: false, reason: r.error }
        }
        return { ok: false, reason: 'Nieznana akcja.' }
      }

      // ── update: EmuStart's update flow (app.js appUpdate) drives Lumen's updater ──
      case 'app_update_check': {
        if (!deps.updater) return { ok: false, reason: 'Aktualizacja niedostępna.' }
        const s = await deps.updater.check()
        if (s.phase === 'error') return { ok: false, reason: s.error }
        const i = s.info
        return {
          ok: true,
          newer: !!i?.newer,
          available: !!i?.file,
          version: i?.version ?? '',
          current: i?.current ?? '',
          size: i?.file?.size ?? 0,
          reason: s.error
        }
      }
      case 'app_update_start': {
        if (!deps.updater) return { ok: false }
        if (deps.updater.state.phase !== 'ready') void deps.updater.download()
        return { ok: true }
      }
      case 'app_update_status': {
        const s = deps.updater?.state
        if (!s) return null
        const phase = s.phase === 'downloading' ? 'downloading' : s.phase === 'verifying' || s.phase === 'extracting' ? 'extracting' : s.phase === 'ready' ? 'ready' : s.phase === 'error' ? 'error' : s.phase
        return { phase, done: s.done, total: s.total, version: s.info?.version ?? '', error: s.error ?? '' }
      }
      case 'app_update_apply': {
        if (!deps.updater) return { ok: false }
        const s = await deps.updater.apply()
        return s.phase === 'applying' ? { ok: true } : { ok: false, reason: s.error }
      }

      // ── window / host ──
      case 'quit':
        deps.quit()
        return null
      case 'pick_folder':
        // Windows dialog needs a mouse — in Lumen folders are chosen with EmuStart's folder browser (pad)
        return ''
      case 'ui_log':
        deps.log(String(a0 ?? ''))
        return null

      // ── systems and games: Steam is one more system ──
      case 'get_state': {
        const st = (await engine(name, args)) as Record<string, unknown>
        const copying = [...((st.copying as unknown[]) ?? []), ...deps.steamJobs().map((j) => j.gameId)]
        return { ...st, systems: deps.engineReady() ? withSteam(st.systems) : st.systems, copying }
      }
      case 'list_systems':
        return deps.engineReady() ? withSteam(await engine(name, args)) : offline(name)
      case 'list_games':
        return a0 === STEAM_ES ? steamList().map(steamRow) : engine(name, args)
      case 'system_info':
        if (a0 === STEAM_ES)
          return {
            manufacturer: 'Valve',
            description:
              'Gry z biblioteki Steam. Instalacją, aktualizacjami, uruchamianiem i synchronizacją zapisów (Steam Cloud) zarządza klient Steam.'
          }
        return engine(name, args)
      case 'game_detail':
        return isSteamId(a0) ? steamDetail(a0) : engine(name, args)
      case 'request_art': {
        const ids = Array.isArray(a0) ? a0.filter((x) => !isSteamId(x)) : []
        return ids.length ? engine(name, [ids, ...args.slice(1)]) : null
      }
      case 'art_for': {
        const ids = Array.isArray(a0) ? a0 : []
        const emu = ids.filter((x) => !isSteamId(x))
        const out = (emu.length ? ((await engine(name, [emu])) as Record<string, unknown>) : {}) ?? {}
        for (const id of ids.filter(isSteamId))
          out[id] = { box: deps.artUrl(id, 'grid'), snap: deps.artUrl(id, 'hero'), logo: deps.artUrl(id, 'logo'), checked: true }
        return out
      }
      case 'meta_fetch':
        return isSteamId(a0) ? null : engine(name, args)
      case 'toggle_pin':
        if (isSteamId(a0)) {
          // "keep locally" has no Steam equivalent — Y toggles the favourite instead (shared with the desktop view)
          const fav = await deps.toggleFavorite(a0)
          return { ok: true, pinned: fav, favorite: fav }
        }
        return engine(name, args)
      case 'game_options':
      case 'configure_emulator':
      case 'remove_local':
      case 'set_variant':
      case 'save_manager':
      case 'ra_states':
        return isSteamId(a0) ? { ok: false, reason: 'Ta opcja dotyczy tylko gier z serwera EmuStart.' } : engine(name, args)

      // ── launch: Steam games through Steam, the rest through the engine ──
      case 'launch':
        if (isSteamId(a0)) return steamLaunch(a0)
        steamSession = null
        return engine(name, args)
      case 'launch_status':
        return steamSession ? steamLaunchStatus(steamSession) : engine(name, args)
      case 'launch_cancel':
      case 'launch_dismiss':
        if (steamSession) {
          steamSession = null
          return null
        }
        return engine(name, args)
      case 'ingame_poll':
        return steamSession ? { open: false, inputs: [] } : engine(name, args)
      case 'copy_status': {
        const emu = (await engine(name, args)) as unknown[]
        return [...(Array.isArray(emu) && deps.engineReady() ? emu : []), ...steamCopies()]
      }
      case 'save_settings':
      case 'system_set':
      case 'set_game_emulator':
      case 'profile_select':
      case 'profile_login':
      case 'profile_unlock': {
        const r = await engine(name, args)
        deps.onEmuChanged?.()
        return r
      }
      default:
        return engine(name, args)
    }
  }

  return { call, steamSessionActive: () => !!steamSession }
}
