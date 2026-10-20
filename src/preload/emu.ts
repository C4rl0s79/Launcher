import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PadState } from '../shared/types'
import { EMU_UI, padActions, PadRepeater } from '../shared/emuPad'

// Bridge for EmuStart's own UI (engine/web/app.js, `?lumen`) shown as Lumen's fullscreen mode.
// app.js keeps calling `window.pywebview.api.<method>(…)`; with `?lumen` that proxy forwards to
// `window.lumenEmu.call`, which ends in the main process (core/fullscreenBridge.ts).
// Imports nothing shared with preload/index.ts: sandboxed preloads must be single files.

type PadCb = (action: string, up: boolean) => void

let padCb: PadCb | null = null
let active = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined
const repeater = new PadRepeater((a, up) => padCb?.(a, up))

// XInput state arrives only when it changes; held buttons repeat on this timer
ipcRenderer.on(EMU_UI.pad, (_e: IpcRendererEvent, pads: PadState[]) => {
  active = new Set<string>()
  for (const p of pads) for (const a of padActions(p)) active.add(a)
  repeater.update(active, performance.now())
  if (active.size && !timer) timer = setInterval(() => repeater.update(active, performance.now()), 16)
  else if (!active.size && timer) {
    clearInterval(timer)
    timer = undefined
  }
})

contextBridge.exposeInMainWorld('lumenEmu', {
  call: (name: string, args: unknown[]) => ipcRenderer.invoke(EMU_UI.call, String(name), Array.isArray(args) ? args : []),
  onPad: (cb: PadCb) => {
    padCb = cb
  },
  onFocusGame: (cb: (es: string, id: string | number) => void) => {
    ipcRenderer.on(EMU_UI.focusGame, (_e, es: string, id: string | number) => cb(es, id))
  },
  onOpen: (cb: (what: string) => void) => {
    ipcRenderer.on(EMU_UI.open, (_e, what: string) => cb(what))
  }
})
