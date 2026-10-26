import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ArtChoice, ArtKind, ArtSourcePriority, CacheStats, GameArtPrefs } from '@shared/types'
import { fetchWithTimeout, HttpError, Limiter, NetworkError } from '../net'
import { log } from '../logger'
import { pickBestMatch, pickExactMatch, SgdbAuthError, type SgdbClient } from './sgdb'

// Resolves the image file to display for (game, kind) and caches it on disk.
//
// Order:  explicit user choice  →  default chain (depends on settings.artPriority):
//         sgdbFirst:  SteamGridDB (if key) → Steam local librarycache → Steam CDN
//         steamFirst: Steam local librarycache → Steam CDN → SteamGridDB (if key)
//
// Every network lookup result is remembered in index.json — including misses (with TTL),
// so images are not re-requested on every start. Clearing the cache deletes only this
// directory; user choices live in prefs.json and custom files in a separate folder.

const MISS_TTL_MS = 5 * 24 * 3600 * 1000
const ERROR_RETRY_MS = 10 * 60 * 1000

interface IndexEntry {
  file?: string
  missUntil?: number
  sgdbGameId?: number
}

interface CacheIndex {
  version: 1
  entries: Record<string, IndexEntry>
}

export interface ArtDeps {
  cacheDir: string
  steamPath: () => string | undefined
  sgdb: SgdbClient
  priority: () => ArtSourcePriority
  prefsFor: (gameId: string) => GameArtPrefs | undefined
  /** userdata/<accountId>/config/grid of the active Steam account */
  userGridDir?: () => string | undefined
  /** injectable for tests */
  fetchBytes?: (url: string) => Promise<{ bytes: Buffer; contentType?: string } | null>
}

const STEAM_FILES: Partial<Record<ArtKind, string[]>> = {
  grid: ['library_600x900_2x.jpg', 'library_600x900.jpg', 'library_capsule.jpg'],
  hero: ['library_hero.jpg'],
  logo: ['logo.png']
}

const STEAM_CDN = 'https://shared.steamstatic.com/store_item_assets/steam/apps'

function extFor(contentType: string | undefined, url: string): string {
  if (contentType?.includes('png')) return '.png'
  if (contentType?.includes('webp')) return '.webp'
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg'
  const m = /\.(png|jpe?g|webp)(?:\?|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.img'
}

async function defaultFetchBytes(url: string): Promise<{ bytes: Buffer; contentType?: string } | null> {
  try {
    const res = await fetchWithTimeout(url, {}, 20000)
    const ct = res.headers.get('content-type') ?? undefined
    if (ct && !ct.startsWith('image/')) return null
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: ct }
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) return null
    throw e
  }
}

export class ArtworkService {
  private index: CacheIndex = { version: 1, entries: {} }
  private loaded = false
  private saveTimer: NodeJS.Timeout | undefined
  private inflight = new Map<string, Promise<string | null>>()
  private downloads = new Limiter(4, 'image-download', true)
  private fetchBytes: NonNullable<ArtDeps['fetchBytes']>
  private localDirCache = new Map<number, string[] | null>()

  constructor(private readonly deps: ArtDeps) {
    this.fetchBytes = deps.fetchBytes ?? defaultFetchBytes
  }

