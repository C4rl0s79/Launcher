import { EventEmitter } from 'node:events'
import type { EmuLaunchStatus, EmuRuntime, EmustartSummary, Game, RegionOrder } from '@shared/types'
import { log } from '../logger'
import { JsonFile } from '../store/jsonFile'
import type { EmustartEngine } from './engine'
import { emuGames, isEmuGameId, type EmuLibrary, type EmuLibraryRow } from './mapping'
import { GROUP_PREFIX, groupVersions } from './versions'

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
  private byEngine = new Map<number, string>()
  /** emugrp:… → member ids; member id → emugrp:… (games with several versions) */
  private members = new Map<string, Game[]>()
  private displayOf = new Map<string, string>()
  private shown = new Map<string, string>()
  private status: EmuStatusRaw | null = null
  private pollTimer: NodeJS.Timeout | undefined
  private refreshing: Promise<void> | null = null
  private copyingKey = ''
  private lastLaunchPhase = 'idle'
  private cache: JsonFile<EmuLibrary>

  constructor(
    private readonly engine: EmustartEngine,
    cacheFile: string,
    /** desktop grouping of regional versions: region preference and the player's choices */
    private readonly grouping: () => { order: RegionOrder; choices: Record<string, string> } = () => ({ order: 'europe', choices: {} })
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

  /** the version (emu:<sid>) a Lumen id stands for — a game with several versions plays its shown one */
  resolve(gameId: string): string {
    return gameId.startsWith(GROUP_PREFIX) ? (this.shown.get(gameId) ?? gameId) : gameId
  }

  /** engine-local game number for a Lumen id */
  engineId(gameId: string): number | undefined {
    const id = this.resolve(gameId)
    return isEmuGameId(id) ? this.rows.get(id)?.id : undefined
  }

  row(gameId: string): EmuLibraryRow | undefined {
    return this.rows.get(this.resolve(gameId))
  }

  /** library row of an engine game number (any version, shown or not) */
  rowByEngineId(engineId: number): EmuLibraryRow | undefined {
    const id = this.byEngine.get(engineId)
    return id ? this.rows.get(id) : undefined
  }

  /** id of the library entry that shows a version (emugrp:… for grouped games) */
  displayId(id: string): string {
    return this.displayOf.get(id) ?? id
  }

  /** Lumen id (entry shown in the library) of an engine game number */
  lumenId(engineId: number): string | undefined {
    const id = this.byEngine.get(engineId)
    return id ? this.displayId(id) : undefined
  }

  /** versions of a grouped entry (empty for a single version) */
  versionsOf(gameId: string): Game[] {
    return this.members.get(gameId) ?? []
  }

  /** re-apply grouping (region preference or a version choice changed) */
  regroup(): void {
    this.applyGrouping()
    this.emit('library')
  }

  private base: Game[] = []

  private applyGrouping(): void {
    const { order, choices } = this.grouping()
    const g = groupVersions(this.base, order, choices)
    this.games = g.games
    this.members = g.members
    this.displayOf = g.displayOf
    this.shown = new Map(g.games.filter((x) => x.emu?.shownVersion).map((x) => [x.id, x.emu!.shownVersion!]))
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
    this.base = emuGames(lib, this.copyingSet())
    this.rows = new Map(lib.games.map((r) => [`emu:${r.sid}`, r]))
    this.byEngine = new Map(lib.games.map((r) => [r.id, `emu:${r.sid}`]))
    this.applyGrouping()
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
