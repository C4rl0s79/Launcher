import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { EngineState } from '@shared/types'
import { log, registerSecret } from '../logger'

// The EmuStart client (engine/, Python) runs headless next to Lumen: `engine_main.py` starts the
// EmuStart Api with its local HTTP server on 127.0.0.1 and prints the port. All emulation logic
// (server library, downloads, emulators, BIOS, saves, in-game menu) stays in that code; Lumen only
// calls its methods. See docs/INTEGRATION.md.

export interface EngineCommand {
  file: string
  args: string[]
  cwd: string
}

export interface EngineOptions {
  /** how to start the engine; undefined = not available on this PC (message explains why) */
  command: () => EngineCommand | { error: string }
  /** EmuStart data folder (EMUSTART_HOME) */
  home: () => string
  /** temp folder for the engine (TEMP/TMP) — inside the app's data folder, not %TEMP% */
  tempDir: () => string
  windowTitle: string
}

const MAX_RESTARTS = 3
const HANDSHAKE_MS = 45_000

export class EngineError extends Error {}

/**
 * Lifecycle of the engine process. Emits "state" (EngineState) and "event" ({type, …}) for
 * engine-originated events such as "quit" from the fullscreen menu.
 */
export class EmustartEngine extends EventEmitter {
  private proc: ChildProcess | null = null
  private port = 0
  private token = ''
  private _state: EngineState = 'disabled'
  private _message: string | undefined
  private _version: string | undefined
  private restarts = 0
  private stopping = false
  private restartTimer: NodeJS.Timeout | undefined

  constructor(private readonly opts: EngineOptions) {
    super()
  }

  get state(): EngineState {
    return this._state
  }
  get message(): string | undefined {
    return this._message
  }
  get version(): string | undefined {
    return this._version
  }
  /** http://127.0.0.1:<port> of the engine (UI files, /media) — empty while not ready */
  get baseUrl(): string {
    return this._state === 'ready' ? `http://127.0.0.1:${this.port}` : ''
  }
  get sessionToken(): string {
    return this.token
  }

  private setState(s: EngineState, message?: string): void {
    this._state = s
    this._message = message
    this.emit('state', s)
  }

