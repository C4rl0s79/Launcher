import type { PadState } from '@shared/types'

// Pads that are not XInput devices (PlayStation, Nintendo, GameSir / 8BitDo in Bluetooth HID mode)
// report plain HID: numbered buttons, axes and a hat switch. Lumen's navigation speaks XInput, so
// each report is turned into the XInput-shaped PadState by the button's position on the pad
// (bottom face button = A = confirm, right = B = back), whatever the label printed on it.

/** One HID report, decoded: pressed button numbers (HID usages, from 1), axes in -1..1, hat 0–7 or null. */
export interface HidSnapshot {
  buttons: number[]
  x?: number
  y?: number
  hat: number | null
}

// XINPUT_GAMEPAD_* bits
const A = 0x1000
const B = 0x2000
const X = 0x4000
const Y = 0x8000
const LB = 0x0100
const RB = 0x0200
const BACK = 0x0020
const START = 0x0010
const LS = 0x0040
const RS = 0x0080
const UP = 0x0001
const DOWN = 0x0002
const LEFT = 0x0004
const RIGHT = 0x0008

type Target = number | 'lt' | 'rt'
export type LayoutName = 'sony' | 'nintendo' | 'android' | 'xbox'
export interface Layout {
  name: LayoutName
  map: Record<number, Target>
}

const LAYOUTS: Record<LayoutName, Record<number, Target>> = {
  // DualShock 4 / DualSense: Square, Cross, Circle, Triangle, L1, R1, L2, R2, Share, Options, L3, R3
  // (also the usual layout of generic DirectInput pads with 12+ buttons)
  sony: { 1: X, 2: A, 3: B, 4: Y, 5: LB, 6: RB, 7: 'lt', 8: 'rt', 9: BACK, 10: START, 11: LS, 12: RS },
  // Switch Pro: B (bottom), A (right), Y (left), X (top), L, R, ZL, ZR, Minus, Plus, LS, RS
  nintendo: { 1: A, 2: B, 3: X, 4: Y, 5: LB, 6: RB, 7: 'lt', 8: 'rt', 9: BACK, 10: START, 11: LS, 12: RS },
  // Android gamepad (Bluetooth HID mode of GameSir, 8BitDo…): A, B, C, X, Y, Z, L1, R1, L2, R2,
  // Select, Start, Mode, L3, R3 — C and Z unused on most pads
  android: { 1: A, 2: B, 4: X, 5: Y, 7: LB, 8: RB, 9: 'lt', 10: 'rt', 11: BACK, 12: START, 14: LS, 15: RS },
  // DirectInput pads shaped like Xbox ones: A, B, X, Y, LB, RB, Back, Start, LS, RS
  xbox: { 1: A, 2: B, 3: X, 4: Y, 5: LB, 6: RB, 7: BACK, 8: START, 9: LS, 10: RS }
}

/** Button layout of a HID pad: by maker, otherwise by how many buttons it declares. */
export function layoutFor(vid: number, buttonCount: number): Layout {
  const name: LayoutName = vid === 0x054c ? 'sony' : vid === 0x057e ? 'nintendo' : buttonCount >= 15 ? 'android' : buttonCount >= 12 ? 'sony' : 'xbox'
  return { name, map: LAYOUTS[name] }
}

// hat switch direction (0 = up, clockwise) → d-pad bits
const HAT = [UP, UP | RIGHT, RIGHT, DOWN | RIGHT, DOWN, DOWN | LEFT, LEFT, UP | LEFT]

/** Raw HID value → -1..1 within the declared logical range. */
export function axis(value: number, min: number, max: number): number {
  if (max <= min) return 0
  const v = Math.min(max, Math.max(min, value))
  return ((v - min) / (max - min)) * 2 - 1
}

/** Hat switch value → direction 0–7, null when centred (values outside the range mean "released"). */
export function hatDirection(value: number, min: number, max: number): number | null {
  const d = value - min
  if (d < 0 || value > max) return null
  if (max - min === 7) return d
  if (max - min === 3) return d * 2 // 4-way hat: up, right, down, left
  return null
}

/** A decoded HID report in the shape of an XInput pad state. */
export function toPadState(index: number, snap: HidSnapshot, layout: Layout): PadState {
  let buttons = 0
  let lt = 0
  let rt = 0
  for (const b of snap.buttons) {
    const t = layout.map[b]
    if (t === 'lt') lt = 255
    else if (t === 'rt') rt = 255
    else if (t) buttons |= t
  }
  if (snap.hat !== null) buttons |= HAT[snap.hat] ?? 0
  const stick = (v: number | undefined): number => Math.round(Math.max(-1, Math.min(1, v ?? 0)) * 32767)
  // HID Y grows downwards, XInput Y upwards
  return { index, buttons, lt, rt, lx: stick(snap.x), ly: -stick(snap.y) }
}
