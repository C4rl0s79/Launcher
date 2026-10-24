import { stat } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/api'
import type { EmuServerArt, EmuSettingsChange, EmuGameOptions, EmuActionResult, EmuEmulatorOption, EmuSystemInfo, EmuSystemLogo, EmuLocalState, EmuRemoteState, EmuSaves, EmuSaveSync, EmuOptions, EmuOptionsPatch, EmuReadiness, EmuSettings, JobsSnapshot } from '@shared/types'
import type { EmustartEngine } from './engine'
import type { EmustartProvider } from './provider'

type Handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) => void

interface Ctx {
  engine: EmustartEngine
  provider: EmustartProvider
  win: () => BrowserWindow | null
  jobs: () => JobsSnapshot
  dataDir: () => string
  /** shared settings changed here — refresh the library and the TV interface */
  changed: () => void
  /** a picture served by the engine (state thumbnails) as a data: URL; undefined when missing */
  engineImage: (url: string) => Promise<string | undefined>
  /** server art of a game changed — the interface reloads its images */
  artChanged: (gameId: string) => void
}

/** EmuStart's get_settings → the shared options (engine keys stay in the engine). */
export function toOptions(s: Record<string, unknown>, profiles: { id: number; name: string }[]): EmuOptions {
  const b = (k: string, d = false): boolean => (s[k] === undefined ? d : !!s[k])
  const systems = Array.isArray(s.systems) ? (s.systems as Record<string, unknown>[]) : []
  return {
    hide: { beta: b('hide_beta'), demo: b('hide_demo'), pirate: b('hide_pirate'), unl: b('hide_unl'), program: b('hide_program') },
    arcadeClones: b('hide_arcade_clones', true),
    cacheRecent: Number(s.cache_recent ?? 10),
    streamPlay: b('stream_play', true),
    streamMinSeconds: Number(s.stream_min_seconds ?? 0),
    winfsp: String(s.winfsp ?? ''),
    askProfile: b('ask_profile'),
    profileSettings: b('profile_settings', true),
    gamesLogo: b('games_logo'),
    machineProfile: s.machine_profile === undefined ? undefined : Number(s.machine_profile),
    profiles,
    systems: systems.map((x) => ({
      es: String(x.es),
      display: String(x.display ?? x.es),
      enabled: x.enabled !== false,
      emulator: String(x.label ?? ''),
      known: x.known !== false
    }))
  }
}

/** shared options patch → EmuStart save_settings keys (only these may be changed from here) */
export function toEngineSettings(p: EmuOptionsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p.hide ?? {})) if (typeof v === 'boolean') out[`hide_${k}`] = v
  if (typeof p.arcadeClones === 'boolean') out.hide_arcade_clones = p.arcadeClones
  if (typeof p.cacheRecent === 'number') out.cache_recent = Math.max(1, Math.min(100, Math.round(p.cacheRecent)))
  if (typeof p.streamPlay === 'boolean') out.stream_play = p.streamPlay
  if (typeof p.streamMinSeconds === 'number') out.stream_min_seconds = Math.max(0, Math.min(600, Math.round(p.streamMinSeconds)))
  if (typeof p.askProfile === 'boolean') out.ask_profile = p.askProfile
  if (typeof p.profileSettings === 'boolean') out.profile_settings = p.profileSettings
  if (typeof p.gamesLogo === 'boolean') out.games_logo = p.gamesLogo
  if (p.lookScope === 'profile' || p.lookScope === 'machine') out.look_scope = p.lookScope
  if (typeof p.machineProfile === 'number') out.machine_profile = p.machineProfile
  return out
}

const fail = (error: string): EmuActionResult => ({ ok: false, error })

/** A server address or a login link (emustart://login?d=…) that points only at this computer. */
export function loopbackLogin(text: string): boolean {
  const local = (u: string): boolean => {
    try {
      const h = new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
    } catch {
      return false
    }
  }
  const t = text.trim()
  const m = /^emustart:\/\/login\?d=([A-Za-z0-9_-]+)/.exec(t)
  if (!m) return local(t)
  try {
    const d = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as { e?: { u?: string }[] }
    return !!d.e?.length && d.e.every((e) => !!e.u && local(e.u))
  } catch {
    return false
  }
}

