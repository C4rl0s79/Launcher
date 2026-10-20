import { stat } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/api'
import type { EmuActionResult, EmuReadiness, EmuSettings, JobsSnapshot } from '@shared/types'
import type { EmustartEngine } from './engine'
import type { EmustartProvider } from './provider'

type Handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) => void

interface Ctx {
  engine: EmustartEngine
  provider: EmustartProvider
  win: () => BrowserWindow | null
  jobs: () => JobsSnapshot
  dataDir: () => string
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

  handle(IPC.emuLaunch, async (gameId: string): Promise<EmuActionResult> => {
    const r = await call<{ ok: boolean; reason?: string; warning?: string; need_install?: { es: string; system: string; steps: string[] }; profile_pin?: boolean }>(
      'launch',
      [idOf(gameId), '', false],
      60_000
    )
    if (r.need_install) return { ok: false, error: `Brak emulatora: ${r.need_install.system}.`, needInstall: r.need_install }
    if (r.profile_pin) return fail(`${r.reason ?? 'Profil wymaga PIN-u lub hasła.'} Odblokuj profil w trybie pełnoekranowym (Menu → Zmień profil).`)
    if (!r.ok) return fail(r.reason ?? 'Nie udało się uruchomić gry.')
    return { ok: true, message: r.warning }
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
