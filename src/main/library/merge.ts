import type { Game } from '@shared/types'
import { isToolApp, manifestProgress, mapInstallState } from '../steam/manifests'
import type { ScannedManifest, LocalPlayStats } from '../steam/local'
import type { OwnedGame } from '../steam/webApi'
import { shortcutGameId64, type SteamShortcut } from '../steam/shortcuts'

export function sortKey(name: string): string {
  return name
    .replace(/^(the|a|an)\s+/i, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export interface MergeInput {
  manifests: ScannedManifest[]
  owned?: OwnedGame[]
  localStats: Map<number, LocalPlayStats>
  runningAppId?: number
  showTools: boolean
}

/**
 * Combine local install data with the (optional) owned-games list from the Web API.
 * - Local manifests decide install state.
 * - Account data adds not-installed games and server-side playtime.
 * - Local play stats (this PC) fill gaps; for last-played we take the newest of both.
 */
export function mergeLibrary(input: MergeInput): Game[] {
  const games = new Map<number, Game>()

  for (const m of input.manifests) {
    if (!input.showTools && isToolApp(m.appId, m.name)) continue
    const state = mapInstallState(m.stateFlags)
    games.set(m.appId, {
      id: `steam:${m.appId}`,
      source: 'steam',
      appId: m.appId,
      name: m.name,
      sortName: sortKey(m.name),
      provenance: ['localManifest'],
      installState: state,
      installed: state !== 'notInstalled' && state !== 'installing',
      installDir: m.installDir,
      libraryPath: m.libraryPath,
      sizeOnDisk: m.sizeOnDisk,
      buildId: m.buildId,
      progress: state === 'installing' || state === 'updating' || state === 'updatePaused' ? manifestProgress(m) : undefined
    })
  }

  for (const o of input.owned ?? []) {
    const existing = games.get(o.appId)
    if (existing) {
      existing.provenance.push('accountApi')
      if (o.playtimeMinutes) existing.playtimeMinutes = o.playtimeMinutes
      if (o.lastPlayed) existing.lastPlayed = o.lastPlayed
      if (o.name && /^App \d+$/.test(existing.name)) {
        existing.name = o.name
        existing.sortName = sortKey(o.name)
      }
      continue
    }
    const name = o.name || `App ${o.appId}`
    if (!input.showTools && isToolApp(o.appId, name)) continue
    games.set(o.appId, {
      id: `steam:${o.appId}`,
      source: 'steam',
      appId: o.appId,
      name,
      sortName: sortKey(name),
      provenance: ['accountApi'],
      installState: 'notInstalled',
      installed: false,
      playtimeMinutes: o.playtimeMinutes || undefined,
      lastPlayed: o.lastPlayed
    })
  }

  for (const g of games.values()) {
    const s = input.localStats.get(g.appId)
    if (s) {
      if (s.lastPlayed && (!g.lastPlayed || s.lastPlayed > g.lastPlayed)) g.lastPlayed = s.lastPlayed
      if (g.playtimeMinutes === undefined && s.playtimeMinutes !== undefined) g.playtimeMinutes = s.playtimeMinutes
    }
    if (input.runningAppId && g.appId === input.runningAppId) g.running = true
  }

  return [...games.values()].sort((a, b) => a.sortName.localeCompare(b.sortName, 'pl'))
}

/**
 * Non-Steam shortcuts as library entries. `exeExists` decides whether the target program is
 * present; a missing one is shown as "broken" instead of pretending it can start.
 */
export function shortcutGames(shortcuts: SteamShortcut[], exeExists: (exe: string) => boolean, runningAppId?: number): Game[] {
  return shortcuts
    .filter((s) => !s.hidden)
    .map((s) => {
      const ok = !s.exe || exeExists(s.exe)
      return {
        id: `shortcut:${s.appId}`,
        source: 'shortcut' as const,
        appId: s.appId,
        name: s.name,
        sortName: sortKey(s.name),
        provenance: ['steamShortcut' as const],
        installState: ok ? ('installed' as const) : ('broken' as const),
        installed: ok,
        lastPlayed: s.lastPlayed,
        running: runningAppId !== undefined && runningAppId === s.appId ? true : undefined,
        shortcut: {
          exe: s.exe,
          launchOptions: s.launchOptions,
          tags: s.tags.filter((t) => t.toLowerCase() !== 'non-steam'),
          gameId64: shortcutGameId64(s.appId)
        }
      }
    })
}
