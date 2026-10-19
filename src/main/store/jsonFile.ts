import { promises as fs } from 'node:fs'
import path from 'node:path'
import { log } from '../logger'

/**
 * Crash-safe JSON persistence: write to a temp file, fsync, then rename over the target.
 * The previous version is kept as <file>.bak and used if the main file is corrupt.
 * Writes are serialised per file so concurrent saves cannot interleave.
 */
export class JsonFile<T> {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    readonly file: string,
    private readonly defaults: () => T,
    private readonly migrate: (raw: unknown) => T = (raw) => raw as T
  ) {}

  async load(): Promise<T> {
    for (const candidate of [this.file, this.file + '.bak']) {
      try {
        const text = await fs.readFile(candidate, 'utf8')
        const value = this.migrate(JSON.parse(text))
        if (candidate !== this.file) log.warn('store', `Recovered ${path.basename(this.file)} from backup`)
        return value
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') log.warn('store', `Cannot read ${path.basename(candidate)}: ${(e as Error).message}`)
      }
    }
    return this.defaults()
  }

  save(value: T): Promise<void> {
    const job = this.queue.then(() => this.writeNow(value))
    this.queue = job.catch(() => undefined)
    return job
  }

  private async writeNow(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fs.copyFile(this.file, this.file + '.bak')
    } catch {
      /* first save */
    }
    await fs.rename(tmp, this.file)
  }
}
