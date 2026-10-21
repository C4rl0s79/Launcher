import { useEffect, useRef, useState } from 'react'
import type { EmuPadsState } from '@shared/types'
import { api, useStore } from '../store'
import { Modal } from './Modal'

// Controller order (EmuStart's "Kolejność padów", both layouts): the player order the engine
// applies when a game starts — as in Windows, wireless first, or assigned by hand (each player
// presses A on their controller; B on any controller ends).

const MODES: [EmuPadsState['mode'], string][] = [
  ['windows', 'Jak w Windows (kolejność podłączenia)'],
  ['wireless_first', 'Bezprzewodowe przed przewodowymi'],
  ['manual', 'Ręcznie']
]
const A_BTN = 0x1000
const B_BTN = 0x2000

const padLabel = (p: EmuPadsState['pads'][number] | undefined): string =>
  p ? `Pad #${p.slot + 1}: ` + (p.wireless ? `bezprzewodowy${p.battery ? `, bateria ${p.battery}` : ''}` : 'przewodowy') : '—'

export function PadsOrder({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<EmuPadsState | null>(null)
  const [assign, setAssign] = useState<{ order: number[]; prev: Record<number, number>; armed: boolean } | null>(null)
  const [prompt, setPrompt] = useState('')
  const first = useRef<EmuPadsState | null>(null)
  const toast = useStore((s) => s.toast)
  const call = <T,>(m: 'pads_state' | 'pads_set', ...a: unknown[]): Promise<T> => api().emustart.account<T>(m, ...a)

  useEffect(() => {
    let alive = true
    void call<EmuPadsState>('pads_state', true).then((s) => {
      if (!alive) return
      first.current = s // power source / battery: read once (not in the loop)
      setSt(s)
    })
    return () => {
      alive = false
    }
  }, [])

  // live state (buttons) — and the manual assignment reads the controllers directly
  const assignRef = useRef(assign)
  assignRef.current = assign
  useEffect(() => {
    const t = setInterval(async () => {
      const s = await call<EmuPadsState>('pads_state').catch(() => null)
      if (!s) return
      for (const p of s.pads) {
        const old = first.current?.pads.find((x) => x.slot === p.slot)
        if (old) Object.assign(p, { wireless: old.wireless, battery: old.battery, kind: old.kind })
      }
      const as = assignRef.current
      if (!as) return setSt(s)
      const prev = as.prev
      const next = { ...as, prev: Object.fromEntries(s.pads.map((p) => [p.slot, p.buttons])) }
      if (!as.armed) {
        // A that chose "Przypisz ręcznie" is still held — wait until every controller is released
        next.armed = s.pads.every((p) => !p.buttons)
        return setAssign(next)
      }
      for (const p of s.pads) {
        const down = p.buttons & ~(prev[p.slot] ?? 0)
        if (down & B_BTN) return void finish(next.order)
        if (down & A_BTN && !next.order.includes(p.slot)) {
          next.order = [...next.order, p.slot]
          setPrompt(`Gracz ${next.order.length} → ${padLabel(p)}. ` + (next.order.length < s.pads.length ? `Gracz ${next.order.length + 1}: naciśnij A` : 'Gotowe.'))
          if (next.order.length >= s.pads.length) return void finish(next.order)
        }
      }
      setAssign(next)
    }, 200)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finish = async (order: number[]): Promise<void> => {
    setAssign(null)
    setPrompt('')
    if (!order.length) return
    const s = await call<EmuPadsState>('pads_set', 'manual', order)
    setSt(s)
    toast('Zapisano kolejność padów.')
  }
  const setMode = async (mode: EmuPadsState['mode']): Promise<void> => setSt(await call<EmuPadsState>('pads_set', mode, st?.manual ?? []))

  const byslot = Object.fromEntries((st?.pads ?? []).map((p) => [p.slot, p]))
  return (
    <Modal
      title="Kolejność padów"
      onClose={() => (assign ? void finish(assign.order) : onClose())}
      wide
      className="gopt"
      // while assigning, the controllers are read directly — Lumen's own input does nothing
      handlers={assign ? { confirm: () => true, up: () => true, down: () => true, left: () => true, right: () => true } : undefined}
      hints={
        assign
          ? [
              { action: 'confirm', label: 'Ten pad = kolejny gracz' },
              { action: 'back', label: 'Koniec (na dowolnym padzie)' }
            ]
          : undefined
      }
    >
      {!st && <p className="details__loading">Odczytuję pady…</p>}
      {assign && <p className="enroll__code pads__prompt">{prompt || 'Gracz 1: naciśnij A na swoim padzie'}</p>}
      {st && (
        <>
          <h3 className="saves__h">Tryb</h3>
          <div className="gopt__list">
            {MODES.map(([m, label], i) => (
              <button key={m} className="gopt__row" data-nav data-autofocus={i === 0 || undefined} disabled={!!assign} onClick={() => void setMode(m)}>
                <span className="gopt__label">{label}</span>
                <span className="gopt__value">{st.mode === m ? '✓' : ''}</span>
              </button>
            ))}
            <button
              className="gopt__row"
              data-nav
              disabled={!!assign || !st.pads.length}
              onClick={() => {
                setPrompt('')
                setAssign({ order: [], prev: {}, armed: false })
              }}
            >
              <span className="gopt__label">Przypisz ręcznie</span>
              <span className="gopt__value">naciśnij A na padzie każdego gracza</span>
            </button>
          </div>
          <h3 className="saves__h">Kolejność graczy (stosowana przy starcie gry)</h3>
          {st.order.length ? (
            <div className="gopt__list">
              {st.order.map((slot, i) => (
                <div key={slot} className="gopt__row gopt__row--static">
                  <span className="gopt__label">Gracz {i + 1}</span>
                  <span className="gopt__value">
                    {padLabel(byslot[slot])}
                    {byslot[slot]?.buttons ? ' · ●' : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="details__muted">Brak podłączonych padów XInput. Pady PS: przez Steam Input albo DS4Windows.</p>
          )}
        </>
      )}
    </Modal>
  )
}
