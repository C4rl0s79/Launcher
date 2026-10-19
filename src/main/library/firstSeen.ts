import type { Game } from '@shared/types'
import { JsonFile } from '../store/jsonFile'

// "When did this game appear in my library?" — Steam exposes no purchase date (not in the
// Web API's GetOwnedGames, and the client's license cache is encrypted), and install dates
// change on every reinstall. So Lumen records the first time it sees each game id and keeps
// that record forever (uninstall/reinstall does not change it).
//
// Games already present when tracking starts get 0 ("unknown"), otherwise the first run would
// make the whole library look new. Account (Web API) and local sources have separate baselines,
// so adding a Web API key later does not flood "recently added" with old purchases.

export interface FirstSeenData {
  version: 1
  baselineLocal: boolean
  baselineAccount: boolean
  seen: Record<string, number>
}

export const emptyFirstSeen = (): FirstSeenData => ({ version: 1, baselineLocal: false, baselineAccount: false, seen: {} })

/**
 * Pure update step. Returns the new data (or the same object if nothing changed) and the
 * known date for every game. Shortcut ROM dates are passed through unchanged.
 */
export function updateFirstSeen(
  data: FirstSeenData,
  games: Game[],
  accountAvailable: boolean,
  now: number = Math.floor(Date.now() / 1000)
): FirstSeenData {
  const steam = games.filter((g) => g.source === 'steam')
  let changed = false
  const seen = { ...data.seen }
  const local = steam.filter((g) => g.provenance.includes('localManifest'))
  const account = steam.filter((g) => g.provenance.includes('accountApi'))
  const mark = (list: Game[], baseline: boolean): void => {
    for (const g of list) {
      if (seen[g.id] !== undefined) continue
      seen[g.id] = baseline ? 0 : now
      changed = true
    }
  }
  const baselineLocal = !data.baselineLocal
  mark(local, baselineLocal)
  const baselineAccount = accountAvailable && !data.baselineAccount
  if (accountAvailable) mark(account, baselineAccount)
  if (baselineLocal || baselineAccount) changed = true
  if (!changed) return data
  return {
    version: 1,
    baselineLocal: true,
    baselineAccount: data.baselineAccount || accountAvailable,
    seen
  }
}

/** Apply recorded dates to Steam games (shortcuts keep their ROM date). */
export function applyFirstSeen(games: Game[], data: FirstSeenData): Game[] {
  return games.map((g) => {
    if (g.source !== 'steam') return g
    const t = data.seen[g.id]
    return t ? { ...g, addedAt: t } : g
  })
}

export class FirstSeenStore {
  private file: JsonFile<FirstSeenData>
  private data: FirstSeenData = emptyFirstSeen()
  private loaded = false

  constructor(path: string) {
    this.file = new JsonFile(path, emptyFirstSeen)
  }

  async process(games: Game[], accountAvailable: boolean): Promise<Game[]> {
    if (!this.loaded) {
      this.data = await this.file.load()
      this.loaded = true
    }
    const next = updateFirstSeen(this.data, games, accountAvailable)
    if (next !== this.data) {
      this.data = next
      await this.file.save(next)
    }
    return applyFirstSeen(games, this.data)
  }
}
