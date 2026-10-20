import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { formatBytes } from '../lib/format'

/** Live state of Lumen's updater (main/updater.ts). */
export function useUpdate(): UpdateState | null {
  const [s, setS] = useState<UpdateState | null>(null)
  useEffect(() => {
    void api().update.get().then(setS)
    return api().update.onChange(setS)
  }, [])
  return s
}

const BUSY: UpdateState['phase'][] = ['downloading', 'verifying', 'extracting', 'applying']

/** Top bar: a new version is available / downloading / ready to install. */
export function UpdatePill() {
  const s = useUpdate()
  if (!s || !s.info || !['available', 'ready', ...BUSY].includes(s.phase)) return null
  const pct = s.phase === 'downloading' && s.total ? ` · ${Math.floor((s.done / s.total) * 100)}%` : ''
  const label = s.phase === 'ready' ? `Zainstaluj Lumen ${s.info.version}` : BUSY.includes(s.phase) ? `Aktualizacja ${s.info.version}${pct}` : `Nowa wersja ${s.info.version}`
  return (
    <button
      className="pill pill--jobs"
      tabIndex={-1}
      title="Aktualizacja Lumen"
      onClick={() => {
        const st = useStore.getState()
        st.setTab('settings')
        setTimeout(() => document.querySelector<HTMLElement>('[data-key="update-action"]')?.focus(), 200)
      }}
    >
      ⬆ {label}
    </button>
  )
}

/** Settings → Aktualizacja: the same steps as EmuStart's "Aktualizuj" (check → download → install). */
export function UpdateSection() {
  const s = useUpdate()
  if (!s) return null
  const i = s.info
  const busy = BUSY.includes(s.phase) || s.phase === 'checking'
  const pct = s.total ? Math.min(100, Math.floor((s.done / s.total) * 100)) : null
  let status: string
  switch (s.phase) {
    case 'checking':
      status = 'Sprawdzam wydania na GitHubie…'
      break
    case 'none':
      status = s.error ?? `Masz najnowszą wersję${i ? ` (${i.current})` : ''}.`
      break
    case 'available':
      status = `Dostępna wersja ${i?.version} (${formatBytes(i?.file?.size) ?? '?'}).`
      break
    case 'downloading':
      status = `Pobieram ${i?.version}${pct !== null ? `: ${pct}% · ${formatBytes(s.done) ?? '0 B'} z ${formatBytes(s.total)}` : '…'}`
      break
    case 'verifying':
      status = 'Sprawdzam skrót SHA-256 i podpis wydania…'
      break
    case 'extracting':
      status = 'Rozpakowuję…'
      break
    case 'ready':
      status = `Wersja ${i?.version} gotowa — Lumen zamknie się, podmieni pliki i uruchomi ponownie.`
      break
    case 'applying':
      status = 'Instaluję — Lumen uruchomi się ponownie…'
      break
    case 'error':
      status = s.error ?? 'Błąd aktualizacji.'
      break
    default:
      status = 'Nie sprawdzano jeszcze w tej sesji.'
  }
  const run = (p: Promise<UpdateState>): void => {
    void attempt(p)
  }
  return (
    <>
      <p className={`card__desc ${s.phase === 'error' ? 'is-error' : ''}`}>{status}</p>
      {s.phase === 'downloading' && pct !== null && (
        <div className="download__bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="modal__row">
        {s.phase === 'available' && (
          <button className="btn btn--primary" data-nav data-key="update-action" onClick={() => run(api().update.download())}>
            Pobierz {i?.version}
          </button>
        )}
        {s.phase === 'ready' && (
          <button className="btn btn--primary" data-nav data-key="update-action" onClick={() => run(api().update.apply())}>
            Zainstaluj i uruchom ponownie
          </button>
        )}
        {s.phase === 'downloading' && (
          <button className="btn btn--danger" data-nav data-key="update-action" onClick={() => void api().update.cancel()}>
            Anuluj
          </button>
        )}
        {!busy && s.phase !== 'ready' && (
          <button className="btn" data-nav data-key={s.phase === 'available' ? 'update-check' : 'update-action'} onClick={() => run(api().update.check())}>
            Sprawdź aktualizacje
          </button>
        )}
      </div>
      {i?.notes && ['available', 'ready'].includes(s.phase) && <pre className="update__notes">{i.notes.slice(0, 1500)}</pre>}
    </>
  )
}
