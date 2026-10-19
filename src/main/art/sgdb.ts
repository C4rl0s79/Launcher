import type { ArtKind, ArtOption, SgdbGame } from '@shared/types'
import { fetchWithTimeout, HttpError, Limiter } from '../net'

// SteamGridDB API v2 client.  Auth: "Authorization: Bearer <key>" (key from
// https://www.steamgriddb.com/profile/preferences/api). Paths mirror the official
// node client (github.com/SteamGridDB/node-steamgriddb):
//   /grids|heroes|logos|icons/steam/{appid}   /…/game/{sgdbId}
//   /search/autocomplete/{term}               /games/steam/{appid}

const BASE = 'https://www.steamgriddb.com/api/v2'

const ENDPOINT: Record<ArtKind, string> = { grid: 'grids', hero: 'heroes', logo: 'logos', icon: 'icons' }

/** Request only the sizes we actually display. */
export function queryFor(kind: ArtKind): Record<string, string> {
  const common = { nsfw: 'false', humor: 'false', epilepsy: 'false', types: 'static' }
  switch (kind) {
    case 'grid':
      return { ...common, dimensions: '600x900,660x930', mimes: 'image/png,image/jpeg,image/webp' }
    case 'hero':
      return { ...common, dimensions: '1920x620,3840x1240', mimes: 'image/png,image/jpeg,image/webp' }
    case 'logo':
      return { ...common, mimes: 'image/png,image/webp' }
    case 'icon':
      return { ...common, mimes: 'image/png' }
  }
}

export class SgdbAuthError extends Error {}
export class SgdbNotFound extends Error {}

interface RawImage {
  id: number
  url: string
  thumb: string
  width: number
  height: number
  style?: string
  score?: number
  author?: { name?: string }
  nsfw?: boolean
  humor?: boolean
  epilepsy?: boolean
}

export function toOptions(data: unknown): ArtOption[] {
  if (!Array.isArray(data)) return []
  return (data as RawImage[])
    .filter((x) => x && typeof x.id === 'number' && typeof x.url === 'string' && !x.nsfw && !x.epilepsy)
    .map((x) => ({
      id: x.id,
      url: x.url,
      thumb: x.thumb || x.url,
      width: x.width,
      height: x.height,
      style: x.style,
      score: x.score,
      author: x.author?.name
    }))
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Pick the most plausible SteamGridDB game for a title. Exact normalised match wins;
 * otherwise the first result is accepted only if one name contains the other.
 */
export function pickBestMatch(name: string, results: SgdbGame[]): SgdbGame | undefined {
  const target = norm(name)
  if (!target) return undefined
  const exact = results.find((r) => norm(r.name) === target)
  if (exact) return exact
  const first = results[0]
  if (!first) return undefined
  const n = norm(first.name)
  return n && (n.includes(target) || target.includes(n)) ? first : undefined
}

export class SgdbClient {
  readonly limiter = new Limiter(3, 'steamgriddb')

  constructor(private readonly getKey: () => string | undefined) {}

  get enabled(): boolean {
    return !!this.getKey()
  }

  private async call(pathAndQuery: string): Promise<unknown> {
    const key = this.getKey()
    if (!key) throw new SgdbAuthError('Brak klucza SteamGridDB.')
    return this.limiter.run(async () => {
      try {
        const res = await fetchWithTimeout(`${BASE}${pathAndQuery}`, { headers: { Authorization: `Bearer ${key}` } }, 15000)
        const body = (await res.json()) as { success?: boolean; data?: unknown; errors?: string[] }
        if (body.success === false) throw new SgdbNotFound(body.errors?.join(', ') || 'not found')
        return body.data
      } catch (e) {
        if (e instanceof HttpError) {
          if (e.status === 401 || e.status === 403) throw new SgdbAuthError('SteamGridDB odrzucił klucz API (401/403).')
          if (e.status === 404) throw new SgdbNotFound('not found')
          if (e.status === 429) this.limiter.pause(e.retryAfterMs ?? 30000)
        }
        throw e
      }
    })
  }

  async images(kind: ArtKind, by: { steamAppId: number } | { gameId: number }): Promise<ArtOption[]> {
    const target = 'steamAppId' in by ? `steam/${by.steamAppId}` : `game/${by.gameId}`
    const q = new URLSearchParams(queryFor(kind)).toString()
    try {
      return toOptions(await this.call(`/${ENDPOINT[kind]}/${target}?${q}`))
    } catch (e) {
      if (e instanceof SgdbNotFound) return []
      throw e
    }
  }

  async gameBySteamId(appId: number): Promise<SgdbGame | undefined> {
    try {
      const d = (await this.call(`/games/steam/${appId}`)) as { id: number; name: string; release_date?: number; verified?: boolean }
      return d?.id ? { id: d.id, name: d.name, releaseDate: d.release_date, verified: d.verified } : undefined
    } catch (e) {
      if (e instanceof SgdbNotFound) return undefined
      throw e
    }
  }

  async search(term: string): Promise<SgdbGame[]> {
    const t = term.trim()
    if (!t) return []
    try {
      const d = await this.call(`/search/autocomplete/${encodeURIComponent(t)}`)
      if (!Array.isArray(d)) return []
      return (d as { id: number; name: string; release_date?: number; verified?: boolean }[]).map((g) => ({
        id: g.id,
        name: g.name,
        releaseDate: g.release_date,
        verified: g.verified
      }))
    } catch (e) {
      if (e instanceof SgdbNotFound) return []
      throw e
    }
  }
}
