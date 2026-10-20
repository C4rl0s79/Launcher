import type { DetailsResult, EmuSystem, Game, GameDetails } from '@shared/types'

// Pure conversions between EmuStart engine data (emustart/lumen.py, api.py) and Lumen's model.
// Kept free of Electron so they are unit-tested.

/** One game from `lumen_library` (engine). */
export interface EmuLibraryRow {
  id: number
  sid: string
  es: string
  system: string
  title: string
  name: string
  tags: string
  size: number
  cached: boolean
  pinned: boolean
  last: number
  seconds: number
  favorite?: boolean
  box?: string
  snap?: string
  logo?: string
  genre?: string
  year?: string
  developer?: string
  publisher?: string
  players?: string
}

export interface EmuLibrary {
  systems: (EmuSystem & { logo?: string; kind?: string })[]
  games: EmuLibraryRow[]
  lib_version: number
  profile?: { id: number; name: string }
  server: { ok: boolean; name?: string; checking?: boolean; key_rejected?: boolean; reason?: string } | null
  configured: boolean
}

export const EMU_PREFIX = 'emu:'

/** Stable Lumen id of an EmuStart game: the cross-device id from the server (system + game name). */
export const emuGameId = (sid: string): string => `${EMU_PREFIX}${sid}`
export const isEmuGameId = (id: string): boolean => id.startsWith(EMU_PREFIX)

/** Sort key like Lumen's Steam games: lower case, leading articles dropped. */
export function sortNameOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .trim()
}

export function emuGame(r: EmuLibraryRow, copying: ReadonlySet<number>): Game {
  const isCopying = copying.has(r.id)
  return {
    id: emuGameId(r.sid),
    source: 'emustart',
    appId: 0,
    name: r.title,
    sortName: sortNameOf(r.title),
    provenance: ['emustartServer'],
    installState: isCopying ? 'installing' : r.cached ? 'installed' : 'notInstalled',
    installed: !!r.cached,
    sizeOnDisk: r.cached ? r.size : undefined,
    lastPlayed: r.last || undefined,
    playtimeMinutes: r.seconds ? Math.round(r.seconds / 60) : undefined,
    emu: {
      id: r.id,
      sid: r.sid,
      es: r.es,
      system: r.system,
      tags: r.tags,
      size: r.size,
      cached: !!r.cached,
      pinned: !!r.pinned,
      copying: isCopying,
      genre: r.genre || undefined,
      year: r.year || undefined,
      players: r.players || undefined,
      developer: r.developer || undefined,
      publisher: r.publisher || undefined,
      hasBox: !!r.box,
      hasSnap: !!r.snap,
      hasLogo: !!r.logo
    }
  }
}

export function emuGames(lib: EmuLibrary, copying: ReadonlySet<number> = new Set()): Game[] {
  // the same server game may be listed once per system only; ids are unique by construction
  const seen = new Set<string>()
  const out: Game[] = []
  for (const r of lib.games) {
    if (!r.sid || seen.has(r.sid)) continue
    seen.add(r.sid)
    out.push(emuGame(r, copying))
  }
  return out
}

/** Art kind in Lumen → EmuStart media: poster = box art, hero = screenshot, logo = Clear Logo. */
export function emuArtField(kind: string): 'box' | 'snap' | 'logo' | null {
  return kind === 'grid' ? 'box' : kind === 'hero' ? 'snap' : kind === 'logo' ? 'logo' : null
}

/** game_detail (engine) → Lumen details. */
export function emuDetails(d: Record<string, unknown> | null | undefined): DetailsResult {
  if (!d || !d.id) return { ok: false, error: 'Nie ma tej gry w bibliotece EmuStart.' }
  const m = (d.meta ?? {}) as Record<string, string | undefined>
  const text = [m.description, m.wiki ? `Wikipedia (${m.wiki_lang ?? ''}): ${m.wiki}` : undefined].filter(Boolean).join('\n\n')
  const details: GameDetails = {
    appId: 0,
    fetchedAt: Date.now(),
    source: 'emustart',
    name: (d.title as string) || undefined,
    descriptionText: text || undefined,
    genres: m.genre ? m.genre.split(/\s*[,/;]\s*/).filter(Boolean) : undefined,
    releaseDate: m.year || undefined,
    developers: m.developer ? [m.developer] : undefined,
    publishers: m.publisher ? [m.publisher] : undefined,
    players: m.players || undefined,
    platform: (d.system as string) || undefined
  }
  return { ok: true, details, stale: !d.meta_online }
}
