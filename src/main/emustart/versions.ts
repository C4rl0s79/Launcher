import { createHash } from 'node:crypto'
import type { EmuVersion, Game, RegionOrder } from '@shared/types'

// Regional versions (and revisions) of one game — "Defcon 5 (Europe)", "(Japan)", "(Korea)" — are
// one entry in the desktop library, with the versions to choose from in the game's details.
// Grouping is by platform + title (EmuStart's title without tags); multi-disc sets are already one
// game per version (scanner). Only the desktop view groups; the TV view keeps EmuStart's list.
// Pure functions — unit tested.

export const GROUP_PREFIX = 'emugrp:'

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Systems whose same-titled entries are different productions, not versions of one game
 * (Amiga demoscene: "Megademo" by Acme, by Arcadia Team…).
 */
const NOT_VERSIONS = new Set(['amigawhddemos'])

export function groupKey(g: Game): string | null {
  if (!g.emu || NOT_VERSIONS.has(g.emu.es)) return null
  return `${g.emu.es}\u0000${norm(g.name)}`
}

export function groupId(key: string): string {
  return GROUP_PREFIX + createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/** Regions in order of preference; the first match in a version's tags ranks it. */
export const REGION_ORDERS: Record<RegionOrder, string[][]> = {
  europe: [['poland', 'pl'], ['europe', 'world', 'uk', 'germany', 'france', 'spain', 'italy', 'netherlands', 'sweden', 'scandinavia'], ['usa', 'canada'], ['japan', 'asia', 'korea', 'china', 'taiwan']],
  usa: [['usa', 'canada'], ['world'], ['europe', 'uk', 'germany', 'france', 'spain', 'italy'], ['japan', 'asia', 'korea', 'china', 'taiwan']],
  japan: [['japan'], ['asia', 'korea', 'china', 'taiwan'], ['world', 'usa', 'canada'], ['europe', 'uk', 'germany', 'france', 'spain', 'italy']]
}

/** Pre-release / unofficial versions are never the default. */
const LESSER = /\b(beta|proto(type)?|demo|sample|kiosk|promo|trial|unl|unlicensed|pirate|hack|bootleg|debug)\b/i

export function regionRank(tags: string, order: RegionOrder): number {
  const t = tags.toLowerCase()
  const words = new Set(t.match(/[a-z]+/g) ?? [])
  const regions = REGION_ORDERS[order]
  let rank = regions.length
  regions.forEach((names, i) => {
    if (i < rank && names.some((n) => words.has(n))) rank = i
  })
  return rank + (LESSER.test(t) ? 100 : 0)
}

/**
 * Which version the entry shows and plays: the player's choice → the last played one →
 * a downloaded one → region preference → name.
 */
export function pickVersion(members: Game[], order: RegionOrder, chosen?: string): Game {
  const byChoice = chosen ? members.find((m) => m.id === chosen) : undefined
  if (byChoice) return byChoice
  const played = members.filter((m) => m.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
  if (played.length) return played[0]
  const score = (m: Game): number => (m.emu?.cached ? 0 : 1000) + regionRank(m.emu?.tags ?? '', order)
  return [...members].sort((a, b) => score(a) - score(b) || (a.emu?.tags ?? '').localeCompare(b.emu?.tags ?? ''))[0]
}

export interface Grouped {
  games: Game[]
  /** display id → member game ids (only grouped entries) */
  members: Map<string, Game[]>
  /** member id → display id (only grouped entries) */
  displayOf: Map<string, string>
}

/**
 * One entry per platform + title. Single versions keep their own id (`emu:<sid>`) and stay as
 * they are; groups get `emugrp:<hash>` and look like the shown version, with `emu.versions`.
 */
export function groupVersions(games: Game[], order: RegionOrder, choices: Record<string, string>): Grouped {
  // one game = same platform and (same title OR same LaunchBox id): releases with other titles
  // ("Daedalus Encounter" / "…Episode 1 - Nanpasen no Alien", "D" / "D no Shokutaku") join too
  const out: Game[] = []
  const emu: Game[] = []
  for (const g of games) (groupKey(g) ? emu : out).push(g)
  const parent = emu.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const firstBy = new Map<string, number>()
  emu.forEach((g, i) => {
    const keys = [groupKey(g)!]
    if (g.emu!.lb) keys.push(`${g.emu!.es}\u0000lb:${g.emu!.lb}`)
    for (const k of keys) {
      const j = firstBy.get(k)
      if (j === undefined) firstBy.set(k, i)
      else union(i, j)
    }
  })
  const buckets = new Map<number, Game[]>()
  emu.forEach((g, i) => {
    const r = find(i)
    const list = buckets.get(r)
    if (list) list.push(g)
    else buckets.set(r, [g])
  })
  const members = new Map<string, Game[]>()
  const displayOf = new Map<string, string>()
  for (const list of buckets.values()) {
    if (list.length === 1) {
      out.push(list[0])
      continue
    }
    // stable id: the LaunchBox id when the game has one, else platform + title
    const lbs = list.map((m) => m.emu!.lb).filter((x): x is number => !!x)
    const id = groupId(lbs.length ? `${list[0].emu!.es}\u0000lb:${Math.min(...lbs)}` : groupKey(list[0])!)
    const shown = pickVersion(list, order, choices[id])
    const versions: EmuVersion[] = [...list]
      .sort((a, b) => regionRank(a.emu!.tags, order) - regionRank(b.emu!.tags, order) || a.emu!.tags.localeCompare(b.emu!.tags))
      .map((m) => ({
        id: m.id,
        tags: m.emu!.tags,
        cached: m.emu!.cached,
        pinned: m.emu!.pinned,
        copying: m.emu!.copying,
        discs: m.emu!.discs,
        size: m.emu!.size,
        lastPlayed: m.lastPlayed
      }))
    const played = list.map((m) => m.lastPlayed ?? 0)
    const minutes = list.reduce((n, m) => n + (m.playtimeMinutes ?? 0), 0)
    out.push({
      ...shown,
      id,
      lastPlayed: Math.max(...played) || undefined,
      playtimeMinutes: minutes || undefined,
      emu: { ...shown.emu!, versions, shownVersion: shown.id }
    })
    members.set(id, list)
    for (const m of list) displayOf.set(m.id, id)
  }
  return { games: out, members, displayOf }
}