/** Desktop interface → EmuStart engine. Only thin translation; the logic is EmuStart's (api.py). */
export function registerEmustartIpc(handle: Handle, ctx: Ctx): void {
  const { engine, provider } = ctx
  const idOf = (gameId: string): number => {
    const id = provider.engineId(gameId)
    if (id === undefined) throw new Error('Nie ma tej gry w bibliotece EmuStart.')
    return id
  }
  const call = <T>(method: string, args: unknown[] = [], timeout?: number): Promise<T> => engine.call<T>(method, args, timeout)
  /** the version that plays / downloads / is removed: the translation chosen in the profile or the game */
  const playIdOf = (gameId: string): Promise<number> => call<number>('lumen_play_id', [idOf(gameId)])
  const KINDS = new Set(['box', 'snap', 'logo'])
  const kindOf = (k: string): string => {
    if (!KINDS.has(k)) throw new Error('Nieznany rodzaj grafiki.')
    return k
  }
  const done = (r: { ok?: boolean; reason?: string } | null | undefined, msg?: string): EmuActionResult =>
    r?.ok ? { ok: true, message: msg } : fail(r?.reason ?? 'Nie udało się.')

  handle(IPC.emuLaunch, async (gameId: string, state?: string, takeover?: boolean): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string; warning?: string; need_install?: { es: string; system: string; steps: string[] }; profile_pin?: boolean }>(
      'launch',
      [await playIdOf(gameId), typeof state === 'string' ? state : '', takeover === true],
      60_000
    )
    if (r.need_install) return { ok: false, error: `Brak emulatora: ${r.need_install.system}.`, needInstall: r.need_install }
    if (r.profile_pin) return { ok: false, error: r.reason ?? 'Profil wymaga PIN-u lub hasła.', profileLocked: true }
    if (!r.ok) return fail(r.reason ?? 'Nie udało się uruchomić gry.')
    return { ok: true, message: r.warning }
  })
  handle(IPC.emuSaves, async (gameId: string): Promise<EmuSaves> => {
    const id = await playIdOf(gameId)
    // game_options: states in the emulator's folder of this profile (after taking the newest from the
    // server) and the sync status; save_manager: PS2 states of this PC and the phone (server only)
    const [opts, mgr] = await Promise.all([
      call<{ states?: { path: string; arc?: string; name: string; label?: string; time: number; thumb?: string; resume?: boolean; other_core?: string; detail?: string }[]; sync?: EmuSaveSync & { bundles?: unknown[] } }>(
        'game_options',
        [id],
        90_000
      ),
      // the save manager lists PS2 states only — for other systems it has nothing to show
      provider.row(gameId)?.es !== 'ps2'
        ? { ok: true, here: 'windows', states: [] as EmuRemoteState[], reason: undefined as string | undefined }
        : call<{ ok: boolean; reason?: string; here?: string; states?: EmuRemoteState[] }>('save_manager', [id], 90_000).catch(
        (e: Error): { ok: boolean; reason?: string; here?: string; states?: EmuRemoteState[] } => ({ ok: false, reason: e.message })
      )
    ])
    const states: EmuLocalState[] = []
    for (const st of opts?.states ?? []) {
      states.push({
        path: st.path,
        label: st.resume ? 'Kontynuuj (szybki zapis EmuStart)' : st.label || st.name,
        time: st.time,
        resume: st.resume,
        arc: st.arc || undefined,
        otherCore: st.other_core || undefined,
        detail: st.detail || undefined,
        thumb: st.thumb ? await ctx.engineImage(st.thumb) : undefined
      })
    }
    const sync = opts?.sync ?? { state: 'never', last: 0 }
    return {
      sync: { state: sync.state, last: sync.last ?? 0, bundles: Array.isArray(sync.bundles) ? sync.bundles.length : 0 },
      states,
      remote: mgr.ok ? { ok: true, here: mgr.here ?? 'windows', states: mgr.states ?? [] } : { ok: false, reason: mgr.reason ?? 'Nie udało się odczytać zapisów.' }
    }
  })
  handle(IPC.emuPlayOtherCore, async (gameId: string, core: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string; label?: string }>('play_other_core', [await playIdOf(gameId), String(core)], 600_000)
    if (!r.ok) return fail(r.reason ?? 'Nie udało się przełączyć rdzenia.')
    ctx.changed()
    return { ok: true, message: r.label ? `Emulator tej gry: ${r.label}` : undefined }
  })
  handle(IPC.emuCopyState, async (gameId: string, rel: string, platform: string, emu: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string; same?: boolean; local?: boolean }>('save_copy', [await playIdOf(gameId), String(rel), String(platform), String(emu)], 120_000)
    if (!r.ok) return fail(r.reason ?? 'Nie udało się skopiować.')
    if (r.same) return { ok: true, message: 'Ten stan już tam jest.' }
    return { ok: true, message: platform === 'windows' ? (r.local ? 'Skopiowano — stan jest na liście tego komputera.' : 'Skopiowano — pobierze się przy następnej grze.') : 'Skopiowano — telefon pobierze go przy następnym uruchomieniu gry.' }
  })
  handle(IPC.emuSystemInfo, (es: string) => call<EmuSystemInfo>('system_info', [String(es)], 30_000))
  handle(IPC.emuCancelLaunch, () => call('launch_cancel'))
  handle(IPC.emuDismiss, () => call('launch_dismiss'))
  handle(IPC.emuResolve, (choice: string) => {
    if (choice !== 'local' && choice !== 'remote' && choice !== 'skip') throw new Error('Nieznany wybór.')
    return call<boolean>('launch_choice', [choice])
  })
  handle(IPC.emuToggleKeep, async (gameId: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; pinned?: boolean }>('toggle_pin', [await playIdOf(gameId)])
    void provider.refresh()
    if (!r.ok) return fail('Nie udało się zmienić ustawienia gry.')
    return { ok: true, message: r.pinned ? 'Gra zostanie pobrana i zostanie na tym komputerze.' : 'Gra nie jest już trzymana na stałe (wraca do limitu ostatnich gier).' }
  })
  handle(IPC.emuRemoveLocal, async (gameId: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string }>('remove_local', [await playIdOf(gameId)], 60_000)
    void provider.refresh()
    return r.ok ? { ok: true, message: 'Usunięto lokalną kopię. Gra zostaje na serwerze.' } : fail(r.reason ?? 'Nie udało się usunąć.')
  })
  handle(IPC.emuReadiness, async (gameId: string) => call<EmuReadiness>('lumen_readiness', [await playIdOf(gameId)], 30_000))

  // ---- account, login, profiles (both layouts; EmuStart's app.js / options.js flows) ----
  const ACCOUNT: Record<string, { timeout: number; changes?: boolean }> = {
    get_state: { timeout: 30_000 },
    server_enroll: { timeout: 60_000 },
    server_enroll_poll: { timeout: 30_000, changes: true },
    server_enroll_cancel: { timeout: 30_000 },
    server_logout: { timeout: 240_000, changes: true }, // sends the saves first (EmuStart 0.48)
    enroll_pending: { timeout: 30_000 },
    enroll_decide: { timeout: 30_000 },
    account_request: { timeout: 30_000 },
    account_requests_poll: { timeout: 30_000, changes: true },
    profiles_list: { timeout: 30_000 },
    profile_select: { timeout: 60_000, changes: true },
    profile_setup: { timeout: 60_000, changes: true },
    profile_create: { timeout: 60_000, changes: true },
    profile_rename: { timeout: 30_000, changes: true },
    profile_delete: { timeout: 30_000, changes: true },
    profile_join: { timeout: 60_000, changes: true },
    profile_login: { timeout: 60_000, changes: true },
    profile_logout: { timeout: 30_000, changes: true },
    profile_unlock: { timeout: 30_000, changes: true },
    profile_set_pin: { timeout: 30_000 },
    profile_clear_pin: { timeout: 30_000 },
    profile_set_password: { timeout: 60_000 },
    ra_status: { timeout: 30_000 },
    ra_login: { timeout: 60_000 },
    ra_logout: { timeout: 30_000 },
    ra_hardcore: { timeout: 30_000 },
    ra_import: { timeout: 30_000 },
    // in-game menu (A + Y) and controller order — also EmuStart's, used by both layouts
    ingame_poll: { timeout: 5_000 },
    ingame_action: { timeout: 15_000 },
    pads_state: { timeout: 10_000 },
    pads_set: { timeout: 10_000 },
    // settings: emulators, platform options (the name / logo on the server — administrator)
    autodetect: { timeout: 120_000, changes: true },
    install_missing: { timeout: 60_000 },
    art_keys_push: { timeout: 60_000 },
    system_options: { timeout: 30_000 },
    system_set: { timeout: 30_000, changes: true },
    system_logo_choose: { timeout: 60_000, changes: true },
    // TV look editor (EmuStart's look.js): config.json "look", kept with the profile unless look_scope = machine
    look_save: { timeout: 30_000 }
  }
  handle(IPC.emuSystemLogos, async (es: string): Promise<EmuSystemLogo[]> => {
    const list = await call<{ id?: string; url?: string; source?: string; label?: string }[]>('system_logo_candidates', [String(es)], 60_000)
    const out: EmuSystemLogo[] = []
    for (const c of list ?? []) {
      if (!c?.id) continue
      out.push({ id: String(c.id), thumb: (c.url && (await ctx.engineImage(c.url))) || '', source: c.source ?? '', label: c.label })
    }
    return out
  })
  handle(IPC.emuAccount, async (method: string, args: unknown[]) => {
    const spec = ACCOUNT[String(method)]
    if (!spec) throw new Error('Niedozwolone wywołanie silnika.')
    // test mode: logging in only to a local test server — never a real one (20.10.2026 incident)
    if (process.env.LUMEN_DRY_RUN === '1' && method === 'server_enroll' && !loopbackLogin(String((Array.isArray(args) && args[0]) ?? '')))
      throw new Error('Tryb testowy (LUMEN_DRY_RUN=1): logowanie tylko na lokalny serwer testowy (127.0.0.1).')
    const r = await call<Record<string, unknown>>(String(method), Array.isArray(args) ? args : [], spec.timeout)
    // a profile / account change: library, hiding and saves of the new player
    if (spec.changes && r && (r as { ok?: boolean }).ok !== false) ctx.changed()
    return r
  })

  // ---- "Opcje gry" (both layouts; EmuStart's game options: options.js) ----
  handle(IPC.emuGameOptions, async (gameId: string): Promise<EmuGameOptions> => {
    type Raw = {
      ok: boolean
      reason?: string
      play_id: number
      admin: boolean
      states: number
      detail: {
        variants?: { id: number; label: string; lang?: string }[]
        variant?: number
        variant_label?: string
        meta?: Record<string, string>
        meta_edits?: Record<string, string>
        cached?: boolean
        pinned?: boolean
        local?: number
        title?: string
      }
      options: {
        emulator?: { label?: string; exe?: string; args?: string; own?: boolean }
        options?: EmuEmulatorOption[]
        retroarch?: boolean
        shader_off?: boolean
        system?: string
        es?: string
        sync?: EmuSaveSync
      }
    }
    const r = await call<Raw>('lumen_game_options', [idOf(gameId)], 90_000)
    if (!r.ok) throw new Error(r.reason ?? 'Nie udało się odczytać opcji gry.')
    const d = r.detail
    const o = r.options
    const meta: Record<string, string> = { ...(d.meta ?? {}) }
    if (!meta.title && d.title) meta.title = d.title
    return {
      playId: r.play_id,
      variants: d.variants ?? [],
      variant: d.variant ?? 0,
      variantLabel: d.variant_label ?? '',
      meta,
      metaEdits: d.meta_edits ?? {},
      cached: !!d.cached,
      pinned: !!d.pinned,
      local: d.local ?? 0,
      emulator: { label: o.emulator?.label ?? '', exe: o.emulator?.exe ?? '', args: o.emulator?.args ?? '', own: !!o.emulator?.own },
      emulators: o.options ?? [],
      retroarch: !!o.retroarch,
      shaderOff: !!o.shader_off,
      system: o.system ?? '',
      es: o.es ?? '',
      sync: o.sync ?? { state: 'never', last: 0 },
      states: r.states ?? 0,
      admin: !!r.admin
    }
  })
  handle(IPC.emuSetVariant, async (gameId: string, variantId: number): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string; label?: string }>('set_variant', [idOf(gameId), Number(variantId) || 0])
    if (r.ok) ctx.changed()
    return done(r, r.ok ? (variantId ? `Grasz w: ${r.label}. Zapisy tej wersji są osobne od oryginału.` : 'Grasz w oryginał.') : undefined)
  })
  handle(IPC.emuSetGameEmulator, async (gameId: string, e: EmuEmulatorOption | null): Promise<EmuActionResult> => {
    const opt = e ? { label: String(e.label), exe: String(e.exe), args: String(e.args ?? '') } : null
    const r = await call<{ ok: boolean; reason?: string }>('set_game_emulator', [idOf(gameId), opt])
    return done(r, opt ? `Ta gra: ${opt.label}` : 'Gra używa emulatora systemu.')
  })
  handle(IPC.emuConfigure, async (gameId: string): Promise<EmuActionResult> =>
    done(await call<{ ok: boolean; reason?: string }>('configure_emulator', [await playIdOf(gameId)], 60_000), 'Zmień ustawienia i zamknij emulator — zapiszą się w Twoim profilu.')
  )
  handle(IPC.emuSettingsHistory, async (gameId: string): Promise<EmuSettingsChange[]> => {
    const r = await call<{ ok: boolean; list?: EmuSettingsChange[] }>('emu_settings_history', [idOf(gameId)])
    return r.ok ? (r.list ?? []) : []
  })
  handle(IPC.emuSettingsRestore, async (gameId: string, hid: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string; files?: number }>('emu_settings_restore', [idOf(gameId), String(hid)])
    return done(r, `Przywrócono ustawienia (${r.files ?? 0} plików) — działają od następnej gry.`)
  })
  handle(IPC.emuShaderOff, async (es: string, off: boolean): Promise<EmuActionResult> =>
    done(await call<{ ok: boolean }>('set_shader_off', [String(es), !!off]), off ? 'Gry tego systemu bez shadera.' : 'Shader jak w ustawieniach RetroArcha.')
  )
  handle(IPC.emuMetaSave, async (gameId: string, edits: Record<string, string>): Promise<EmuActionResult> => {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(edits ?? {})) if (typeof v === 'string') clean[k] = v
    const r = await call<{ ok: boolean; reason?: string }>('meta_save', [idOf(gameId), clean], 30_000)
    if (r.ok) ctx.changed()
    return done(r, 'Zapisano na serwerze.')
  })
  handle(IPC.emuMetaFetch, async (gameId: string): Promise<EmuActionResult> =>
    done(await call<{ ok: boolean; reason?: string }>('meta_fetch_full', [idOf(gameId)], 30_000), 'Serwer pobiera opis — pojawi się za chwilę.')
  )
  handle(IPC.emuServerArt, async (gameId: string, kind: string, q?: string): Promise<EmuServerArt[]> => {
    const list = await call<{ url: string; thumb?: string; source?: string; width?: number; height?: number }[]>('art_candidates', [idOf(gameId), kindOf(kind), String(q ?? '')], 60_000)
    const out: EmuServerArt[] = []
    for (const c of list ?? []) {
      if (!c?.url) continue
      out.push({ url: c.url, thumb: (c.thumb && (await ctx.engineImage(c.thumb))) || '', source: c.source, width: c.width, height: c.height })
    }
    return out
  })
  handle(IPC.emuServerArtChoose, async (gameId: string, kind: string, url: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string }>('art_choose', [idOf(gameId), kindOf(kind), String(url)], 60_000)
    if (r.ok) ctx.artChanged(gameId)
    return done(r, 'Zapisano na serwerze — widać na wszystkich urządzeniach.')
  })
  handle(IPC.emuServerArtClear, async (gameId: string, kind: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string }>('art_clear', [idOf(gameId), kindOf(kind)], 30_000)
    if (r.ok) ctx.artChanged(gameId)
    return done(r, 'Usunięto grafikę na serwerze.')
  })
  handle(IPC.emuInstall, async (systems: string[]): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string }>('install_start', [systems.filter((s) => typeof s === 'string')], 60_000)
    return r.ok ? { ok: true, message: 'Pobieranie emulatora z serwera EmuStart rozpoczęte.' } : fail(r.reason ?? 'Nie udało się rozpocząć pobierania.')
  })
  const settings = async (): Promise<EmuSettings> => {
    const s = await call<Record<string, unknown>>('get_settings', [], 30_000)
    const p = await call<{ profiles: { id: number; name: string }[]; current: number }>('profiles_list', [], 30_000).catch(() => null)
    // the device key (server_key) never leaves the engine
    return {
      dataDir: ctx.dataDir(),
      emuRoot: String(s.emu_root ?? ''),
      cacheDir: String(s.cache_dir ?? ''),
      cacheRecent: Number(s.cache_recent ?? 10),
      account: (s.server_account as string) || undefined,
      serverVia: (s.server_via as string) || undefined,
      enroll: (s.enroll as EmuSettings['enroll']) ?? null,
      profiles: (p?.profiles ?? []).map((x) => ({ id: x.id, name: x.name })),
      profileId: p?.current
    }
  }
  handle(IPC.emuSettings, settings)
  handle(IPC.emuSetFolder, async (key: 'emu_root' | 'cache_dir', folder: string): Promise<EmuSettings> => {
    if (key !== 'emu_root' && key !== 'cache_dir') throw new Error('Nieznane ustawienie.')
    const st = await stat(String(folder)).catch(() => null)
    if (!st?.isDirectory()) throw new Error('Wybrany folder nie istnieje.')
    await call('save_settings', [{ [key]: folder }])
    void provider.refresh()
    return settings()
  })
  const options = async (): Promise<EmuOptions> => {
    const s = await call<Record<string, unknown>>('get_settings', [], 30_000)
    const p = await call<{ profiles: { id: number; name: string }[] }>('profiles_list', [], 30_000).catch(() => null)
    return toOptions(s, (p?.profiles ?? []).map((x) => ({ id: x.id, name: x.name })))
  }
  handle(IPC.emuOptions, options)
  handle(IPC.emuSetOptions, async (patch: EmuOptionsPatch) => {
    const data = toEngineSettings(patch ?? {})
    if (Object.keys(data).length) {
      await call('save_settings', [data], 30_000)
      ctx.changed()
    }
    return options()
  })
  handle(IPC.emuEmulatorOptions, (es: string) => call<EmuEmulatorOption[]>('emulator_options', [String(es)], 60_000))
  handle(IPC.emuSetSystem, async (es: string, change: { enabled?: boolean; emulator?: EmuEmulatorOption }) => {
    const sc: Record<string, unknown> = {}
    if (typeof change?.enabled === 'boolean') sc.enabled = change.enabled
    if (change?.emulator) {
      // only an emulator EmuStart itself found for this system on this PC
      const found = await call<EmuEmulatorOption[]>('emulator_options', [String(es)], 60_000)
      const o = found.find((x) => x.exe === change.emulator!.exe && x.args === change.emulator!.args)
      if (!o) throw new Error('Nie ma takiego emulatora dla tego systemu.')
      Object.assign(sc, { label: o.label, exe: o.exe, args: o.args, enabled: true })
    }
    if (Object.keys(sc).length) {
      await call('save_settings', [{ systems: { [String(es)]: sc } }], 30_000)
      ctx.changed()
    }
    return options()
  })
  handle(IPC.emuRefresh, async (): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean }>('rescan')
    return r.ok ? { ok: true, message: 'Odświeżanie biblioteki z serwera…' } : fail('Odświeżanie biblioteki już trwa.')
  })
  handle(IPC.emuRestart, () => engine.restart())
  handle(IPC.emuClearConflicts, () => call('lumen_conflicts_clear'))

  handle(IPC.jobsGet, () => ctx.jobs())
  handle(IPC.jobsCancel, async (jobId: string): Promise<EmuActionResult> => {
    if (jobId === 'emu:launch') {
      await call('launch_cancel')
      return { ok: true }
    }
    if (jobId === 'emu:install') {
      await call('install_cancel')
      return { ok: true }
    }
    const m = /^emu:copy:(\d+)$/.exec(jobId)
    if (m) {
      const row = provider.rowByEngineId(Number(m[1]))
      if (!row) return fail('Nie ma tej gry w bibliotece EmuStart.')
      // a kept game: stop keeping it (the partial download stays and resumes next time);
      // otherwise the background copy after a launch: remove the partial copy
      const r = row.pinned
        ? await call<{ ok: boolean }>('toggle_pin', [row.id])
        : await call<{ ok: boolean; reason?: string }>('remove_local', [row.id], 60_000)
      void provider.refresh()
      return r.ok ? { ok: true, message: 'Pobieranie zatrzymane.' } : fail('Nie udało się zatrzymać pobierania.')
    }
    if (jobId.startsWith('steam:')) return fail('Pobieraniem gier Steam zarządza klient Steam — użyj okna pobierania Steam.')
    return fail('Tego zadania nie można anulować.')
  })
}
