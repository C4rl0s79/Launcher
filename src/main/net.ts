import { log, redact } from './logger'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
  }
}

export class NetworkError extends Error {}

/** fetch() with a hard timeout; network failures are normalised into NetworkError. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  // LUMEN_OFFLINE=1 simulates a dead network (manual testing of offline behaviour)
  if (process.env.LUMEN_OFFLINE === '1') throw new NetworkError(`Network error (simulated offline) for ${redact(url)}`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) {
      const ra = res.headers.get('retry-after')
      const retryAfterMs = ra ? (Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Date.parse(ra) - Date.now()) : undefined
      throw new HttpError(res.status, `HTTP ${res.status} for ${redact(url)}`, retryAfterMs)
    }
    return res
  } catch (e) {
    if (e instanceof HttpError) throw e
    const msg = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message
    throw new NetworkError(`Network error (${msg}) for ${redact(url)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Concurrency limiter with optional global pause (used to back off after HTTP 429).
 */
export class Limiter {
  private active = 0
  private waiting: (() => void)[] = []
  private pausedUntil = 0

  constructor(
    private readonly max: number,
    private readonly name: string
  ) {}

  pause(ms: number): void {
    const until = Date.now() + Math.min(Math.max(ms, 1000), 120000)
    if (until > this.pausedUntil) {
      this.pausedUntil = until
      log.warn('net', `${this.name}: backing off for ${Math.round((until - Date.now()) / 1000)} s`)
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    try {
      const wait = this.pausedUntil - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }

  get pending(): number {
    return this.active + this.waiting.length
  }
}
