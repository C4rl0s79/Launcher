import { useEffect, useRef, useSyncExternalStore } from 'react'
import { activeLayer, currentFocus, focusFirst, move } from './engine'
import type { Dir } from './spatial'
import { useStore, type InputMode } from '../store'
import type { PadState } from '@shared/types'

// Unified input layer. Keyboard and gamepad are translated into the same abstract actions,
// then dispatched through a stack of handler layers (screens, modals). A modal layer stops
// propagation, so lower screens never react while a dialog is open.

export type Action = Dir | 'confirm' | 'back' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'menu' | 'view'

export interface Hint {
  action: Action
  label: string
}

type Handler = () => boolean | void
export type Handlers = Partial<Record<Action, Handler>>

interface Layer {
  id: number
  handlers: React.MutableRefObject<Handlers>
  enabled: boolean
  modal: boolean
  hints: Hint[]
}

let layers: Layer[] = []
let version = 0
const listeners = new Set<() => void>()
const notify = (): void => {
  version++
  listeners.forEach((l) => l())
}
let nextId = 1

/**
 * Layers from the bottom: screens first, then modal layers (dialogs, overlays) — a dialog stays on
 * top even when a screen under it mounts again later (e.g. the library refreshes after a login).
 */
const stack = (): Layer[] => [...layers.filter((l) => !l.modal), ...layers.filter((l) => l.modal)]

export function useActions(handlers: Handlers, opts: { enabled?: boolean; modal?: boolean; hints?: Hint[] } = {}): void {
  const ref = useRef(handlers)
  ref.current = handlers
  const idRef = useRef(0)
  const enabled = opts.enabled ?? true
  const modal = opts.modal ?? false
  const hintsKey = JSON.stringify(opts.hints ?? [])

  useEffect(() => {
    const id = nextId++
    idRef.current = id
    layers.push({ id, handlers: ref, enabled, modal, hints: opts.hints ?? [] })
    notify()
    return () => {
      layers = layers.filter((l) => l.id !== id)
      notify()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const l = layers.find((x) => x.id === idRef.current)
    if (!l) return
    l.enabled = enabled
    l.modal = modal
    l.hints = opts.hints ?? []
    notify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, modal, hintsKey])
}

/** Hints of the top-most enabled layer that declares any. */
export function useHints(): Hint[] {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  const ls = stack()
  for (let i = ls.length - 1; i >= 0; i--) {
    const l = ls[i]
    if (l.enabled && l.hints.length) return l.hints
    if (l.enabled && l.modal) return []
  }
  return []
}

export function dispatch(action: Action, source: InputMode): void {
  useStore.getState().setInputMode(source)
  const ls = stack()
  for (let i = ls.length - 1; i >= 0; i--) {
    const l = ls[i]
    if (!l.enabled) continue
    const h = l.handlers.current[action]
    if (h && h() !== false) return
    if (l.modal) break
  }
  // defaults
  switch (action) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      move(action)
      return
    case 'lt':
    case 'rt':
      // page jump: several rows at once
      for (let i = 0; i < 3; i++) if (!move(action === 'lt' ? 'up' : 'down', false)) break
      return
    case 'confirm': {
      const el = currentFocus()
      if (!el) return
      if (el instanceof HTMLInputElement) {
        el.dispatchEvent(new CustomEvent('lumen-osk', { bubbles: true }))
        return
      }
      el.click()
      return
    }
  }
}

// ---------------- keyboard ----------------

function isTextInput(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type))
}

export function keyToAction(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>, inText: boolean): Action | null {
  if (e.altKey || e.metaKey) return null
  if (e.ctrlKey) return e.key.toLowerCase() === 'f' ? 'y' : null
  switch (e.key) {
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'ArrowLeft':
      return inText ? null : 'left'
    case 'ArrowRight':
      return inText ? null : 'right'
    case 'Enter':
      return inText ? null : 'confirm'
    case ' ':
      return inText ? null : 'confirm'
    case 'Escape':
    case 'BrowserBack':
      return 'back'
    case 'Backspace':
      return inText ? null : 'back'
    case 'PageUp':
      return 'lt'
    case 'PageDown':
      return 'rt'
    case 'ContextMenu':
      return 'menu'
  }
  if (inText) return null
  switch (e.key.toLowerCase()) {
    case '/':
    case 's':
      return 'y'
    case 'f':
      return 'x'
    case 'q':
      return 'lb'
    case 'e':
      return 'rb'
    case 'o':
      return 'menu'
    case 'v':
      return 'view'
  }
  return null
}

export function installKeyboard(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const inText = isTextInput(e.target)
    const action = keyToAction(e, inText)
    if (!action) return
    e.preventDefault()
    if (inText && (action === 'back' || action === 'down') && !(e.target as HTMLElement).hasAttribute('data-nav')) {
      // leaving a field that is not part of D-pad navigation (e.g. group search): back to the games
      const el = e.target as HTMLElement
      el.blur()
      focusFirst((el.closest('[data-screen]') as HTMLElement | null) ?? activeLayer())
      return
    }
    if (inText && action === 'back') (e.target as HTMLElement).blur?.()
    dispatch(action, 'keyboard')
  }
  const onMouse = (): void => useStore.getState().setInputMode('mouse')
  window.addEventListener('keydown', onKey)
  window.addEventListener('mousedown', onMouse, true)
  return () => {
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('mousedown', onMouse, true)
  }
}

// ---------------- gamepad ----------------