  async start(): Promise<void> {
    if (this.proc) return
    this.stopping = false
    const cmd = this.opts.command()
    if ('error' in cmd) {
      this.setState('missing', cmd.error)
      log.warn('engine', cmd.error)
      return
    }
    const home = this.opts.home()
    const other = await emustartRunningFrom(home)
    if (other) {
      this.setState('error', `EmuStart (${other}) korzysta już z folderu danych ${home}. Zamknij go albo wybierz inny folder w Ustawieniach.`)
      return
    }
    this.token = randomBytes(24).toString('hex')
    registerSecret(this.token)
    this.setState('starting')
    log.info('engine', `start: ${cmd.file} ${cmd.args.join(' ')} (dane: ${home})`)
    const proc = spawn(cmd.file, cmd.args, {
      cwd: cmd.cwd,
      env: {
        ...process.env,
        EMUSTART_HOME: home,
        TEMP: this.opts.tempDir(),
        TMP: this.opts.tempDir(),
        LUMEN_ENGINE_TOKEN: this.token,
        LUMEN_WINDOW_TITLE: this.opts.windowTitle,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.proc = proc
    let buf = ''
    let errTail = ''
    const handshake = setTimeout(() => {
      if (this._state === 'starting') {
        log.error('engine', 'no handshake from the engine')
        proc.kill()
      }
    }, HANDSHAKE_MS)
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) this.onLine(line, handshake)
      }
    })
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (chunk: string) => {
      errTail = (errTail + chunk).slice(-2000)
    })
    proc.on('error', (e) => {
      log.error('engine', `cannot start: ${e.message}`)
      errTail += e.message
    })
    proc.on('exit', (code) => {
      clearTimeout(handshake)
      this.proc = null
      this.port = 0
      if (this.stopping) {
        this.setState('disabled')
        return
      }
      const tail = errTail.trim().split('\n').slice(-3).join(' ').slice(0, 400)
      log.error('engine', `exited with ${code}: ${tail}`)
      const why = /No module named|ModuleNotFoundError/.test(tail)
        ? `Brakuje modułów Pythona dla EmuStart (${tail.match(/No module named '?([\w.]+)/)?.[1] ?? '?'}). Zainstaluj: pip install -r engine/requirements.txt`
        : `Silnik EmuStart zakończył pracę (kod ${code}). ${tail}`
      if (this.restarts < MAX_RESTARTS && this._state === 'ready') {
        this.restarts++
        this.setState('starting', `${why} — ponowne uruchomienie…`)
        this.restartTimer = setTimeout(() => void this.start(), 1500 * this.restarts)
      } else {
        this.setState('error', why)
      }
    })
  }

  private onLine(line: string, handshake: NodeJS.Timeout): void {
    let msg: { lumen_engine?: number; port?: number; version?: string; lumen_event?: { type: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      return // ordinary output of a library — ignored
    }
    if (msg.lumen_engine && msg.port) {
      clearTimeout(handshake)
      this.port = msg.port
      this._version = msg.version
      log.info('engine', `ready on port ${msg.port}, EmuStart ${msg.version}`)
      this.setState('ready')
    } else if (msg.lumen_event) {
      this.emit('event', msg.lumen_event)
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.restartTimer)
    const p = this.proc
    if (!p) return
    this.stopping = true
    // closing stdin makes the engine finish its jobs (save uploads) and exit
    p.stdin?.end()
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill()
        resolve()
      }, 8000)
      p.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  async restart(): Promise<void> {
    await this.stop()
    this.restarts = 0
    await this.start()
  }

  /** Calls a method of the EmuStart Api (emustart/api.py, emustart/lumen.py). */
  async call<T = unknown>(method: string, args: unknown[] = [], timeoutMs = 30_000): Promise<T> {
    if (this._state !== 'ready') throw new EngineError(this._message ?? 'Silnik EmuStart nie działa.')
    if (!/^[a-z][a-z0-9_]*$/.test(method)) throw new EngineError(`Nieprawidłowa metoda ${method}`)
    if (process.env.LUMEN_DRY_RUN === '1' && (method === 'launch' || method === 'configure_emulator')) {
      log.info('engine', `DRY RUN, not calling ${method}`)
      throw new EngineError('Tryb testowy (LUMEN_DRY_RUN=1): uruchamianie gier jest wyłączone.')
    }
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/${method}`, {
        method: 'POST',
        headers: { 'X-EmuStart': '1', 'X-Lumen-Token': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: ctl.signal
      })
      if (!res.ok) throw new EngineError(`EmuStart: ${method} → HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (e) {
      if (e instanceof EngineError) throw e
      throw new EngineError(ctl.signal.aborted ? `EmuStart nie odpowiada (${method}).` : `EmuStart: ${(e as Error).message}`)
    } finally {
      clearTimeout(t)
    }
  }
}

/** How to run the engine: the bundled EmuStartEngine.exe, or engine_main.py with Python (sources). */
export function resolveEngineCommand(opts: { resourcesPath?: string; appPath: string; pythonPath?: string }): EngineCommand | { error: string } {
  const bundled = opts.resourcesPath ? path.join(opts.resourcesPath, 'engine', 'EmuStartEngine', 'EmuStartEngine.exe') : ''
  if (bundled && existsSync(bundled)) return { file: bundled, args: [], cwd: path.dirname(bundled) }
  const dir = path.join(opts.appPath, 'engine')
  const main = path.join(dir, 'engine_main.py')
  if (!existsSync(main)) return { error: 'Nie znaleziono silnika EmuStart (engine/engine_main.py ani EmuStartEngine.exe).' }
  const py = opts.pythonPath || process.env.LUMEN_PYTHON
  if (py) return { file: py, args: [main], cwd: dir }
  // Windows launcher for Python (installed with python.org builds); picks the newest Python 3
  return { file: process.platform === 'win32' ? 'py' : 'python3', args: process.platform === 'win32' ? ['-3', main] : [main], cwd: dir }
}

/** Name of a running standalone EmuStart whose program folder is `dir` (it keeps its data there). */
export function emustartRunningFrom(dir: string): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "Get-Process EmuStart -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null)
        const want = path.resolve(dir).toLowerCase()
        const hit = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((p) => p && path.dirname(path.resolve(p)).toLowerCase() === want)
        resolve(hit ? path.basename(hit) : null)
      }
    )
  })
}
