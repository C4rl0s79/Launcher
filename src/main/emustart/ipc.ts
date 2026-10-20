import { stat } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/api'
import type { EmuActionResult, EmuEmulatorOption, EmuLocalState, EmuRemoteState, EmuSaves, EmuSaveSync, EmuOptions, EmuOptionsPatch, EmuReadiness, EmuSettings, JobsSnapshot } from '@shared/types'
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
  if (typeof p.machineProfile === 'number') out.machine_profile = p.machineProfile
  return out
}

const fail = (error: string): EmuActionResult => ({ ok: false, error })

/** Desktop interface → EmuStart engine. Only thin translation; the logic is EmuStart's (api.py). */
export function registerEmustartIpc(handle: Handle, ctx: Ctx): void {
  const { engine, provider } = ctx
  const idOf = (gameId: string): number => {
    const id = provider.engineId(gameId)
    if (id === undefined) throw new Error('Nie ma tej gry w bibliotece EmuStart.')
    return id
  }
  const call = <T>(method: string, args: unknown[] = [], timeout?: number): Promise<T> => engine.call<T>(method, args, timeout)

  handle(IPC.emuLaunch, async (gameId: string, state?: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string; warning?: string; need_install?: { es: string; system: string; steps: string[] }; profile_pin?: boolean }>(
      'launch',
      [idOf(gameId), typeof state === 'string' ? state : '', false],
      60_000
    )
    if (r.need_install) return { ok: false, error: `Brak emulatora: ${r.need_install.system}.`, needInstall: r.need_install }
    if (r.profile_pin) return fail(`${r.reason ?? 'Profil wymaga PIN-u lub hasła.'} Odblokuj profil w trybie pełnoekranowym (Menu → Zmień profil).`)
    if (!r.ok) return fail(r.reason ?? 'Nie udało się uruchomić gry.')
    return { ok: true, message: r.warning }
  })
  handle(IPC.emuSaves, async (gameId: string): Promise<EmuSaves> => {
    const id = idOf(gameId)
    // game_options: states in the emulator's folder of this profile (after taking the newest from the
    // server) and the sync status; save_manager: PS2 states of this PC and the phone (server only)
    const [opts, mgr] = await Promise.all([
      call<{ states?: { path: string; name: string; label?: string; time: number; thumb?: string; resume?: boolean }[]; sync?: EmuSaveSync & { bundles?: unknown[] } }>(
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
  handle(IPC.emuCopyState, async (gameId: string, rel: string, platform: string, emu: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string; same?: boolean; local?: boolean }>('save_copy', [idOf(gameId), String(rel), String(platform), String(emu)], 120_000)
    if (!r.ok) return fail(r.reason ?? 'Nie udało się skopiować.')
    if (r.same) return { ok: true, message: 'Ten stan już tam jest.' }
    return { ok: true, message: platform === 'windows' ? (r.local ? 'Skopiowano — stan jest na liście tego komputera.' : 'Skopiowano — pobierze się przy następnej grze.') : 'Skopiowano — telefon pobierze go przy następnym uruchomieniu gry.' }
  })
  handle(IPC.emuCancelLaunch, () => call('launch_cancel'))
  handle(IPC.emuDismiss, () => call('launch_dismiss'))
  handle(IPC.emuResolve, (choice: string) => {
    if (choice !== 'local' && choice !== 'remote' && choice !== 'skip') throw new Error('Nieznany wybór.')
    return call<boolean>('launch_choice', [choice])
  })
  handle(IPC.emuToggleKeep, async (gameId: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; pinned?: boolean }>('toggle_pin', [idOf(gameId)])
    void provider.refresh()
    if (!r.ok) return fail('Nie udało się zmienić ustawienia gry.')
    return { ok: true, message: r.pinned ? 'Gra zostanie pobrana i zostanie na tym komputerze.' : 'Gra nie jest już trzymana na stałe (wraca do limitu ostatnich gier).' }
  })
  handle(IPC.emuRemoveLocal, async (gameId: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string }>('remove_local', [idOf(gameId)], 60_000)
    void provider.refresh()
    return r.ok ? { ok: true, message: 'Usunięto lokalną kopię. Gra zostaje na serwerze.' } : fail(r.reason ?? 'Nie udało się usunąć.')
  })
  handle(IPC.emuReadiness, (gameId: string) => call<EmuReadiness>('lumen_readiness', [idOf(gameId)], 30_000))
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
