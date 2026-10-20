import { describe, expect, it } from 'vitest'
import type { Game } from '../src/shared/types'
import { GROUP_PREFIX, groupVersions, pickVersion, regionRank } from '../src/main/emustart/versions'
import { defaultPrefs, migratePrefs, ops } from '../src/main/store/prefs'

// Synthetic library entries (titles as EmuStart lists them, tags = the region part of the name).
const emu = (sid: string, title: string, tags: string, o: Partial<Game> = {}, es = '3do', e: Partial<NonNullable<Game['emu']>> = {}): Game => ({
  id: `emu:${sid}`,
  source: 'emustart',
  appId: 0,
  name: title,
  sortName: title.toLowerCase(),
  provenance: ['emustartServer'],
  installState: e.cached ? 'installed' : 'notInstalled',
  installed: !!e.cached,
  ...o,
  emu: { id: 1, sid, es, system: es.toUpperCase(), tags, size: 100, cached: false, pinned: false, copying: false, discs: 1, hasBox: true, hasSnap: false, hasLogo: false, ...e }
})

const defcon = (): Game[] => [
  emu('g1', 'Defcon 5', '(Europe)'),
  emu('g2', 'Defcon 5', '(Germany)'),
  emu('g3', 'Defcon 5', '(Japan)'),
  emu('g4', 'Defcon 5', '(Korea)')
]

describe('regional versions as one entry', () => {
  it('groups versions of one title on one platform; single games keep their ids', () => {
    const g = groupVersions([...defcon(), emu('g9', 'D’s Diner', '(Japan)')], 'europe', {})
    expect(g.games).toHaveLength(2)
    const entry = g.games.find((x) => x.id.startsWith(GROUP_PREFIX))!
    expect(entry.emu?.versions?.map((v) => v.tags)).toEqual(['(Europe)', '(Germany)', '(Japan)', '(Korea)'])
    expect(entry.emu?.shownVersion).toBe('emu:g1')
    expect(g.games.find((x) => x.id === 'emu:g9')).toBeTruthy()
    expect(g.displayOf.get('emu:g3')).toBe(entry.id)
  })

  it('the same title on another platform is another game; Steam games are untouched', () => {
    const steam: Game = { ...emu('x', 'Doom', ''), id: 'steam:2280', source: 'steam', emu: undefined }
    const g = groupVersions([emu('a', 'Doom', '(USA)', {}, 'psx'), emu('b', 'Doom', '(USA)', {}, 'saturn'), steam], 'europe', {})
    expect(g.games.map((x) => x.id)).toEqual(['steam:2280', 'emu:a', 'emu:b'])
  })

  it('Amiga demos with the same title are different productions — not grouped', () => {
    const g = groupVersions([emu('d1', 'Megademo', '(v1.0) (Acme)', {}, 'amigawhddemos'), emu('d2', 'Megademo', '(v1.0) (Cult)', {}, 'amigawhddemos')], 'europe', {})
    expect(g.games.map((x) => x.id)).toEqual(['emu:d1', 'emu:d2'])
  })

  it('the id of a group is stable (favourites and choices survive a library refresh)', () => {
    const a = groupVersions(defcon(), 'europe', {}).games[0].id
    const b = groupVersions(defcon().reverse(), 'usa', {}).games[0].id
    expect(a).toBe(b)
  })

  it('shown version: choice → last played → downloaded → region preference', () => {
    const list = defcon()
    expect(pickVersion(list, 'europe').id).toBe('emu:g1')
    expect(pickVersion(list, 'japan').id).toBe('emu:g3')
    const withCached = list.map((m) => (m.id === 'emu:g2' ? { ...m, emu: { ...m.emu!, cached: true } } : m))
    expect(pickVersion(withCached, 'japan').id).toBe('emu:g2')
    const withPlayed = withCached.map((m) => (m.id === 'emu:g4' ? { ...m, lastPlayed: 100 } : m))
    expect(pickVersion(withPlayed, 'europe').id).toBe('emu:g4')
    expect(pickVersion(withPlayed, 'europe', 'emu:g3').id).toBe('emu:g3')
  })

  it('a group plays and shows the chosen version; playtime adds up', () => {
    const list = defcon().map((m, i) => ({ ...m, playtimeMinutes: 10 * (i + 1), lastPlayed: i ? 50 + i : undefined }))
    const g = groupVersions(list, 'europe', {})
    const entry = g.games[0]
    expect(entry.playtimeMinutes).toBe(100)
    expect(entry.lastPlayed).toBe(53)
    const chosen = groupVersions(list, 'europe', { [entry.id]: 'emu:g2' }).games[0]
    expect(chosen.emu?.shownVersion).toBe('emu:g2')
    expect(chosen.emu?.tags).toBe('(Germany)')
  })

  it('pre-release and unofficial versions are never the default', () => {
    expect(regionRank('(Europe) (Beta)', 'europe')).toBeGreaterThan(regionRank('(Japan)', 'europe'))
    expect(regionRank('(USA, Europe)', 'europe')).toBe(regionRank('(Europe)', 'europe'))
    expect(regionRank('(Poland)', 'europe')).toBeLessThan(regionRank('(Europe)', 'europe'))
  })

  it('the version choice is kept in prefs (and survives migration)', () => {
    let p = ops.chooseVersion(defaultPrefs(), 'emugrp:abc', 'emu:g2')
    expect(migratePrefs(JSON.parse(JSON.stringify(p))).versions).toEqual({ 'emugrp:abc': 'emu:g2' })
    p = ops.chooseVersion(p, 'emugrp:abc', undefined)
    expect(p.versions).toEqual({})
    expect(migratePrefs({ categories: [] }).versions).toEqual({})
  })
})
