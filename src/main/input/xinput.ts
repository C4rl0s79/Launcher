import { log } from '../logger'

// Controller input through XInput, the same passive API games use.
//
// Why not Chromium's Gamepad API: as soon as a page uses it, Chromium on Windows opens the
// devices itself (XInput + Raw Input/HID + Windows.Gaming.Input) and initialises pads that are
// hot-plugged while it runs. Users reported a pad switching itself off when turned on with
// Lumen running (fine when on before start, fine once Lumen closed). XInputGetState only reads
// state and never talks to the device, so Lumen polls it here and Chromium never touches pads.
//
// XInput covers Xbox pads and any pad presented as one (Steam Input virtual pads, 8BitDo/X-mode…).

import type { PadState } from '@shared/types'
export type { PadState }

type GetState = (index: number, out: { Gamepad?: Omit<PadState, 'index'> & Record<string, number> }) => number

const ERROR_SUCCESS = 0
const FOCUSED_MS = 16
const IDLE_MS = 250
const EMPTY_SLOT_RECHECK_MS = 1000

function loadXInput(): GetState | null {
  if (process.platform !== 'win32') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    let lib: ReturnType<typeof koffi.load> | null = null
    for (const dll of ['xinput1_4.dll', 'xinput9_1_0.dll', 'xinput1_3.dll']) {
      try {
        lib = koffi.load(dll)
        break
      } catch {
        /* try next */
      }
    }
    if (!lib) return null
    const GAMEPAD = koffi.struct('LUMEN_XINPUT_GAMEPAD', {
      wButtons: 'uint16',
      bLeftTrigger: 'uint8',
      bRightTrigger: 'uint8',
      sThumbLX: 'int16',
      sThumbLY: 'int16',
      sThumbRX: 'int16',
      sThumbRY: 'int16'
    })
    const STATE = koffi.struct('LUMEN_XINPUT_STATE', { dwPacketNumber: 'uint32', Gamepad: GAMEPAD })
    const fn = lib.func('__stdcall', 'XInputGetState', 'uint32', ['uint32', koffi.out(koffi.pointer(STATE))])
    return (index, out) => fn(index, out) as number
  } catch (e) {
    log.warn('input', `XInput unavailable: ${(e as Error).message}`)
    return null
  }
}

export class XInputPoller {
  private getState: GetState | null = loadXInput()
  private timer: NodeJS.Timeout | undefined
  private lastSent = ''
  private nextEmptyCheck = [0, 0, 0, 0]

  get available(): boolean {
    return !!this.getState
  }

  /** Polls only while `shouldPoll()` is true; `onChange` gets the connected pads whenever input changes. */
  start(shouldPoll: () => boolean, onChange: (pads: PadState[]) => void): void {
    if (!this.getState || this.timer) return
    log.info('input', 'controller input via XInput')
    const tick = (): void => {
      const active = shouldPoll()
      const pads = active ? this.read() : []
      const key = JSON.stringify(pads)
      if (key !== this.lastSent) {
        this.lastSent = key
        onChange(pads)
      }
      this.timer = setTimeout(tick, active ? FOCUSED_MS : IDLE_MS)
    }
    tick()
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private read(): PadState[] {
    const out: PadState[] = []
    const now = Date.now()
    for (let i = 0; i < 4; i++) {
      if (this.nextEmptyCheck[i] > now) continue
      const s: { Gamepad?: Record<string, number> } = {}
      if (this.getState!(i, s as never) !== ERROR_SUCCESS || !s.Gamepad) {
        // empty slots are re-checked once a second, connected ones every frame
        this.nextEmptyCheck[i] = now + EMPTY_SLOT_RECHECK_MS
        continue
      }
      const g = s.Gamepad
      out.push({ index: i, buttons: g.wButtons, lt: g.bLeftTrigger, rt: g.bRightTrigger, lx: g.sThumbLX, ly: g.sThumbLY })
    }
    return out
  }
}
