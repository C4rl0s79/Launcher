import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DetailsResult, GameDetails } from '@shared/types'
import { fetchWithTimeout, HttpError, Limiter } from '../net'
import { log } from '../logger'

// Metadata provider backed by the Steam Store "appdetails" endpoint.
// NOTE: store.steampowered.com/api/appdetails is publicly reachable but NOT part of the
// documented Steamworks Web API; it is rate-limited (roughly 200 requests / 5 min per IP)
// and may change. We fetch lazily (only when a details screen opens), cache on disk
// for 14 days and serve stale data when offline.

const TTL_MS = 14 * 24 * 3600 * 1000

export function parseAppDetails(appId: number, json: unknown): GameDetails | null {
  const entry = (json as Record<string, { success?: boolean; data?: Record<string, unknown> }>)?.[String(appId)]
  if (!entry?.success || !entry.data) return null
  const d = entry.data as {
    name?: string
    short_description?: string
    about_the_game?: string
    genres?: { description?: string }[]
    release_date?: { coming_soon?: boolean; date?: string }
    developers?: string[]
    publishers?: string[]
    website?: string | null
  }
  const nonEmpty = (a?: string[]): string[] | undefined => {
    const v = (a ?? []).map((x) => x?.trim()).filter(Boolean)
    return v.length ? v : undefined
  }
  return {
    appId,
    fetchedAt: Date.now(),
    source: 'steamStore',
    name: d.name || undefined,
    shortDescription: decodeEntities(d.short_description?.trim() || '') || undefined,
    descriptionHtml: d.about_the_game?.trim() || undefined,
    genres: nonEmpty(d.genres?.map((g) => g.description ?? '')),
    releaseDate: d.release_date?.date?.trim() || undefined,
    comingSoon: d.release_date?.coming_soon,
    developers: nonEmpty(d.developers),
    publishers: nonEmpty(d.publishers),
    website: d.website || undefined
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export class StoreMetadataProvider {
  private limiter = new Limiter(2, 'steam-store')
  private inflight = new Map<number, Promise<DetailsResult>>()

  constructor(
    private readonly dir: string,
    private readonly language: () => string
  ) {}

  private file(appId: number): string {
    return path.join(this.dir, `${appId}.json`)
  }

  async get(appId: number, force = false): Promise<DetailsResult> {
    const existing = this.inflight.get(appId)
    if (existing) return existing
    const p = this.load(appId, force).finally(() => this.inflight.delete(appId))
    this.inflight.set(appId, p)
    return p
  }

  private async load(appId: number, force: boolean): Promise<DetailsResult> {
    let cached: GameDetails | null = null
    try {
      cached = JSON.parse(await fs.readFile(this.file(appId), 'utf8')) as GameDetails
    } catch {
      /* not cached */
    }
    if (cached && !force && Date.now() - cached.fetchedAt < TTL_MS) return { ok: true, details: cached, stale: false }

    try {
      const details = await this.limiter.run(async () => {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&l=${encodeURIComponent(this.language())}`
        const res = await fetchWithTimeout(url, { headers: { 'Accept-Language': 'pl,en;q=0.8' } }, 12000)
        return parseAppDetails(appId, await res.json())
      })
      if (!details) {
        return cached
          ? { ok: true, details: cached, stale: true }
          : { ok: false, error: 'Sklep Steam nie udostępnia informacji o tym tytule (może być usunięty ze sklepu).' }
      }
      await fs.mkdir(this.dir, { recursive: true })
      await fs.writeFile(this.file(appId), JSON.stringify(details))
      return { ok: true, details, stale: false }
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) this.limiter.pause(e.retryAfterMs ?? 60000)
      log.warn('meta', `appdetails ${appId} failed: ${(e as Error).message}`)
      if (cached) return { ok: true, details: cached, stale: true }
      return { ok: false, error: 'Nie udało się pobrać informacji ze sklepu Steam (brak sieci lub limit zapytań).' }
    }
  }
}
