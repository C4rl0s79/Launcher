import type { Game, Job } from '@shared/types'
import type { EmuStatusRaw } from '../emustart/provider'

// One task list for both interfaces. Every job is derived from the state reported by the
// integration that actually runs it — nothing is simulated:
//  - Steam downloads: install state and byte counters from Steam's appmanifest files (Steam
//    manages the download; Lumen can only show it and open Steam's download window),
//  - EmuStart: launch session, cache copies, emulator installs and save uploads from the engine.

export const LAUNCH_PHASE: Record<string, string> = {
  preparing: 'Przygotowanie',
  downloading: 'Pobieranie z serwera',
  extracting: 'Rozpakowywanie',
  running: 'Gra uruchomiona',
  finished: 'Koniec gry',
  error: 'Błąd uruchamiania',
  conflict: 'Konflikt zapisów — wybierz wersję',
  cancelled: 'Pobieranie przerwane'
}

const STEAM_PHASE: Partial<Record<Game['installState'], string>> = {
  installing: 'Instalacja w Steam',
  updating: 'Aktualizacja w Steam',
  updatePaused: 'Wstrzymane w Steam'
}

export function steamJobs(games: Game[]): Job[] {
  const out: Job[] = []
  for (const g of games) {
    if (g.source !== 'steam') continue
    const phase = STEAM_PHASE[g.installState]
    if (!phase) continue
    const p = g.progress
    const total = p ? p.bytesToDownload || p.bytesToStage : 0
    const done = p ? (p.bytesToDownload ? p.bytesDownloaded : p.bytesStaged) : 0
    out.push({
      id: `steam:${g.appId}`,
      kind: 'steamDownload',
      source: 'steam',
      gameId: g.id,
      title: g.name,
      phase,
      state: g.installState === 'updatePaused' ? 'queued' : 'active',
      progress: total > 0 ? { done, total } : undefined,
      message: total > 0 ? undefined : 'Steam nie podaje jeszcze postępu (kolejka pobierania Steam).',
      cancellable: false,
      managedBySteam: true
    })
  }
  return out
}

export function emuJobs(st: EmuStatusRaw | null, lumenIdOf: (engineId: number) => string | undefined): Job[] {
  if (!st) return []
  const out: Job[] = []
  const l = st.launch
  if (l && l.phase && l.phase !== 'idle') {
    const p = l.progress
    const showProgress = p && (l.phase === 'downloading' || l.phase === 'extracting' || (l.phase === 'running' && l.copying))
    out.push({
      id: 'emu:launch',
      kind: 'emuLaunch',
      source: 'emustart',
      gameId: l.game_id !== undefined ? lumenIdOf(l.game_id) : undefined,
      title: l.title ?? '',
      phase: l.mode === 'config' && l.phase === 'running' ? 'Ustawienia emulatora' : (LAUNCH_PHASE[l.phase] ?? l.phase),
      state:
        l.phase === 'error'
          ? 'error'
          : l.phase === 'cancelled'
            ? 'cancelled'
            : l.phase === 'finished'
              ? 'done'
              : l.phase === 'running'
                ? 'running'
                : l.phase === 'conflict'
                  ? 'waiting'
                  : 'active',
      progress: showProgress && p ? { done: p.done, total: p.total, speed: p.speed, eta: p.eta } : undefined,
      message: l.message || undefined,
      cancellable: l.phase === 'downloading'
    })
  }
  for (const c of st.copies) {
    out.push({
      id: `emu:copy:${c.game_id}`,
      kind: 'emuDownload',
      source: 'emustart',
      gameId: lumenIdOf(c.game_id),
      title: c.title,
      phase: 'Pobieranie do pamięci podręcznej',
      state: 'active',
      progress: { done: c.done, total: c.total, speed: c.speed, eta: c.eta },
      cancellable: true
    })
  }
  // emulator downloads from the server (installer.Job.status); finished ones drop off the list —
  // the game's readiness check shows what is still missing
  for (const [key, j, label, cancellable] of [
    ['install', st.install, 'Instalacja emulatorów z serwera', true],
    ['emusync', st.emu_sync, 'Aktualizacja emulatorów z serwera', false]
  ] as const) {
    if (!j?.running) continue
    out.push({
      id: `emu:${key}`,
      kind: 'emuInstall',
      source: 'emustart',
      title: j.current || label,
      phase: j.steps && j.steps > 1 ? `${label} (${j.step}/${j.steps})` : label,
      state: 'active',
      progress: j.total ? { done: j.done ?? 0, total: j.total } : undefined,
      cancellable
    })
  }
  if (st.post) {
    out.push({
      id: 'emu:saves',
      kind: 'saveUpload',
      source: 'emustart',
      title: st.post,
      phase: 'Wysyłanie zapisów na serwer',
      state: 'active',
      cancellable: false
    })
  }
  if (st.scan?.running) {
    out.push({
      id: 'emu:scan',
      kind: 'libraryRefresh',
      source: 'emustart',
      title: st.scan.text || 'Biblioteka z serwera',
      phase: 'Odświeżanie biblioteki',
      state: 'active',
      progress: st.scan.total ? { done: st.scan.done, total: st.scan.total } : undefined,
      cancellable: false
    })
  }
  return out
}