// Standard Gamepad mapping (https://w3c.github.io/gamepad/#remapping): Chromium on Windows
// exposes XInput pads (Xbox) and DualShock 4 / DualSense in this layout.
const BUTTONS: [number, Action][] = [
  [0, 'confirm'],
  [1, 'back'],
  [2, 'x'],
  [3, 'y'],
  [4, 'lb'],
  [5, 'rb'],
  [6, 'lt'],
  [7, 'rt'],
  [8, 'view'],
  [9, 'menu'],
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right']
]
const REPEATABLE = new Set<Action>(['up', 'down', 'left', 'right', 'lt', 'rt'])
const AXIS_THRESHOLD = 0.55
const FIRST_REPEAT_MS = 380
const REPEAT_MS = 115
const FAST_REPEAT_MS = 65

export function readPadActions(pads: (Gamepad | null)[]): Set<Action> {
  const active = new Set<Action>()
  for (const p of pads) {
    if (!p || !p.connected) continue
    if (p.mapping !== 'standard' && p.buttons.length < 16) continue
    for (const [i, a] of BUTTONS) if (p.buttons[i]?.pressed) active.add(a)
    const [x = 0, y = 0] = p.axes
    if (Math.abs(x) > AXIS_THRESHOLD || Math.abs(y) > AXIS_THRESHOLD) {
      if (Math.abs(x) > Math.abs(y)) active.add(x > 0 ? 'right' : 'left')
      else active.add(y > 0 ? 'down' : 'up')
    }
  }
  return active
}

// XInput button bits (XINPUT_GAMEPAD_*)
const XI: [number, Action][] = [
  [0x0001, 'up'],
  [0x0002, 'down'],
  [0x0004, 'left'],
  [0x0008, 'right'],
  [0x0010, 'menu'],
  [0x0020, 'view'],
  [0x0100, 'lb'],
  [0x0200, 'rb'],
  [0x1000, 'confirm'],
  [0x2000, 'back'],
  [0x4000, 'x'],
  [0x8000, 'y']
]
const XI_TRIGGER = 100 // of 255
const XI_STICK = 0.55 * 32767

/** Actions held on XInput pads (state polled by the main process). */
export function xinputActions(pads: PadState[]): Set<Action> {
  const active = new Set<Action>()
  for (const p of pads) {
    for (const [bit, a] of XI) if (p.buttons & bit) active.add(a)
    if (p.lt > XI_TRIGGER) active.add('lt')
    if (p.rt > XI_TRIGGER) active.add('rt')
    if (Math.abs(p.lx) > XI_STICK || Math.abs(p.ly) > XI_STICK) {
      // XInput Y axis points up
      if (Math.abs(p.lx) > Math.abs(p.ly)) active.add(p.lx > 0 ? 'right' : 'left')
      else active.add(p.ly > 0 ? 'up' : 'down')
    }
  }
  return active
}

/**
 * Turns "currently held actions" into dispatches with key-repeat. Shared by both backends.
 * Buttons already held when the window regains focus are ignored until released, so the
 * button that closed a game does not also trigger something in Lumen.
 */
function createPadProcessor(): (active: Set<Action>, t: number) => void {
  const held = new Map<Action, { since: number; last: number }>()
  const suppressed = new Set<Action>()
  let hadFocus = document.hasFocus()
  return (active, t) => {
    const focused = document.hasFocus() && !document.hidden
    if (!focused) {
      hadFocus = false
      held.clear()
      return
    }
    if (!hadFocus) {
      hadFocus = true
      active.forEach((a) => suppressed.add(a))
    }
    for (const a of [...suppressed]) if (!active.has(a)) suppressed.delete(a)
    for (const a of [...held.keys()]) if (!active.has(a)) held.delete(a)
    for (const a of active) {
      if (suppressed.has(a)) continue
      const h = held.get(a)
      if (!h) {
        held.set(a, { since: t, last: t })
        dispatch(a, 'gamepad')
      } else if (REPEATABLE.has(a)) {
        const age = t - h.since
        const interval = age > 1500 ? FAST_REPEAT_MS : REPEAT_MS
        if (age > FIRST_REPEAT_MS && t - h.last >= interval) {
          h.last = t
          dispatch(a, 'gamepad')
        }
      }
    }
  }
}

/**
 * Default backend: XInput read passively by the main process. The page never touches the
 * Gamepad API, so Chromium never opens or initialises controllers (see main/input/xinput.ts).
 */
export function installXInputGamepad(): () => void {
  const process = createPadProcessor()
  let active = new Set<Action>()
  let seen = false
  const off = window.lumen.app.onPadState((pads) => {
    active = xinputActions(pads)
    if (pads.length && !seen) {
      seen = true
      useStore.getState().setInputMode('gamepad')
    }
  })
  const timer = setInterval(() => process(active, performance.now()), 16)
  return () => {
    off()
    clearInterval(timer)
  }
}

/** Fallback backend: Chromium Gamepad API (also sees PlayStation/Switch pads without Steam Input). */
export function installGamepad(): () => void {
  const process = createPadProcessor()
  let raf = 0
  let connected = 0

  const loop = (t: number): void => {
    raf = requestAnimationFrame(loop)
    if (!connected) return
    const pads = navigator.getGamepads?.() ?? []
    process(readPadActions(pads), t)
  }
  const onConnect = (e: GamepadEvent): void => {
    connected++
    console.info(`[lumen] gamepad connected: ${e.gamepad.id} (mapping=${e.gamepad.mapping || 'none'})`)
    useStore.getState().setInputMode('gamepad')
  }
  const onDisconnect = (): void => {
    connected = Math.max(0, connected - 1)
  }
  window.addEventListener('gamepadconnected', onConnect)
  window.addEventListener('gamepaddisconnected', onDisconnect)
  // pads that were connected before the page loaded only show up after a button press
  connected = (navigator.getGamepads?.() ?? []).filter(Boolean).length
  raf = requestAnimationFrame(loop)
  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('gamepadconnected', onConnect)
    window.removeEventListener('gamepaddisconnected', onDisconnect)
  }
}
