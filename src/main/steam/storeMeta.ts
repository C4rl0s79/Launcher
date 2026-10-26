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
/** GameDetails.version of what parseAppDetails builds; older cached entries are fetched again */
const DATA_VERSION = 3
/** Steam store categories meaning co-op: Co-op, Online Co-op, Shared/Split Screen Co-op, LAN Co-op */
const COOP_CATEGORIES = new Set([9, 38, 39, 48])

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
    metacritic?: { score?: number }
    categories?: { id?: number }[]
    ratings?: Record<string, { rating?: string }>
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
    website: d.website || undefined,
    criticScore: d.metacritic?.score || undefined,
    coop: d.categories ? d.categories.some((c) => COOP_CATEGORIES.has(Number(c.id))) : undefined,
    esrb: ageRating(d.ratings),
    version: DATA_VERSION
  }
}

/** PEGI when the store lists it (Europe), else ESRB */
function ageRating(r?: Record<string, { rating?: string }>): string | undefined {
  const pegi = r?.pegi?.rating?.trim()
  if (pegi && /^\d+$/.test(pegi)) return `PEGI ${pegi}`
  const esrb = r?.esrb?.rating?.trim()
  return esrb ? `ESRB ${esrb.toUpperCase()}` : undefined
}

/** Steam user reviews counted by SteamSpy (positive / negative) */
export function parseSteamSpy(json: unknown): { playerScore?: number; playerReviews?: number } {
  const j = json as { positive?: number; negative?: number }
  const pos = Number(j?.positive) || 0
  const total = pos + (Number(j?.negative) || 0)
  return total ? { playerScore: Math.round((100 * pos) / total), playerReviews: total } : {}
}

/** Steam user reviews: share of positive (0–100) and how many — appreviews summary */
export function parseReviewSummary(json: unknown): { playerScore?: number; playerReviews?: number } {
  const q = (json as { success?: number; query_summary?: { total_positive?: number; total_reviews?: number } })?.query_summary
  const total = Number(q?.total_reviews) || 0
  if (!total) return {}
  return { playerScore: Math.round((100 * (Number(q?.total_positive) || 0)) / total), playerReviews: total }
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

  /** ratings from the cache only (no network): undefined = not fetched in the current format yet */
  async cachedRatings(appId: number): Promise<{ critic?: number; players?: number } | undefined> {
    try {
      const d = JSON.parse(await fs.readFile(this.file(appId), 'utf8')) as GameDetails
      if ((d.version ?? 1) < DATA_VERSION) return undefined
      return { critic: d.criticScore, players: d.playerScore }
    } catch {
      return undefined
    }
  }

  /** fetch these apps' store data one by one in the background (sorting by rating) */
  private queue: number[] = []
  private filling = false
  prefetch(appIds: number[]): void {
    const known = new Set(this.queue)
    for (const id of appIds) if (!known.has(id)) this.queue.push(id)
    if (this.filling) return
    this.filling = true
    void (async () => {
      while (this.queue.length) {
        const id = this.queue.shift()!
        await this.get(id).catch(() => undefined)
      }
      this.filling = false
    })()
  }

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
    if (cached && !force && (cached.version ?? 1) >= DATA_VERSION && Date.now() - cached.fetchedAt < TTL_MS) return { ok: true, details: cached, stale: false }

    try {
      const details = await this.limiter.run(async () => {
        const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&l=${encodeURIComponent(this.language())}`
        const res = await fetchWithTimeout(url, { headers: { 'Accept-Language': 'pl,en;q=0.8' } }, 12000)
        const parsed = parseAppDetails(appId, await res.json())
        if (!parsed) return null
        // player reviews: Steam's public summary, else SteamSpy's counts; the details stay useful without them
        try {
          const rv = await fetchWithTimeout(
            `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`,
            { redirect: 'error' },
            12000
          )
          Object.assign(parsed, parseReviewSummary(await rv.json()))
        } catch {
          /* the store sends some regions to its front page — SteamSpy below */
        }
        if (parsed.playerScore === undefined) {
          try {
            const sp = await fetchWithTimeout(`https://steamspy.com/api.php?request=appdetails&appid=${appId}`, {}, 12000)
            Object.assign(parsed, parseSteamSpy(await sp.json()))
          } catch {
            /* no player reviews */
          }
        }
        return parsed
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
