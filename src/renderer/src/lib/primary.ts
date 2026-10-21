import { useEffect, useMemo, useState } from 'react'
import type { EmuReadiness, EmustartSummary, Game } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { formatBytes } from './format'

// The one main action of a game (Graj / Zainstaluj / Pobierz i graj / Zainstaluj emulator…) for both
// layouts — desktop details and the TV game list — so it behaves the same everywhere.

export interface PrimaryAction {
  label: string
  run?: () => Promise<void>
  disabled?: boolean
  note?: string
}

export function usePrimaryAction(game: Game | undefined): { primary: PrimaryAction | null; busy: boolean; ready: EmuReadiness | null } {
  const steamStatus = useStore((s) => s.snapshot?.steam.status)
  const emuSummary = useStore((s) => s.snapshot?.emustart)
  const installing = useStore((s) => s.jobs.jobs.some((j) => j.kind === 'emuInstall'))
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState<EmuReadiness | null>(null)
  const isEmu = game?.source === 'emustart'
  const gameId = game?.id

  // EmuStart: what is missing before the game can start (emulator) — re-checked after installs
  useEffect(() => {
    setReady(null)
    if (!isEmu || !gameId || emuSummary?.engine !== 'ready' || installing) return
    let alive = true
    void api()
      .emustart.readiness(gameId)
      .then((r) => alive && setReady(r))
      .catch(() => alive && setReady(null))
    return () => {
      alive = false
    }
  }, [isEmu, gameId, emuSummary?.engine, installing])

  const primary = useMemo<PrimaryAction | null>(() => {
    if (!game) return null
    const wrap = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => async () => {
      setBusy(true)
      const r = await attempt(fn())
      setBusy(false)
      if (r) useStore.getState().toast(r.ok ? (r.message ?? 'Gotowe') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error')
    }
    if (game.source === 'demo') return { label: 'Gra demonstracyjna', disabled: true, note: 'Dane demonstracyjne — akcje są wyłączone.' }
    if (game.emu) return emuPrimary(game, emuSummary, ready, installing, setBusy)
    if (steamStatus === 'notInstalled') return { label: 'Steam niedostępny', disabled: true, note: 'Nie znaleziono klienta Steam na tym komputerze.' }
    const play = wrap(() => api().game.play(game.id))
    const downloads = wrap(() => api().game.openInSteam(game.id, 'downloads'))
    const steamNote = steamStatus === 'notRunning' ? 'Steam jest wyłączony — zostanie uruchomiony automatycznie.' : undefined
    switch (game.installState) {
      case 'installed':
        return { label: game.running ? 'Gra działa' : 'Graj', run: play, note: game.running ? 'Steam zgłasza, że gra jest uruchomiona.' : steamNote }
      case 'updateRequired':
        return { label: 'Graj', run: play, note: 'Steam zainstaluje aktualizację przed uruchomieniem.' }
      case 'notInstalled':
        return { label: 'Zainstaluj', run: wrap(() => api().game.install(game.id)), note: steamNote ?? 'Instalację przeprowadzi klient Steam.' }
      case 'installing':
      case 'updating':
        return { label: 'Pokaż pobieranie w Steam', run: downloads }
      case 'updatePaused':
        return { label: 'Wznów w Steam', run: downloads, note: 'Pobieranie jest wstrzymane w kliencie Steam.' }
      case 'uninstalling':
        return { label: 'Odinstalowywanie…', disabled: true }
      case 'broken':
        if (game.shortcut)
          return { label: 'Brak programu', disabled: true, note: `Nie znaleziono pliku: ${game.shortcut.exe}` }
        return {
          label: 'Otwórz w Steam',
          run: wrap(() => api().game.openInSteam(game.id, 'details')),
          note: 'Pliki gry wymagają weryfikacji lub naprawy w kliencie Steam.'
        }
    }
  }, [game, steamStatus, emuSummary, ready, installing])

  return { primary, busy, ready }
}

/** EmuStart: the one action that fits the game's state, as EmuStart itself would do it. */
export function emuPrimary(
  game: Game,
  emu: EmustartSummary | undefined,
  ready: EmuReadiness | null,
  installing: boolean,
  setBusy: (b: boolean) => void
): PrimaryAction {
  const g = game.emu!
  if (!emu || emu.engine !== 'ready')
    return {
      label: emu?.engine === 'starting' ? 'Uruchamianie EmuStart…' : 'EmuStart nie działa',
      disabled: true,
      note: emu?.message ?? 'Silnik EmuStart nie działa — gry z serwera są chwilowo niedostępne (szczegóły w Ustawieniach → EmuStart).'
    }
  const missing = ready?.ok ? ready.missing.find((m) => m.kind === 'emulator') : undefined
  if (installing) return { label: 'Instalowanie emulatora…', disabled: true, note: 'Emulator pobiera się z serwera EmuStart (lista zadań u góry).' }
  if (missing) {
    if (!missing.installable)
      return { label: 'Brak emulatora', disabled: true, note: `Nie ma emulatora dla ${missing.system} na tym komputerze, a serwer EmuStart go nie udostępnia. Wskaż emulator w Ustawieniach → Biblioteka EmuStart → Systemy.` }
    return {
      label: 'Zainstaluj emulator',
      note: `Brak emulatora dla ${missing.system} — pobierze się z serwera EmuStart: ${missing.steps.join(', ')}.`,
      run: async () => {
        setBusy(true)
        const r = await attempt(api().emustart.installEmulators([missing.es]))
        setBusy(false)
        if (r) useStore.getState().toast(r.ok ? (r.message ?? 'Instalacja rozpoczęta') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error')
      }
    }
  }
  const serverOk = !!emu.server?.ok
  if (!g.cached && !serverOk)
    return {
      label: 'Serwer niedostępny',
      disabled: true,
      note: emu.server
        ? 'Ta gra nie jest pobrana, a serwer EmuStart nie odpowiada. Pobrane gry działają bez serwera.'
        : 'To urządzenie nie jest zalogowane do serwera EmuStart (Ustawienia → EmuStart).'
    }
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = await attempt(api().emustart.launch(game.id))
    setBusy(false)
    if (!r) return
    if (!r.ok) {
      useStore.getState().toast(r.error ?? 'Nie udało się uruchomić gry.', 'error')
      // the profile is locked on this device (PIN / account password): choose or unlock it
      if (r.profileLocked) useStore.getState().setProfiles('normal')
    } else if (r.message) useStore.getState().toast(r.message, 'info')
  }
  if (g.cached) return { label: 'Graj', run, note: `${g.system}${ready?.ok && ready.emulator ? ` · ${ready.emulator}` : ''}` }
  return {
    label: 'Pobierz i graj',
    run,
    note: `Gra pobierze się z serwera EmuStart (${formatBytes(g.size) ?? '?'}) i uruchomi. Zapisy synchronizuje EmuStart przed i po grze.`
  }
}

