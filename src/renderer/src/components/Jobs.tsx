import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { EmuSaveConflict, Job, SaveChoice } from '@shared/types'
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
  const conflict = launch?.phase === 'conflict' ? (launch.conflict ?? []) : []
  // one game at a time per profile (like Steam): the profile is playing on another device
  const lockedBy = ended ? launch?.locked_by : undefined
  const takeover = (): boolean => {
    if (!job?.gameId) return true
    const id = job.gameId
    void api()
      .emustart.dismiss()
      .then(() => attempt(api().emustart.launch(id, undefined, true)))
    return true
  }
  const choose = (c: SaveChoice): boolean => {
    void attempt(api().emustart.resolveConflict(c))
    return true
  }

  // a finished session is closed right away (as in EmuStart); errors wait for the user
  useEffect(() => {
    if (job?.state === 'done') void api().emustart.dismiss()
  }, [job?.state])
  useEffect(() => {
    if (visible && ref.current) focusFirst(ref.current)
  }, [visible, ended, conflict.length])

  useActions(
    {
      back: () => {
        if (conflict.length) return choose('skip')
        if (job?.cancellable) void api().emustart.cancelLaunch()
        else if (ended) void api().emustart.dismiss()
        return true
      },
      // save conflict: the same buttons as in EmuStart (X this device, Y server, B skip)
      x: () => (conflict.length ? choose('local') : lockedBy ? takeover() : true),
      y: () => (conflict.length ? choose('remote') : true),
      lb: () => true,
      rb: () => true,
      menu: () => true
    },
    {
      enabled: visible,
      modal: true,
      hints: conflict.length
        ? [
            { action: 'x', label: 'Zostaw z tego urządzenia' },
            { action: 'y', label: 'Weź z serwera' },
            { action: 'back', label: 'Pomiń' }
          ]
        : lockedBy
          ? [
              { action: 'x', label: 'Przejmij profil i graj' },
              { action: 'back', label: 'Zamknij' }
            ]
          : job?.cancellable
            ? [{ action: 'back', label: 'Anuluj pobieranie' }]
            : ended
              ? [{ action: 'confirm', label: 'Zamknij' }]
              : []
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
        {conflict.length > 0 && <SaveConflictChoice conflict={conflict} onChoose={choose} />}
        {job.state === 'running' && !job.message && <p className="launch__msg">Miłej gry! Menu w grze: LB + A.</p>}
        <div className="launch__actions">
          {job.cancellable && (
            <button className="btn btn--danger" data-nav data-autofocus onClick={() => void api().emustart.cancelLaunch()}>
              Anuluj pobieranie
            </button>
          )}
          {lockedBy && (
            <button className="btn" data-nav onClick={takeover}>
              Przejmij profil i graj
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

const KIND_PL: Record<string, string> = { saves: 'zapisy w grze', states: 'stany', memcards: 'karta pamięci' }

const when = (unix: number): string =>
  unix ? new Date(unix * 1000).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }) : '—'

/**
 * Save conflict (EmuStart 0.46 save sync): the saves of this game changed here and on another device.
 * Nothing is lost either way — the other version stays in the server history or in a local backup.
 */
function SaveConflictChoice({ conflict, onChoose }: { conflict: EmuSaveConflict[]; onChoose: (c: SaveChoice) => boolean }) {
  const kinds = [...new Set(conflict.map((c) => KIND_PL[c.kind] ?? c.kind))].join(', ')
  const devices = [...new Set(conflict.map((c) => c.server_device).filter(Boolean))].join(', ')
  const newest = (k: 'local_time' | 'server_time'): number => Math.max(0, ...conflict.map((c) => c[k] || 0))
  return (
    <div className="conflict">
      <div className="conflict__sides">
        <div className="conflict__side">
          <strong>To urządzenie</strong>
          <span>{kinds}</span>
          <span>zmienione {when(newest('local_time'))}</span>
        </div>
        <div className="conflict__side">
          <strong>Serwer</strong>
          <span>{devices ? `z urządzenia ${devices}` : 'inne urządzenie'}</span>
          <span>zmienione {when(newest('server_time'))}</span>
        </div>
      </div>
      <p className="details__muted">Druga wersja nie ginie — zostaje w historii na serwerze albo w kopii zapasowej na tym komputerze.</p>
      <div className="launch__actions">
        <button className="btn btn--primary" data-nav data-autofocus onClick={() => onChoose('local')}>
          Zostaw z tego urządzenia
        </button>
        <button className="btn" data-nav onClick={() => onChoose('remote')}>
          Weź z serwera
        </button>
        <button className="btn btn--ghost" data-nav onClick={() => onChoose('skip')}>
          Pomiń (bez synchronizacji)
        </button>
      </div>
    </div>
  )
}
