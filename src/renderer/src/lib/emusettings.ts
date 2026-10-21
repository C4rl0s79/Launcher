import { api, askChoice, attempt, useStore } from '../store'

// EmuStart's settings actions (engine/web/app.js: settings rows "Akcje") for both layouts.

const toast = (t: string, kind: 'info' | 'error' = 'info'): void => useStore.getState().toast(t, kind)

/** The default emulator for every platform of the library that has none yet. */
export async function detectEmulators(): Promise<void> {
  toast('Wykrywam emulatory…')
  const r = await api()
    .emustart.account<{ ok?: boolean; reason?: string; assigned?: number }>('autodetect')
    .catch((e: Error): { ok?: boolean; reason?: string; assigned?: number } => ({ ok: false, reason: e.message }))
  toast(r.ok ? `Przypisano emulatory: ${r.assigned ?? 0}` : (r.reason ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
}

/** Platforms without an emulator and what the server would install — confirm, then one job. */
export async function installMissing(): Promise<void> {
  const list = await api()
    .emustart.account<{ es: string; system: string; steps: { label: string }[] }[]>('install_missing')
    .catch(() => null)
  if (!list) return toast('Nie udało się odczytać brakujących emulatorów.', 'error')
  const can = list.filter((x) => x.steps.length)
  if (!can.length) return toast(list.length ? 'Brakujących emulatorów nie umiem pobrać automatycznie.' : 'Wszystkie systemy mają emulator.')
  const no = list.length - can.length
  const c = await askChoice(
    `Pobierz brakujące emulatory (${can.length}): ${can.map((x) => `${x.system} — ${x.steps.map((s) => s.label).join(' + ')}`).join('; ')}` +
      (no ? `. Bez automatycznego źródła: ${no}.` : ''),
    ['Pobierz wszystko', 'Anuluj']
  )
  if (c !== 0) return
  const r = await attempt(api().emustart.installEmulators(can.map((x) => x.es)))
  if (r) toast(r.ok ? (r.message ?? 'Pobieranie emulatorów — postęp na liście zadań.') : (r.error ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
}

/** Administrator: art source keys (SteamGridDB, IGDB, TheGamesDB) from PyLinks on this PC → server. */
export async function pushArtKeys(): Promise<void> {
  const r = await api()
    .emustart.account<{ ok?: boolean; reason?: string; sent?: string[]; sources?: string[] }>('art_keys_push')
    .catch((e: Error) => ({ ok: false, reason: e.message }) as { ok?: boolean; reason?: string; sent?: string[]; sources?: string[] })
  toast(r.ok ? `Klucze na serwerze (${(r.sent ?? []).length}). Źródła grafik: ${(r.sources ?? []).join(', ')}.` : (r.reason ?? 'Serwer nie odpowiada.'), r.ok ? 'info' : 'error')
}
