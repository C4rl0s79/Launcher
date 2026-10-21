import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EmuInGameMenu } from '@shared/types'
import { api, useStore } from '../store'
import { useActions } from '../nav/input'
import { HintsBar } from './Hints'

// In-game menu (A + Y over the emulator) for both layouts — EmuStart's menu: back to the game,
// save / load state, reset, quicksave and quit, shader, quit the game. The engine detects the
// combo, brings Lumen's window to the front and opens the menu (ingame_poll); this only shows it.
// Input: with Lumen focused — its own controller / keyboard input; when Windows did not hand the
// focus over — the presses the engine read itself (otherwise each press would count twice).

const CLOSED: EmuInGameMenu = { open: false, items: [], title: '', message: '', seq: 0, inputs: [] }

export function InGameMenu() {
  const running = useStore((s) => s.jobs.emu?.launch?.phase === 'running')
  const [m, setM] = useState<EmuInGameMenu>(CLOSED)
  const [idx, setIdx] = useState(0)
  const seq = useRef(0)
  const idxRef = useRef(0)
  idxRef.current = idx

  const step = (items: EmuInGameMenu['items'], from: number, d: number): number => {
    const n = items.length
    let i = from
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n
      if (items[i].on) break
    }
    return i
  }
  const act = (id: string): void => void api().emustart.account('ingame_action', id)

  useEffect(() => {
    if (!running && !m.open) return
    let busy = false
    const t = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        const r = await api().emustart.account<EmuInGameMenu>('ingame_poll')
        if (r.open && (!m.open || r.seq !== seq.current)) {
          seq.current = r.seq
          setM(r)
          setIdx(Math.max(0, r.items.findIndex((x) => x.on)))
        } else if (!r.open && m.open) setM(CLOSED)
        // presses read by the engine count only when Lumen does not have the focus itself
        if (r.open && !document.hasFocus())
          for (const a of r.inputs ?? []) {
            if (a === 'up') setIdx((i) => step(r.items, i, -1))
            else if (a === 'down') setIdx((i) => step(r.items, i, 1))
            else if (a === 'b') act('back')
            else if (a === 'a') {
              const it = r.items[idxRef.current]
              if (it?.on) act(it.id)
            }
          }
      } catch {
        /* engine busy — next tick */
      } finally {
        busy = false
      }
    }, 80)
    return () => clearInterval(t)
  }, [running, m.open])

  if (!m.open) return null
  return <MenuView m={m} idx={idx} setIdx={setIdx} step={step} act={act} />
}

function MenuView({
  m,
  idx,
  setIdx,
  step,
  act
}: {
  m: EmuInGameMenu
  idx: number
  setIdx: (f: (i: number) => number) => void
  step: (items: EmuInGameMenu['items'], from: number, d: number) => number
  act: (id: string) => void
}) {
  useActions(
    {
      up: () => (setIdx((i) => step(m.items, i, -1)), true),
      down: () => (setIdx((i) => step(m.items, i, 1)), true),
      left: () => true,
      right: () => true,
      confirm: () => {
        const it = m.items[idx]
        if (it?.on) act(it.id)
        return true
      },
      back: () => (act('back'), true),
      menu: () => (act('back'), true),
      x: () => true,
      y: () => true,
      lb: () => true,
      rb: () => true,
      lt: () => true,
      rt: () => true,
      view: () => true
    },
    {
      modal: true,
      hints: [
        { action: 'confirm', label: 'Wybierz' },
        { action: 'back', label: 'Wróć do gry' }
      ]
    }
  )
  return createPortal(
    <div className="ingame" data-layer>
      <div className="ingame__panel">
        <p className="ingame__sys">Menu w grze</p>
        <h2>{m.title}</h2>
        {m.message && <p className="ingame__msg">{m.message}</p>}
        <ul className="ingame__list">
          {m.items.map((it, i) => (
            <li key={it.id} className={`${i === idx ? 'sel' : ''} ${it.on ? '' : 'off'}`} onMouseEnter={() => it.on && setIdx(() => i)} onClick={() => it.on && act(it.id)}>
              <span>{it.label}</span>
              {(it.hint || !it.on) && <small>{it.on ? it.hint : 'ten emulator tego nie obsługuje'}</small>}
            </li>
          ))}
        </ul>
      </div>
      <HintsBar />
    </div>,
    document.body
  )
}
