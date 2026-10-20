import type { PadState } from './types'

/** IPC channels of the fullscreen view (preload/emu.ts ⇄ main). */
export const EMU_UI = {
  /** EmuStart UI → main: one EmuStart Api call */
  call: 'emu-ui:call',
  pad: 'emu-ui:pad',
  focusGame: 'emu-ui:focusGame',
  open: 'emu-ui:open'
} as const

// XInput state (from Lumen's main process) → EmuStart UI actions (engine/web/app.js `press`).
// Same thresholds and repeat timing as EmuStart's own pad loop (app.js pollPads, emustart/uipad.py).

const B = {
  up: 0x0001,
  down: 0x0002,
  left: 0x0004,
  right: 0x0008,
  start: 0x0010,
  back: 0x0020,
  lb: 0x0100,
  rb: 0x0200,
  a: 0x1000,
  b: 0x2000,
  x: 0x4000,
  y: 0x8000
} as const

const TRIGGER = 128
const STICK = 0.55 * 32767

export function padActions(p: PadState): string[] {
  const out: string[] = []
  const has = (m: number): boolean => (p.buttons & m) !== 0
  if (has(B.up) || p.ly > STICK) out.push('up')
  if (has(B.down) || p.ly < -STICK) out.push('down')
  if (has(B.left) || p.lx < -STICK) out.push('left')
  if (has(B.right) || p.lx > STICK) out.push('right')
  if (has(B.a)) out.push('a')
  if (has(B.b)) out.push('b')
  if (has(B.x)) out.push('x')
  if (has(B.y)) out.push('y')
  if (has(B.lb)) out.push('lb')
  if (has(B.rb)) out.push('rb')
  if (p.lt > TRIGGER) out.push('lt')
  if (p.rt > TRIGGER) out.push('rt')
  if (has(B.start)) out.push('start')
  if (has(B.back)) out.push('select')
  return out
}

/** View (Back) + Start together: switch between desktop and fullscreen. */
export function isModeCombo(p: PadState): boolean {
  return (p.buttons & (B.back | B.start)) === (B.back | B.start)
}

const REPEATABLE = new Set(['up', 'down', 'left', 'right', 'lb', 'rb', 'lt', 'rt'])

/** Press / release / auto-repeat like EmuStart (first repeat after 380 ms, then 75 ms, 35 ms after 1.6 s). */
export class PadRepeater {
  private held = new Map<string, { since: number; next: number }>()

  constructor(private readonly emit: (action: string, up: boolean) => void) {}

  update(active: Set<string>, now: number): void {
    for (const a of active) {
      const h = this.held.get(a)
      if (!h) {
        this.held.set(a, { since: now, next: now + 380 })
        this.emit(a, false)
      } else if (REPEATABLE.has(a) && now >= h.next) {
        h.next = now + (now - h.since > 1600 ? 35 : 75)
        this.emit(a, false)
      }
    }
    for (const a of [...this.held.keys()]) {
      if (!active.has(a)) {
        this.held.delete(a)
        this.emit(a, true)
      }
    }
  }
}
