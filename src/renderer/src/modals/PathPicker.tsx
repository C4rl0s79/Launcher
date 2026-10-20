import { useCallback, useEffect, useRef, useState } from 'react'
import type { FsEntry, FsListing } from '@shared/types'
import { api, useStore } from '../store'
import { focusEl, focusFirst } from '../nav/engine'
import { Modal } from '../components/Modal'

// Folder / file picker operated with a gamepad alone (the Windows dialog needs a mouse):
// D-pad / stick — move, A — open / choose, B — up one level (closes on the first page),
// X — choose the folder you are in. Keyboard and mouse work the same way.

const ICON: Record<FsEntry['kind'], string> = { place: '★', drive: '💽', dir: '📁', file: '📄' }

export function PathPicker() {
  const req = useStore((s) => s.picker)
  if (!req) return null
  return <PickerDialog key={req.id} />
}

function PickerDialog() {
  const req = useStore((s) => s.picker)!
  const finish = useStore((s) => s.finishPick)
  const { opts } = req
  const [listing, setListing] = useState<FsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // after going up, focus the folder we came from
  const focusAfter = useRef<string | null>(null)

  const open = useCallback(
    async (dir: string, from?: string) => {
      setLoading(true)
      focusAfter.current = from ?? null
      try {
        setListing(await api().app.listDir(dir, { kind: opts.kind, extensions: opts.extensions }))
      } finally {
        setLoading(false)
      }
    },
    [opts.kind, opts.extensions]
  )

  useEffect(() => void open(opts.start ?? ''), [open, opts.start])

  useEffect(() => {
    if (!listing || !listRef.current) return
    const want = focusAfter.current
    const el = want ? listRef.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(want)}"]`) : null
    if (el) focusEl(el, false)
    else if (!focusFirst(listRef.current)) focusFirst()
  }, [listing])

  const up = (): boolean => {
    if (!listing || listing.parent === null) {
      finish(null)
      return true
    }
    void open(listing.parent, listing.path)
    return true
  }
  const chooseHere = (): boolean => {
    if (opts.kind === 'folder' && listing?.path) finish(listing.path)
    return true
  }
  const pick = (e: FsEntry): void => {
    if (e.kind === 'file') finish(e.path)
    else void open(e.path)
  }

  const canChooseHere = opts.kind === 'folder' && !!listing?.path
  return (
    <Modal
      title={opts.title}
      onClose={() => finish(null)}
      wide
      className="picker"
      handlers={{ back: up, x: chooseHere }}
      hints={[
        { action: 'confirm', label: 'Otwórz' },
        ...(canChooseHere ? [{ action: 'x' as const, label: 'Wybierz ten folder' }] : []),
        { action: 'back', label: listing?.parent === null ? 'Anuluj' : 'Wyżej' }
      ]}
    >
      <div className="picker__path" title={listing?.path || ''}>
        {listing?.path || (opts.kind === 'file' ? 'Wybierz dysk albo skrót, a potem plik' : 'Wybierz dysk albo skrót')}
      </div>
      <div className="picker__list" ref={listRef} data-scroll="center" aria-busy={loading}>
        {listing?.error && <p className="card__desc">{listing.error}</p>}
        {listing && !listing.error && listing.entries.length === 0 && (
          <p className="card__desc">{opts.kind === 'file' ? 'Brak podfolderów ani pasujących plików.' : 'Brak podfolderów.'}</p>
        )}
        {listing?.entries.map((e) => (
          <button key={e.path} className={`picker__row picker__row--${e.kind}`} data-nav data-key={e.path} onClick={() => pick(e)} title={e.path}>
            <span className="picker__icon" aria-hidden>
              {ICON[e.kind]}
            </span>
            <span className="picker__name">{e.name}</span>
            {e.note && <span className="picker__note">{e.note}</span>}
          </button>
        ))}
        {listing?.truncated && <p className="card__desc">Pokazano pierwsze 3000 pozycji.</p>}
      </div>
      <div className="modal__actions">
        {canChooseHere && (
          <button className="btn btn--primary" data-nav onClick={chooseHere}>
            Wybierz ten folder
          </button>
        )}
        {listing?.parent !== null && listing && (
          <button className="btn" data-nav onClick={up}>
            Wyżej
          </button>
        )}
        <button className="btn btn--ghost" data-nav onClick={() => finish(null)}>
          Anuluj
        </button>
      </div>
    </Modal>
  )
}
