import type { PadState } from './types'

// XInput buttons the main process acts on itself (the renderer maps everything else).
const START = 0x0010
const BACK = 0x0020

/** View (Back) + Start together: switch between the desktop and TV layouts. */
export function isModeCombo(p: PadState): boolean {
  return (p.buttons & (BACK | START)) === (BACK | START)
}
