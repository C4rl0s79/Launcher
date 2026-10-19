import { createWriteStream, promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import type { GameDetails, LaunchBoxStatus } from '@shared/types'
import { log } from '../logger'
import createBuildWorker from './worker?nodeWorker'
import { findGame, toDetails, type GameRow } from './lookup'

// LaunchBox Games DB as an offline metadata source for non-Steam games (emulators).
// The whole database is published as one Metadata.zip (~110 MB, ~190k games). Lumen downloads
// it on request, builds data/launchbox.db once, and afterwards answers lookups offline.
// Same approach and matching rules as EmuStart (emustart/launchbox.py).

export const METADATA_URL = 'https://gamesdb.launchbox-app.com/Metadata.zip'


export class LaunchBoxService extends EventEmitter {
  private job: { phase: 'download' | 'build'; done: number; total: number; abort: AbortController } | null = null
  private lastError: string | undefined
  private db: DatabaseSync | null = null

  constructor(private readonly dir: string) {
    super()
  }

  get dbPath(): string {
    return path.join(this.dir, 'launchbox.db')
  }

  private open(): DatabaseSync | null {
    if (this.db) return this.db
    try {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true })
      return this.db
    } catch {
      return null
    }
  }

  private close(): void {
    try {
      this.db?.close()
    } catch {
      /* ignore */
    }
    this.db = null
  }

  async status(): Promise<LaunchBoxStatus> {
    const base: LaunchBoxStatus = { ready: false, error: this.lastError }
    if (this.job) base.job = { phase: this.job.phase, done: this.job.done, total: this.job.total }
    const db = this.open()
    if (!db) return base
    try {
      const meta = Object.fromEntries((db.prepare('SELECT k, v FROM meta').all() as { k: string; v: string }[]).map((r) => [r.k, r.v]))
      const size = (await fs.stat(this.dbPath)).size
      return { ...base, ready: !!meta.updated, updated: meta.updated, games: Number(meta.games ?? 0), sizeBytes: size }
    } catch {
      return base
    }
  }

  /** Download Metadata.zip and rebuild the database in a worker thread. */
  async update(): Promise<void> {
    if (this.job) return
    const abort = new AbortController()
    this.job = { phase: 'download', done: 0, total: 0, abort }
    this.lastError = undefined
    this.emit('changed')
    const zip = path.join(this.dir, 'Metadata.zip')
    const tmpDb = this.dbPath + '.new'
    try {
      await fs.mkdir(this.dir, { recursive: true })
      log.info('launchbox', 'downloading Metadata.zip')
      const res = await fetch(METADATA_URL, { signal: abort.signal, headers: { 'User-Agent': 'Lumen launcher' } })
      if (!res.ok || !res.body) throw new Error(`Serwer LaunchBox odpowiedział HTTP ${res.status}.`)
      this.job.total = Number(res.headers.get('content-length') ?? 0)
      let lastEmit = 0
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        if (!this.job) return
        this.job.done += chunk.length
        if (Date.now() - lastEmit > 400) {
          lastEmit = Date.now()
          this.emit('changed')
        }
      })
      await pipeline(body, createWriteStream(zip + '.part'))
      await fs.rename(zip + '.part', zip)

      this.job.phase = 'build'
      this.job.done = 0
      this.job.total = 0
      this.emit('changed')
      await fs.rm(tmpDb, { force: true })
      const result = await new Promise<{ games: number }>((resolve, reject) => {
        const w = createBuildWorker({ workerData: { zipPath: zip, outPath: tmpDb } })
        abort.signal.addEventListener('abort', () => void w.terminate())
        w.on('message', (m: { type: string; games?: number; message?: string }) => {
          if (m.type === 'progress' && this.job) {
            this.job.done = m.games ?? 0
            this.emit('changed')
          } else if (m.type === 'done') resolve({ games: m.games ?? 0 })
          else if (m.type === 'error') reject(new Error(m.message))
        })
        w.on('error', reject)
        w.on('exit', (code) => code !== 0 && reject(new Error(abort.signal.aborted ? 'Przerwano.' : `Worker exit ${code}`)))
      })
      this.close()
      await fs.rename(tmpDb, this.dbPath)
      log.info('launchbox', `database built: ${result.games} games`)
    } catch (e) {
      this.lastError = abort.signal.aborted ? 'Przerwano.' : (e as Error).message
      log.warn('launchbox', `update failed: ${this.lastError}`)
      await fs.rm(tmpDb, { force: true }).catch(() => undefined)
    } finally {
      await fs.rm(zip, { force: true }).catch(() => undefined)
      await fs.rm(zip + '.part', { force: true }).catch(() => undefined)
      this.job = null
      this.emit('changed')
    }
  }

  cancel(): void {
    this.job?.abort.abort()
  }

  /** Best LaunchBox entry for a title on a platform (platform optional). Port of EmuStart's _find_game. */
  find(name: string, platform: string | undefined): GameRow | null {
    const db = this.open()
    if (!db) return null
    try {
      return findGame(db, name, platform)
    } catch (e) {
      log.warn('launchbox', `lookup failed for "${name}": ${(e as Error).message}`)
      return null
    }
  }

  details(name: string, platform: string | undefined): GameDetails | null {
    const g = this.find(name, platform)
    return g ? toDetails(g) : null
  }
}