  private get indexFile(): string {
    return path.join(this.deps.cacheDir, 'index.json')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as CacheIndex
      if (raw?.version === 1 && raw.entries) this.index = raw
    } catch {
      /* empty cache */
    }
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flush(), 1500)
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer)
    // never read (nothing resolved yet, or a second Lumen quitting at once): the file on disk is newer
    if (!this.loaded) return
    try {
      await fs.mkdir(this.deps.cacheDir, { recursive: true })
      const tmp = this.indexFile + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(this.index))
      await fs.rename(tmp, this.indexFile)
    } catch (e) {
      log.warn('art', `Cannot save cache index: ${(e as Error).message}`)
    }
  }

  /**
   * Main entry used by the image protocol. Returns an absolute file path or null.
   * `appId` is the Steam store app id (undefined for non-Steam shortcuts); `gridId` is the id
   * Steam uses for custom artwork in userdata/<id>/config/grid (app id or shortcut id).
   */
  async resolve(gameId: string, appId: number | undefined, kind: ArtKind, name?: string, gridId: number | undefined = appId): Promise<string | null> {
    const key = `${gameId}|${kind}`
    const existing = this.inflight.get(key)
    if (existing) return existing
    const p = this.resolveInner(gameId, appId, kind, name, gridId)
      .catch((e) => {
        log.warn('art', `resolve ${key} failed: ${(e as Error).message}`)
        return null
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async resolveInner(
    gameId: string,
    appId: number | undefined,
    kind: ArtKind,
    name: string | undefined,
    gridId: number | undefined
  ): Promise<string | null> {
    await this.ensureLoaded()
    const prefs = this.deps.prefsFor(gameId)
    const choice: ArtChoice | undefined = prefs?.[kind]

    if (choice) {
      if (choice.type === 'none') return null
      if (choice.type === 'file') return (await exists(choice.file)) ? choice.file : null
      if (choice.type === 'sgdb') return this.cachedDownload(`${gameId}|${kind}|sgdb-${choice.imageId}`, choice.url, gameId, kind)
      if (choice.type === 'launchbox') return this.fromUrl(gameId, kind, choice.url)
      if (choice.type === 'steam') return (gridId && (await this.fromUserGrid(gridId, kind))) || (appId ? this.fromSteam(gameId, appId, kind) : null)
    }

    // Artwork the user set in Steam (or a tool like Steam ROM Manager wrote) beats automatic picks.
    if (gridId) {
      const custom = await this.fromUserGrid(gridId, kind)
      if (custom) return custom
    }

    const sgdb = (): Promise<string | null> => this.fromSgdbAuto(gameId, appId, kind, name ? [name] : [], prefs?.sgdbGameId, false)
    if (!appId) return sgdb()
    const steam = (): Promise<string | null> => this.fromSteam(gameId, appId, kind)
    const chain = this.deps.priority() === 'steamFirst' ? [steam, sgdb] : [sgdb, steam]
    for (const step of chain) {
      const r = await step()
      if (r) return r
    }
    return null
  }

  /**
   * Art for a game from another source (EmuStart): the user's choice, else SteamGridDB matched
   * strictly by title (any of `names`). A file; null when the user chose "none"; undefined = use
   * the source's own art (no choice, the "source" choice, or nothing found).
   */
  async resolveTitled(gameId: string, kind: ArtKind, names: string[], auto = true): Promise<string | null | undefined> {
    await this.ensureLoaded()
    const prefs = this.deps.prefsFor(gameId)
    const choice = prefs?.[kind]
    if (choice) {
      if (choice.type === 'none') return null
      if (choice.type === 'file') return (await exists(choice.file)) ? choice.file : undefined
      if (choice.type === 'sgdb') return (await this.cachedDownload(`${gameId}|${kind}|sgdb-${choice.imageId}`, choice.url, gameId, kind)) ?? undefined
      if (choice.type === 'launchbox') return (await this.fromUrl(gameId, kind, choice.url)) ?? undefined
      return undefined // 'steam' here means the source's own (official) art
    }
    if (!auto) return undefined
    const key = `${gameId}|${kind}|titled`
    let p = this.inflight.get(key)
    if (!p) {
      p = this.fromSgdbAuto(gameId, undefined, kind, names, prefs?.sgdbGameId, true)
        .catch((e) => {
          log.warn('art', `resolve ${key} failed: ${(e as Error).message}`)
          return null
        })
        .finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    return (await p) ?? undefined
  }

  /**
   * Whether resolveTitled(…, auto) answers without the network: the user's choice, or an earlier
   * SteamGridDB result or miss in the cache. Otherwise the caller shows the source's own art now
   * and lets the lookup finish in the background.
   */
  async titledDecided(gameId: string, kind: ArtKind): Promise<boolean> {
    await this.ensureLoaded()
    const prefs = this.deps.prefsFor(gameId)
    if (prefs?.[kind] || !this.deps.sgdb.enabled) return true
    const entry = this.index.entries[`${gameId}|${kind}|sgdb-auto${prefs?.sgdbGameId ? `-${prefs.sgdbGameId}` : ''}`]
    if (entry?.file || (entry?.missUntil && entry.missUntil > Date.now())) return true
    const match = this.index.entries[`${gameId}|match`]
    return !prefs?.sgdbGameId && !!match?.missUntil && match.missUntil > Date.now()
  }

  /** An image by address (LaunchBox Games DB), downloaded once and kept in the cache. */
  async fromUrl(gameId: string, kind: ArtKind, url: string): Promise<string | null> {
    await this.ensureLoaded()
    const tag = createHash('sha1').update(url).digest('hex').slice(0, 12)
    return this.cachedDownload(`${gameId}|${kind}|url-${tag}`, url, gameId, kind)
  }

  // ---------- Steam sources ----------

  /**
   * Custom artwork in userdata/<accountId>/config/grid, named by Steam's convention:
   * <id>p.* (portrait poster), <id>_hero.*, <id>_logo.*, <id>_icon.* / <id>.ico. Read-only.
   */
  private async fromUserGrid(gridId: number, kind: ArtKind): Promise<string | null> {
    const files = await this.userGridFiles()
    if (!files) return null
    const stems: Record<ArtKind, string[]> = {
      grid: [`${gridId}p`],
      hero: [`${gridId}_hero`],
      logo: [`${gridId}_logo`],
      icon: [`${gridId}_icon`, `${gridId}`]
    }
    const exts = kind === 'icon' ? ['.png', '.ico', '.jpg', '.webp'] : ['.png', '.jpg', '.jpeg', '.webp']
    for (const stem of stems[kind]) for (const ext of exts) {
      const hit = files.get(stem + ext)
      if (hit) return hit
    }
    return null
  }

  private gridListing: { at: number; dir: string; files: Map<string, string> | null } | undefined

  /** Directory listing cached for a few seconds (the folder can hold thousands of files). */
  private async userGridFiles(): Promise<Map<string, string> | null> {
    const dir = this.deps.userGridDir?.()
    if (!dir) return null
    const now = Date.now()
    if (this.gridListing && this.gridListing.dir === dir && now - this.gridListing.at < 10000) return this.gridListing.files
    let files: Map<string, string> | null = null
    try {
      files = new Map((await fs.readdir(dir)).map((f) => [f.toLowerCase(), path.join(dir, f)]))
    } catch {
      files = null
    }
    this.gridListing = { at: now, dir, files }
    return files
  }

  private async fromSteam(gameId: string, appId: number, kind: ArtKind): Promise<string | null> {
    const names = STEAM_FILES[kind]
    if (!names) return null
    // Names are ordered best-first. For each: Steam's local copy, then the public CDN (cached once).
    // This prefers a sharp 600x900 poster from the CDN over the 300x450 copy Steam keeps locally.
    for (const n of names) {
      const local = await this.findLocalSteamFile(appId, [n])
      if (local) return local
      const r = await this.cachedDownload(`${gameId}|${kind}|steamcdn-${n}`, `${STEAM_CDN}/${appId}/${n}`, gameId, kind)
      if (r) return r
    }
    return null
  }

  /** Steam keeps library artwork in appcache/librarycache/<appid>/ (sometimes in a hashed sub-folder). Read-only. */
  private async findLocalSteamFile(appId: number, names: string[]): Promise<string | null> {
    const steamPath = this.deps.steamPath()
    if (!steamPath) return null
    let files = this.localDirCache.get(appId)
    if (files === undefined) {
      files = await listFilesShallow(path.join(steamPath, 'appcache', 'librarycache', String(appId)))
      this.localDirCache.set(appId, files)
    }
    if (!files) return null
    for (const n of names) {
      const hit = files.find((f) => path.basename(f).toLowerCase() === n)
      if (hit) return hit
    }
    return null
  }

  // ---------- SteamGridDB ----------

  private async fromSgdbAuto(
    gameId: string,
    appId: number | undefined,
    kind: ArtKind,
    names: string[],
    manualGameId: number | undefined,
    strict: boolean
  ): Promise<string | null> {
    if (!this.deps.sgdb.enabled) return null
    if (!appId && !manualGameId && !names.length) return null
    const key = `${gameId}|${kind}|sgdb-auto${manualGameId ? `-${manualGameId}` : ''}`
    const entry = this.index.entries[key]
    if (entry?.file && (await exists(entry.file))) return entry.file
    if (entry?.missUntil && entry.missUntil > Date.now()) return null

    try {
      // non-Steam shortcuts (no app id) go straight to the title search below
      let options = manualGameId
        ? await this.deps.sgdb.images(kind, { gameId: manualGameId })
        : appId
          ? await this.deps.sgdb.images(kind, { steamAppId: appId })
          : []
      if (!options.length && !manualGameId && names.length) {
        // fallback: match by title
        const matchId = await this.autoMatch(gameId, names, strict)
        if (matchId) options = await this.deps.sgdb.images(kind, { gameId: matchId })
      }
      const best = options[0]
      if (!best) {
        this.index.entries[key] = { missUntil: Date.now() + MISS_TTL_MS }
        this.scheduleSave()
        return null
      }
      const file = await this.download(best.url, gameId, kind, `sgdb-${best.id}`)
      this.index.entries[key] = file ? { file } : { missUntil: Date.now() + ERROR_RETRY_MS }
      this.scheduleSave()
      return file
    } catch (e) {
      if (e instanceof SgdbAuthError) {
        log.warn('art', e.message)
        return null
      }
      if (e instanceof NetworkError || e instanceof HttpError) {
        this.index.entries[key] = { missUntil: Date.now() + ERROR_RETRY_MS }
        return null
      }
      throw e
    }
  }

  /** strict: exact title match against any of `names` (games outside Steam), tried name by name */
  private async autoMatch(gameId: string, names: string[], strict: boolean): Promise<number | undefined> {
    const key = `${gameId}|match`
    const entry = this.index.entries[key]
    if (entry?.sgdbGameId) return entry.sgdbGameId
    if (entry?.missUntil && entry.missUntil > Date.now()) return undefined
    let match
    for (const name of strict ? names.slice(0, 3) : names.slice(0, 1)) {
      const results = await this.deps.sgdb.search(name)
      match = strict ? pickExactMatch(names, results) : pickBestMatch(name, results)
      if (match) break
    }
    this.index.entries[key] = match ? { sgdbGameId: match.id } : { missUntil: Date.now() + MISS_TTL_MS }
    this.scheduleSave()
    return match?.id
  }

  // ---------- download & cache ----------

  private async cachedDownload(key: string, url: string, gameId: string, kind: ArtKind): Promise<string | null> {
    const entry = this.index.entries[key]
    if (entry?.file && (await exists(entry.file))) return entry.file
    if (entry?.missUntil && entry.missUntil > Date.now()) return null
    try {
      const tag = createHash('sha1').update(url).digest('hex').slice(0, 12)
      const file = await this.download(url, gameId, kind, tag)
      this.index.entries[key] = file ? { file } : { missUntil: Date.now() + MISS_TTL_MS }
      this.scheduleSave()
      return file
    } catch (e) {
      log.warn('art', `download failed (${kind}): ${(e as Error).message}`)
      this.index.entries[key] = { missUntil: Date.now() + ERROR_RETRY_MS }
      return null
    }
  }

  private async download(url: string, gameId: string, kind: ArtKind, tag: string): Promise<string | null> {
    const res = await this.downloads.run(() => this.fetchBytes(url))
    if (!res || res.bytes.length < 64) return null
    const dir = path.join(this.deps.cacheDir, 'images', safeName(gameId))
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${kind}-${tag}${extFor(res.contentType, url)}`)
    const tmp = file + '.part'
    await fs.writeFile(tmp, res.bytes)
    await fs.rename(tmp, file)
    return file
  }

  /** Forget cached resolution so a new choice is applied immediately. */
  invalidate(gameId: string, kind?: ArtKind): void {
    const prefix = kind ? `${gameId}|${kind}|` : `${gameId}|`
    for (const k of Object.keys(this.index.entries)) if (k.startsWith(prefix)) delete this.index.entries[k]
    this.scheduleSave()
  }

  async clear(): Promise<void> {
    this.index = { version: 1, entries: {} }
    this.localDirCache.clear()
    clearTimeout(this.saveTimer)
    await fs.rm(this.deps.cacheDir, { recursive: true, force: true })
    log.info('art', 'Image cache cleared')
  }

  async stats(): Promise<CacheStats> {
    let files = 0
    let bytes = 0
    async function walk(dir: string): Promise<void> {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else {
          files++
          bytes += (await fs.stat(p)).size
        }
      }
    }
    await walk(this.deps.cacheDir)
    return { files, bytes }
  }
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function listFilesShallow(dir: string): Promise<string[] | null> {
  try {
    const out: string[] = []
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isFile()) out.push(p)
      else if (e.isDirectory()) {
        for (const f of await fs.readdir(p, { withFileTypes: true })) if (f.isFile()) out.push(path.join(p, f.name))
      }
    }
    return out
  } catch {
    return null
  }
}
