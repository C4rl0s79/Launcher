import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SteamUser } from '@shared/types'
import { parseVdf, vobj, vnum, vstr, type VdfObject } from './vdf'
import { parseManifest, type ManifestInfo } from './manifests'
import { log } from '../logger'

// Everything in this file only READS Steam's files. We never write into the Steam directory.

export const STEAM_ID64_BASE = 76561197960265728n

export function accountIdToSteamId64(accountId: number): string {
  return (STEAM_ID64_BASE + BigInt(accountId)).toString()
}

export function steamId64ToAccountId(steamId64: string): number | undefined {
  if (!/^\d{17}$/.test(steamId64)) return undefined
  const v = BigInt(steamId64) - STEAM_ID64_BASE
  return v > 0n && v < 2n ** 32n ? Number(v) : undefined
}

export function isValidSteamId64(id: string): boolean {
  return steamId64ToAccountId(id) !== undefined
}

const normalize = (p: string): string => path.normalize(p.replace(/\\\\/g, '\\'))

/** Parse steamapps/libraryfolders.vdf (both the modern and the legacy flat format). */
export function parseLibraryFolders(text: string, steamPath?: string): string[] {
  const root = vobj(parseVdf(text), 'libraryfolders') ?? vobj(parseVdf(text), 'LibraryFolders') ?? {}
  const out: string[] = []
  for (const [key, value] of Object.entries(root)) {
    if (!/^\d+$/.test(key)) continue
    const p = typeof value === 'string' ? value : vstr(value, 'path')
    if (p) out.push(normalize(p))
  }
  if (steamPath) out.unshift(normalize(steamPath))
  // de-duplicate case-insensitively (Windows paths)
  const seen = new Set<string>()
  return out.filter((p) => {
    const k = p.toLowerCase().replace(/[\\/]+$/, '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export async function readLibraryFolders(steamPath: string): Promise<string[]> {
  const file = path.join(steamPath, 'steamapps', 'libraryfolders.vdf')
  try {
    return parseLibraryFolders(await fs.readFile(file, 'utf8'), steamPath)
  } catch (e) {
    log.warn('steam', `Cannot read libraryfolders.vdf: ${(e as Error).message}`)
    return [normalize(steamPath)]
  }
}

export interface ScannedManifest extends ManifestInfo {
  libraryPath: string
  /** unix seconds; creation time of the manifest file */
  addedAt?: number
}

export async function scanLibrary(libraryPath: string): Promise<ScannedManifest[]> {
  const dir = path.join(libraryPath, 'steamapps')
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    log.warn('steam', `Library folder not accessible: ${libraryPath}`)
    return []
  }
  const files = entries.filter((f) => /^appmanifest_\d+\.acf$/i.test(f))
  const results = await Promise.all(
    files.map(async (f): Promise<ScannedManifest | null> => {
      try {
        const file = path.join(dir, f)
        const [text, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
        const m = parseManifest(text)
        // the manifest is created when the install starts → good proxy for "added to this PC"
        return m ? { ...m, libraryPath, addedAt: Math.floor((st.birthtimeMs || st.mtimeMs) / 1000) } : null
      } catch (e) {
        log.warn('steam', `Bad manifest ${f}: ${(e as Error).message}`)
        return null
      }
    })
  )
  return results.filter((x): x is ScannedManifest => x !== null)
}

export async function scanAllLibraries(folders: string[]): Promise<ScannedManifest[]> {
  const all = (await Promise.all(folders.map(scanLibrary))).flat()
  // the same appid can appear twice if a library was moved; prefer the fully installed / newest
  const byId = new Map<number, ScannedManifest>()
  for (const m of all) {
    const prev = byId.get(m.appId)
    if (!prev || (m.lastUpdated ?? 0) > (prev.lastUpdated ?? 0)) byId.set(m.appId, m)
  }
  return [...byId.values()]
}

export function parseLoginUsers(text: string): SteamUser[] {
  const users = vobj(parseVdf(text), 'users') ?? {}
  return Object.entries(users)
    .filter(([id]) => isValidSteamId64(id))
    .map(([id, v]) => ({
      steamId64: id,
      accountName: vstr(v, 'AccountName'),
      mostRecent: vstr(v, 'MostRecent') === '1',
      ts: vnum(v, 'Timestamp') ?? 0
    }))
    .sort((a, b) => Number(b.mostRecent) - Number(a.mostRecent) || b.ts - a.ts)
    .map(({ ts: _ts, ...u }) => u)
}

export async function readLoginUsers(steamPath: string): Promise<SteamUser[]> {
  try {
    return parseLoginUsers(await fs.readFile(path.join(steamPath, 'config', 'loginusers.vdf'), 'utf8'))
  } catch {
    return []
  }
}

export interface LocalPlayStats {
  lastPlayed?: number
  playtimeMinutes?: number
}

/**
 * userdata/<accountId>/config/localconfig.vdf → Software/Valve/Steam/apps/<appid>
 * contains LastPlayed (unix seconds) and Playtime (minutes) for apps run on this PC.
 */
export function parseLocalConfigPlayStats(text: string): Map<number, LocalPlayStats> {
  const root = parseVdf(text)
  const apps =
    vobj(root, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps') ??
    vobj(root, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'Apps') ??
    ({} as VdfObject)
  const out = new Map<number, LocalPlayStats>()
  for (const [id, v] of Object.entries(apps)) {
    const appId = Number(id)
    if (!Number.isInteger(appId) || typeof v !== 'object') continue
    const lastPlayed = vnum(v, 'LastPlayed')
    const playtime = vnum(v, 'Playtime')
    if (lastPlayed === undefined && playtime === undefined) continue
    out.set(appId, {
      lastPlayed: lastPlayed && lastPlayed > 0 ? lastPlayed : undefined,
      playtimeMinutes: playtime !== undefined && playtime >= 0 ? playtime : undefined
    })
  }
  return out
}

export async function readLocalPlayStats(steamPath: string, accountId: number): Promise<Map<number, LocalPlayStats>> {
  const file = path.join(steamPath, 'userdata', String(accountId), 'config', 'localconfig.vdf')
  try {
    return parseLocalConfigPlayStats(await fs.readFile(file, 'utf8'))
  } catch (e) {
    log.info('steam', `localconfig.vdf not readable for account ${accountId}: ${(e as Error).message}`)
    return new Map()
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
