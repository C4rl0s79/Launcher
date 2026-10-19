import { fetchWithTimeout, HttpError } from '../net'

// Official Steam Web API: IPlayerService/GetOwnedGames.
// https://partner.steamgames.com/doc/webapi/IPlayerService#GetOwnedGames
// Works with a personal Web API key (https://steamcommunity.com/dev/apikey). Returns data
// only when the profile's game details are visible to the key's owner; for a private
// profile the response is an empty object.

export interface OwnedGame {
  appId: number
  name?: string
  playtimeMinutes: number
  lastPlayed?: number
}

export type OwnedGamesResult = { kind: 'ok'; games: OwnedGame[] } | { kind: 'private' }

export function parseOwnedGames(json: unknown): OwnedGamesResult {
  const resp = (json as { response?: { game_count?: number; games?: unknown[] } })?.response
  if (!resp || (resp.game_count === undefined && !resp.games)) return { kind: 'private' }
  const games: OwnedGame[] = []
  for (const g of resp.games ?? []) {
    const r = g as { appid?: number; name?: string; playtime_forever?: number; rtime_last_played?: number }
    if (typeof r.appid !== 'number') continue
    games.push({
      appId: r.appid,
      name: typeof r.name === 'string' ? r.name : undefined,
      playtimeMinutes: typeof r.playtime_forever === 'number' ? r.playtime_forever : 0,
      lastPlayed: r.rtime_last_played && r.rtime_last_played > 0 ? r.rtime_last_played : undefined
    })
  }
  return { kind: 'ok', games }
}

export async function getOwnedGames(key: string, steamId64: string): Promise<OwnedGamesResult> {
  const url =
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?' +
    new URLSearchParams({
      key,
      steamid: steamId64,
      include_appinfo: '1',
      include_played_free_games: '1',
      format: 'json'
    }).toString()
  try {
    const res = await fetchWithTimeout(url, {}, 20000)
    return parseOwnedGames(await res.json())
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403))
      throw new Error('Steam odrzucił klucz Web API (401/403). Sprawdź klucz w ustawieniach.')
    throw e
  }
}
