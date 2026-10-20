import { EventEmitter } from 'node:events'
import type { Game, JobsSnapshot, LibrarySnapshot } from '@shared/types'
import type { LibraryService } from '../library/service'
import type { EmustartProvider } from '../emustart/provider'
import { emuJobs, steamJobs } from './jobs'

/**
 * One library for both interfaces: Steam games (LibraryService) and EmuStart games
 * (EmustartProvider) side by side. Games are never merged by title — the Steam release and an
 * emulated release of the same title are separate entries with their own ids and actions.
 * Emits "snapshot" (LibrarySnapshot) and "jobs" (JobsSnapshot).
 */
export class UnifiedLibrary extends EventEmitter {
  private snap: LibrarySnapshot
  private jobsSnap: JobsSnapshot = { jobs: [], emu: null }
  private byId = new Map<string, Game>()

  constructor(
    private readonly steam: LibraryService,
    private readonly emu: EmustartProvider
  ) {
    super()
    this.snap = this.compose()
    steam.on('snapshot', () => this.update())
    emu.on('library', () => this.update())
    emu.on('status', () => this.updateJobs())
  }

  private compose(): LibrarySnapshot {
    const s = this.steam.current
    return { ...s, games: [...s.games, ...this.emu.currentGames], emustart: this.emu.summary() }
  }

  private update(): void {
    this.snap = this.compose()
    this.byId = new Map(this.snap.games.map((g) => [g.id, g]))
    this.emit('snapshot', this.snap)
    this.updateJobs()
  }

  private updateJobs(): void {
    const jobs = [...steamJobs(this.steam.current.games), ...emuJobs(this.emu.raw, (n) => this.emu.lumenId(n))]
    const next: JobsSnapshot = { jobs, emu: this.emu.runtime() }
    if (JSON.stringify(next) === JSON.stringify(this.jobsSnap)) return
    this.jobsSnap = next
    this.emit('jobs', next)
  }

  get current(): LibrarySnapshot {
    return this.snap
  }

  get jobs(): JobsSnapshot {
    return this.jobsSnap
  }

  game(id: string): Game | undefined {
    return this.byId.get(id) ?? this.snap.games.find((g) => g.id === id)
  }
}
