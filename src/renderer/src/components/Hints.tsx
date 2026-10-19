import { useHints, type Action } from '../nav/input'
import { useStore } from '../store'

const PAD: Partial<Record<Action, string>> = {
  confirm: 'A',
  back: 'B',
  x: 'X',
  y: 'Y',
  lb: 'LB',
  rb: 'RB',
  lt: 'LT',
  rt: 'RT',
  menu: '☰',
  view: '⧉'
}
const KEYS: Partial<Record<Action, string>> = {
  confirm: 'Enter',
  back: 'Esc',
  x: 'F',
  y: 'S',
  lb: 'Q',
  rb: 'E',
  lt: 'PgUp',
  rt: 'PgDn',
  menu: 'O',
  view: 'V'
}

export function Glyph({ action }: { action: Action }) {
  const mode = useStore((s) => s.inputMode)
  if (mode === 'gamepad') return <span className={`glyph glyph--pad glyph--${action}`}>{PAD[action]}</span>
  return <span className="glyph glyph--key">{KEYS[action]}</span>
}

export function HintsBar() {
  const hints = useHints()
  const mode = useStore((s) => s.inputMode)
  if (mode === 'mouse' || !hints.length) return <div className="hints hints--empty" />
  return (
    <div className="hints" aria-hidden="true">
      {hints.map((h) => (
        <span key={h.action + h.label} className="hint">
          <Glyph action={h.action} />
          {h.label}
        </span>
      ))}
    </div>
  )
}
