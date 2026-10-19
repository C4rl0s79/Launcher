import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseBinaryVdf, bget, type BinVdfObject } from './binaryVdf'
import { log } from '../logger'

// Non-Steam shortcuts that the user (or a tool such as Steam ROM Manager) added to Steam.
// Source: userdata/<accountId>/config/shortcuts.vdf (binary KeyValues). READ-ONLY.
// They are launched through Steam with the 64-bit game id (appid << 32 | 0x02000000),
// so Steam Input profiles, overlay and playtime tracking keep working.

export interface SteamShortcut {
  appId: number // unsigned 32-bit id, also used by Steam collections and the grid folder
  name: string
  exe: string
  startDir?: string
  launchOptions?: string
  tags: string[]
  lastPlayed?: number
  hidden: boolean
}

/** 64-bit game id understood by steam://rungameid for non-Steam shortcuts. */
export function shortcutGameId64(appId: number): string {
  return ((BigInt(appId >>> 0) << 32n) | 0x02000000n).toString()
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export function parseShortcuts(buf: Buffer): SteamShortcut[] {
  const root = parseBinaryVdf(buf)
  const list = bget(root, 'shortcuts')
  if (!list || typeof list !== 'object') return []
  const out: SteamShortcut[] = []
  for (const raw of Object.values(list)) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as BinVdfObject
    const appId = bget(s, 'appid')
    const name = str(bget(s, 'AppName'))
    if (typeof appId !== 'number' || !appId || !name) continue
    const tags = bget(s, 'tags')
    const last = bget(s, 'LastPlayTime')
    out.push({
      appId: appId >>> 0,
      name,
      exe: (str(bget(s, 'Exe')) ?? '').replace(/^"(.*)"$/, '$1'),
      startDir: str(bget(s, 'StartDir'))?.replace(/^"(.*)"$/, '$1'),
      launchOptions: str(bget(s, 'LaunchOptions')),
      tags: tags && typeof tags === 'object' ? Object.values(tags).filter((t): t is string => typeof t === 'string') : [],
      lastPlayed: typeof last === 'number' && last > 0 ? last : undefined,
      hidden: bget(s, 'IsHidden') === 1
    })
  }
  return out
}

export function shortcutsFile(steamPath: string, accountId: number): string {
  return path.join(steamPath, 'userdata', String(accountId), 'config', 'shortcuts.vdf')
}

/** null = file missing/unreadable (no shortcuts, not an error). */
export async function readShortcuts(steamPath: string, accountId: number): Promise<SteamShortcut[] | null> {
  try {
    return parseShortcuts(await fs.readFile(shortcutsFile(steamPath, accountId)))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('steam', `shortcuts.vdf not readable: ${(e as Error).message}`)
    return null
  }
}
