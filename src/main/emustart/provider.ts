import { EventEmitter } from 'node:events'
import type { EmuLaunchStatus, EmuRuntime, EmustartSummary, Game } from '@shared/types'
import { log } from '../logger'
import { JsonFile } from '../store/jsonFile'
import type { EmustartEngine } from './engine'
import { emuGames, isEmuGameId, type EmuLibrary, type EmuLibraryRow } from './mapping'

/** Raw `lumen_status` from the engine (emustart/lumen.py). */
export interface EmuStatusRaw {
  launch: EmuLaunchStatus
  copies: { game_id: number; title: string; done: number; total: number; speed?: number; eta?: number; files?: number; file?: number }[]
  install: EmuInstallStatus | null
  emu_sync: EmuInstallStatus | null
  post: string
  scan: { running: boolean; text: string; done: number; total: number }
  server: EmuLibrary['server']
  conflicts: EmuRuntime['conflicts']
  lib_version: number
  /** local game cache summary — changes when a download completes or a copy is removed */
  cache?: { games: number; bytes: number; pinned: number }
}

/** installer.Job.status() (engine/emustart/installer.py) */
export interface EmuInstallStatus {
  running: boolean
  step: number
  steps: number
  current: string
  done: number
  total: number
  errors: string[]
  installed: string[]
  postponed: string[]
  cancelled: boolean
}

const POLL_MS = 1500
const EMPTY: EmuLibrary = { systems: [], games: [], lib_version: 0, server: null, configured: false }

/**
 * EmuStart side of the unified library: the server library as seen by the engine (it keeps its own
 * offline copy), plus the live job state. A copy of the last library is saved so the games stay
 * visible when the engine cannot start (Python missing) — they are not playable then.
 */
export class EmustartProvider extends EventEmitter {
  private lib: EmuLibrary = EMPTY
  private fromCache = false
  private games: Game[] = []
  private rows = new Map<string, EmuLibraryRow>()
  private status: EmuStatusRaw | null = null
  private pollTimer: NodeJS.Timeout | undefined
  private refreshing: Promise<void> | null = null
  private copyingKey = ''
  private lastLaunchPhase = 'idle'
  private cache: JsonFile<EmuLibrary>

  constructor(
    private readonly engine: EmustartEngine,
    cacheFile: string
  ) {
    super()
    this.cache = new JsonFile<EmuLibrary>(cacheFile, () => EMPTY)
    engine.on('state', (s) => {
      if (s === 'ready') {
        void this.refresh()
        this.startPolling()
      } else {
        this.stopPolling()
        this.status = null
        this.emit('status', null)
      }
      this.emit('library')
    })
  }

  async init(): Promise<void> {
    const cached = await this.cache.load()
    if (cached.games.length && !this.lib.games.length) {
      this.fromCache = true
      this.setLib(cached)
    }
  }

  get currentGames(): Game[] {
    return this.games
  }

  get raw(): EmuStatusRaw | null {
    return this.status
  }

  /** engine-local game number for a Lumen id */
  engineId(gameId: string): number | undefined {
    return isEmuGameId(gameId) ? this.rows.get(gameId)?.id : undefined
  }

  row(gameId: string): EmuLibraryRow | undefined {
    return this.rows.get(gameId)
  }

  /** Lumen id of an engine game number */
  lumenId(engineId: number): string | undefined {
    for (const [id, r] of this.rows) if (r.id === engineId) return id
    return undefined
  }

  summary(): EmustartSummary {
    const e = this.engine
    return {
      engine: e.state,
      message: e.message,
      version: e.version,
      server: this.status?.server ?? this.lib.server,
      profile: this.lib.profile?.name,
      systems: this.lib.systems.map((s) => ({ es: s.es, display: s.display, games: s.games, cached: s.cached, emulator: s.emulator })),
      fromCache: this.fromCache,
      configured: this.lib.configured
    }
  }

  runtime(): EmuRuntime | null {
    const s = this.status
    if (!s) return null
    return { launch: s.launch, postPending: s.post, conflicts: s.conflicts, server: s.server }
  }

  private copyingSet(): Set<number> {
    return new Set((this.status?.copies ?? []).map((c) => c.game_id))
  }

  private setLib(lib: EmuLibrary): void {
    this.lib = lib
    this.games = emuGames(lib, this.copyingSet())
    this.rows = new Map(lib.games.map((r) => [`emu:${r.sid}`, r]))
    this.emit('library')
  }

  /** Re-reads the library from the engine (after server sync, downloads, a finished game). */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const lib = await this.engine.call<EmuLibrary>('lumen_library', [], 120_000)
        this.fromCache = false
        this.setLib(lib)
        await this.cache.save(lib)
      } catch (e) {
        log.warn('emustart', `library: ${(e as Error).message}`)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  private startPolling(): void {
    this.stopPolling()
    const tick = async (): Promise<void> => {
      try {
        const st = await this.engine.call<EmuStatusRaw>('lumen_status', [], 10_000)
        const prevVersion = this.status?.lib_version
        const prevCache = this.status?.cache
        this.status = st
        const key = st.copies.map((c) => c.game_id).sort().join(',')
        const phase = st.launch?.phase ?? 'idle'
        // the library changed under us: new server data, a download finished, a game ended
        const libChanged =
          (prevVersion !== undefined && prevVersion !== st.lib_version) ||
          (prevCache !== undefined && JSON.stringify(prevCache) !== JSON.stringify(st.cache))
        const copiesChanged = key !== this.copyingKey
        const launchEnded = this.lastLaunchPhase !== phase && ['finished', 'error', 'cancelled', 'idle'].includes(phase)
        this.copyingKey = key
        this.lastLaunchPhase = phase
        if (libChanged || copiesChanged || launchEnded) void this.refresh()
        this.emit('status', st)
      } catch (e) {
        log.warn('emustart', `status: ${(e as Error).message}`)
      }
      if (this.engine.state === 'ready') this.pollTimer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
  }

  private stopPolling(): void {
    clearTimeout(this.pollTimer)
    this.pollTimer = undefined
  }

  stop(): void {
    this.stopPolling()
  }
}
