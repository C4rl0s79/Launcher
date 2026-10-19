import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SteamCollection } from '@shared/types'
import { log } from '../logger'

// Steam library collections, READ-ONLY.
// The Steam client keeps them in userdata/<accountId>/config/cloudstorage/
// cloud-storage-namespace-1.json as [key, entry] pairs where key = "user-collections.<id>"
// and entry.value is a JSON string {id, name, added[], removed[], filterSpec?}.
// Not documented by Valve; parsing is defensive and we never write these files.
// Pending local edits not yet synced live in the matching ".modified.json" (same shape).
//
// Static collections are an explicit list of app ids. Dynamic ones ("filterSpec") are rules
// evaluated by Steam against its own per-app metadata (tags, features, controller support…),
// which Lumen does not have — they are reported but not turned into categories.

interface Entry {
  key?: string
  value?: string
  is_deleted?: boolean
}

function entries(raw: unknown): Map<string, Entry> {
  const map = new Map<string, Entry>()
  if (!Array.isArray(raw)) return map
  for (const item of raw) {
    if (Array.isArray(item) && typeof item[0] === 'string' && item[1] && typeof item[1] === 'object') map.set(item[0], item[1] as Entry)
  }
  return map
}

export function parseCollections(base: unknown, modified?: unknown): SteamCollection[] {
  const all = entries(base)
  for (const [k, v] of entries(modified)) all.set(k, v)
  const out: SteamCollection[] = []
  for (const [key, entry] of all) {
    if (!key.startsWith('user-collections.') || entry.is_deleted || typeof entry.value !== 'string') continue
    let v: { id?: unknown; name?: unknown; added?: unknown; removed?: unknown; filterSpec?: unknown }
    try {
      v = JSON.parse(entry.value)
    } catch {
      continue
    }
    const id = typeof v.id === 'string' ? v.id : key.slice('user-collections.'.length)
    const ids = (x: unknown): number[] => (Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n) && n > 0) : [])
    const removed = new Set(ids(v.removed))
    const appIds = [...new Set(ids(v.added))].filter((n) => !removed.has(n))
    out.push({
      id,
      name: (typeof v.name === 'string' && v.name.trim()) || id,
      appIds,
      dynamic: !!v.filterSpec,
      kind: id === 'favorite' ? 'favorite' : id === 'hidden' ? 'hidden' : 'user'
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'pl'))
}

/** Returns null when the file cannot be read (so callers can keep previous data). */
export async function readCollections(steamPath: string, accountId: number): Promise<SteamCollection[] | null> {
  const dir = path.join(steamPath, 'userdata', String(accountId), 'config', 'cloudstorage')
  try {
    const base = JSON.parse(await fs.readFile(path.join(dir, 'cloud-storage-namespace-1.json'), 'utf8'))
    let modified: unknown
    try {
      modified = JSON.parse(await fs.readFile(path.join(dir, 'cloud-storage-namespace-1.modified.json'), 'utf8'))
    } catch {
      /* optional */
    }
    return parseCollections(base, modified)
  } catch (e) {
    log.info('steam', `collections not readable: ${(e as Error).message}`)
    return null
  }
}

export function collectionsDir(steamPath: string, accountId: number): string {
  return path.join(steamPath, 'userdata', String(accountId), 'config', 'cloudstorage')
}
