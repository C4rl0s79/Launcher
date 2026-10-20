import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Job } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { useActions } from '../nav/input'
import { focusFirst } from '../nav/engine'
import { Modal } from './Modal'
import { formatBytes, formatEta } from '../lib/format'

// The task list shared with the fullscreen interface: Steam downloads (from Steam's manifests —
// Steam runs them) and EmuStart jobs (engine). Shown as a top-bar pill and a panel.

const isLive = (j: Job): boolean => j.state === 'active' || j.state === 'queued'

export function JobsPill() {
  const jobs = useStore((s) => s.jobs.jobs)
  const open = useStore((s) => s.setJobsOpen)
  const live = jobs.filter((j) => isLive(j) && j.kind !== 'emuLaunch')
  if (!live.length) return null
  const first = live[0]
  const pct = first.progress?.total ? Math.floor((first.progress.done / first.progress.total) * 100) : null
  return (
    <button className="pill pill--jobs" tabIndex={-1} onClick={() => open(true)} title="Zadania">
      ⬇ {first.title}
      {pct !== null ? ` · ${pct}%` : ''}
      {live.length > 1 ? ` (+${live.length - 1})` : ''}
    </button>
  )
}

function JobRow({ job }: { job: Job }) {
  const p = job.progress
  const pct = p?.total ? Math.min(100, Math.floor((p.done / p.total) * 100)) : null
  return (
    <div className={`job job--${job.state}`}>
      <div className="job__head">
        <strong>{job.title}</strong>
        <span className="job__src">{job.source === 'steam' ? 'Steam' : 'EmuStart'}</span>
      </div>
      <div className="job__phase">
        {job.phase}
        {pct !== null && ` · ${pct}% · ${formatBytes(p!.done) ?? '0 B'} z ${formatBytes(p!.total)}`}
        {p?.speed ? ` · ${formatBytes(p.speed)}/s` : ''}
        {p?.eta !== undefined && formatEta(p.eta) ? ` · zostało ${formatEta(p.eta)}` : ''}
      </div>
      {pct !== null && (
        <div className="download__bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {job.message && <p className="details__muted">{job.message}</p>}
      {job.managedBySteam && <p className="details__muted">Pobieraniem zarządza klient Steam (wartości z manifestu, z opóźnieniem).</p>}
      <div className="job__actions">
        {job.managedBySteam && (
          <button className="btn btn--sm" data-nav onClick={() => void attempt(api().game.openInSteam(job.gameId ?? '', 'downloads'))}>
            Okno pobierania Steam
          </button>
        )}
        {job.cancellable && (
          <button
            className="btn btn--sm btn--danger"
            data-nav
            onClick={async () => {
              const r = await attempt(api().jobs.cancel(job.id))
              if (r) useStore.getState().toast(r.ok ? (r.message ?? 'Zatrzymano.') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error')
            }}
          >
            Anuluj
          </button>
        )}
      </div>
    </div>
  )
}

export function JobsPanel() {
  const open = useStore((s) => s.jobsOpen)
  const jobs = useStore((s) => s.jobs)
  const close = (): void => useStore.getState().setJobsOpen(false)
  if (!open) return null
  const conflicts = jobs.emu?.conflicts ?? []
  return (
    <Modal title="Zadania" onClose={close} wide>
      <div className="jobs">
        {jobs.jobs.length === 0 && <p className="card__desc">Nic się teraz nie pobiera ani nie instaluje.</p>}
        {jobs.jobs.map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
        {conflicts.length > 0 && (
          <div className="notice notice--warn">
            <strong>Konflikty zapisów EmuStart ({conflicts.length}).</strong> Grano na dwóch urządzeniach bez połączenia z serwerem: została
            nowsza wersja pliku, druga jest w kopii zapasowej profilu na serwerze.
            <ul>
              {conflicts.slice(0, 5).map((c, i) => (
                <li key={i}>
                  {c.profile ? `${c.profile}: ` : ''}
                  {c.file ?? '?'}
                </li>
              ))}
            </ul>
            <button className="btn btn--sm" data-nav onClick={() => void attempt(api().emustart.clearConflicts())}>
              Przyjmuję do wiadomości
            </button>
          </div>
        )}
      </div>
      <div className="modal__actions">
        <button className="btn" data-nav data-autofocus onClick={close}>
          Zamknij
        </button>
      </div>
    </Modal>
  )
}

/**
 * EmuStart launch session (download → unpack → emulator) in the desktop interface. The same
 * session is visible in the fullscreen interface — both read it from the engine.
 */
export function EmuLaunchOverlay() {
  const job = useStore((s) => s.jobs.jobs.find((j) => j.kind === 'emuLaunch'))
  const launch = useStore((s) => s.jobs.emu?.launch)
  const ref = useRef<HTMLDivElement>(null)
  const visible = !!job && job.state !== 'done'
  const ended = job?.state === 'error' || job?.state === 'cancelled'

  // a finished session is closed right away (as in EmuStart); errors wait for the user
  useEffect(() => {
    if (job?.state === 'done') void api().emustart.dismiss()
  }, [job?.state])
  useEffect(() => {
    if (visible && ref.current) focusFirst(ref.current)
  }, [visible, ended])

  useActions(
    {
      back: () => {
        if (job?.cancellable) void api().emustart.cancelLaunch()
        else if (ended) void api().emustart.dismiss()
        return true
      },
      x: () => true,
      y: () => true,
      lb: () => true,
      rb: () => true,
      menu: () => true
    },
    {
      enabled: visible,
      modal: true,
      hints: job?.cancellable ? [{ action: 'back', label: 'Anuluj pobieranie' }] : ended ? [{ action: 'confirm', label: 'Zamknij' }] : []
    }
  )
  if (!visible || !job) return null
  const p = job.progress
  const pct = p?.total ? Math.min(100, (p.done / p.total) * 100) : null
  return createPortal(
    <div className="launch" data-layer ref={ref}>
      <div className="launch__box">
        <div className="launch__system">{launch?.system}</div>
        <h1 className="launch__title">{job.title}</h1>
        <div className={`launch__phase ${ended ? 'is-error' : ''}`}>{job.phase}</div>
        {pct !== null && (
          <>
            <div className="download__bar launch__bar">
              <i style={{ width: `${pct.toFixed(1)}%` }} />
            </div>
            <div className="launch__stats">
              <span>
                {formatBytes(p!.done) ?? '0 B'} / {formatBytes(p!.total)}
              </span>
              {p?.speed ? <span>{formatBytes(p.speed)}/s</span> : null}
              {formatEta(p?.eta) && <span>zostało {formatEta(p?.eta)}</span>}
            </div>
          </>
        )}
        {job.message && <p className="launch__msg">{job.message}</p>}
        {job.state === 'running' && !job.message && <p className="launch__msg">Miłej gry! Menu w grze: przytrzymaj A + Y.</p>}
        <div className="launch__actions">
          {job.cancellable && (
            <button className="btn btn--danger" data-nav data-autofocus onClick={() => void api().emustart.cancelLaunch()}>
              Anuluj pobieranie
            </button>
          )}
          {ended && (
            <button className="btn btn--primary" data-nav data-autofocus onClick={() => void api().emustart.dismiss()}>
              Zamknij
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
