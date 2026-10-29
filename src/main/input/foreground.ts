import { log } from '../logger'

// Which window has the foreground when Lumen's window lost focus. Something invisible (a
// notification, an overlay, the desktop / taskbar after a stray click) can take the focus while
// Lumen stays on top on screen — the pad then went silent. Pad input stays on when the foreground
// window is not another real application window (invisible, minimized, empty, the shell); a real
// window of another app (a browser, a game) still turns the pad off.

const SHELL = new Set(['Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Progman', 'WorkerW', 'NotifyIconOverflowWindow',
  'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow', 'ForegroundStaging'])

export interface Foreground {
  /** another application's real window is in front — the pad belongs to it */
  other: boolean
  /** for the log: window class, visibility */
  desc: string
}

type Probe = (own: bigint) => Foreground

function load(): Probe | null {
  if (process.platform !== 'win32') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const u = koffi.load('user32.dll')
    const RECT = koffi.struct('LUMEN_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
    const getFg = u.func('__stdcall', 'GetForegroundWindow', 'intptr', [])
    const visible = u.func('__stdcall', 'IsWindowVisible', 'int32', ['intptr'])
    const iconic = u.func('__stdcall', 'IsIconic', 'int32', ['intptr'])
    const rect = u.func('__stdcall', 'GetWindowRect', 'int32', ['intptr', koffi.out(koffi.pointer(RECT))])
    const cls = u.func('__stdcall', 'GetClassNameW', 'int32', ['intptr', koffi.out(koffi.pointer('uint16', 256)), 'int32'])
    const pidOf = u.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', koffi.out(koffi.pointer('uint32'))])
    return (own) => {
      const h = BigInt(getFg() as number | bigint)
      if (h === 0n) return { other: false, desc: 'brak okna' }
      if (h === own) return { other: false, desc: 'Lumen' }
      const buf = new Array<number>(256).fill(0)
      const n = cls(h, buf, 256) as number
      const name = String.fromCharCode(...buf.slice(0, Math.max(0, n)))
      const pid = [0]
      pidOf(h, pid)
      const r = { left: 0, top: 0, right: 0, bottom: 0 }
      rect(h, r)
      const empty = r.right - r.left < 50 || r.bottom - r.top < 50
      const vis = !!visible(h) && !iconic(h)
      const ownProc = pid[0] === process.pid
      const desc = `${name || '?'} (pid ${pid[0]}, ${vis ? 'widoczne' : 'niewidoczne'}${empty ? ', puste' : ''})`
      return { other: vis && !empty && !ownProc && !SHELL.has(name), desc }
    }
  } catch (e) {
    log.warn('input', `foreground window check unavailable: ${(e as Error).message}`)
    return null
  }
}

const probe = load()

/** Foreground window when Lumen's window (`own` — its native handle) has no focus; null = unknown. */
export function foreground(own: bigint): Foreground | null {
  try {
    return probe ? probe(own) : null
  } catch {
    return null
  }
}
