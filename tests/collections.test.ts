import { describe, expect, it } from 'vitest'
import { parseCollections } from '../src/main/steam/collections'
import { defaultPrefs, ops, PrefsError } from '../src/main/store/prefs'
import type { SteamCollection } from '@shared/types'

const entry = (id: string, value: object | null, deleted = false) => [
  `user-collections.${id}`,
  deleted ? { key: `user-collections.${id}`, is_deleted: true } : { key: `user-collections.${id}`, timestamp: 1, value: JSON.stringify(value) }
]

describe('Steam collections parser', () => {
  const base = [
    entry('favorite', { id: 'favorite', name: 'Favorites', added: [10], removed: [] }),
    entry('hidden', { id: 'hidden', name: 'Hidden', added: [99], removed: [] }),
    entry('uc-yakuza', { id: 'uc-yakuza', name: '  Yakuza ', added: [1, 2, 3, 2], removed: [3] }),
    entry('uc-jrpg', { id: 'uc-jrpg', name: 'JRPG', added: [], removed: [], filterSpec: { nFormatVersion: 2 } }),
    entry('uc-gone', null, true),
    ['showcases.x', { value: '{}' }],
    ['user-collections.broken', { value: '{not json' }]
  ]

  it('reads static, dynamic and special collections and skips deleted/broken ones', () => {
    const cols = parseCollections(base)
    expect(cols.map((c) => c.id).sort()).toEqual(['favorite', 'hidden', 'uc-jrpg', 'uc-yakuza'])
    expect(cols.find((c) => c.id === 'uc-yakuza')).toEqual({ id: 'uc-yakuza', name: 'Yakuza', appIds: [1, 2], dynamic: false, kind: 'user' })
    expect(cols.find((c) => c.id === 'uc-jrpg')?.dynamic).toBe(true)
    expect(cols.find((c) => c.id === 'favorite')?.kind).toBe('favorite')
    expect(cols.find((c) => c.id === 'hidden')?.kind).toBe('hidden')
  })

  it('applies pending local edits from the .modified file', () => {
    const modified = [entry('uc-yakuza', { id: 'uc-yakuza', name: 'Yakuza', added: [1, 2, 4], removed: [] }), entry('uc-jrpg', null, true)]
    const cols = parseCollections(base, modified)
    expect(cols.find((c) => c.id === 'uc-yakuza')?.appIds).toEqual([1, 2, 4])
    expect(cols.some((c) => c.id === 'uc-jrpg')).toBe(false)
  })

  it('tolerates garbage input', () => {
    expect(parseCollections(null)).toEqual([])
    expect(parseCollections({})).toEqual([])
  })
})

describe('Steam collection categories', () => {
  const col = (id: string, name: string, extra: Partial<SteamCollection> = {}): SteamCollection => ({
    id,
    name,
    appIds: [1],
    dynamic: false,
    kind: 'user',
    ...extra
  })

  it('adds static collections as unpinned read-only categories, skipping dynamic and hidden', () => {
    const p = ops.syncSteamCollections(defaultPrefs(), [
      col('uc-a', 'Yakuza'),
      col('uc-b', 'JRPG', { dynamic: true }),
      col('hidden', 'Hidden', { kind: 'hidden' }),
      col('favorite', 'Favorites', { kind: 'favorite' })
    ])
    const steam = p.categories.filter((c) => c.kind === 'steam')
    expect(steam.map((c) => [c.id, c.name, c.pinned])).toEqual([
      ['steamcol:uc-a', 'Yakuza', false],
      ['steamcol:favorite', 'Ulubione w Steam', false]
    ])
  })

  it('keeps pins and order, follows renames, drops deleted collections, and is a no-op when unchanged', () => {
    let p = ops.syncSteamCollections(defaultPrefs(), [col('uc-a', 'Yakuza'), col('uc-b', 'Monkey Island')])
    p = ops.setPinned(p, 'steamcol:uc-b', true)
    p = ops.moveCategory(p, 'steamcol:uc-b', -10)
    expect(ops.syncSteamCollections(p, [col('uc-a', 'Yakuza'), col('uc-b', 'Monkey Island')])).toBe(p)

    const next = ops.syncSteamCollections(p, [col('uc-b', 'Monkey Island 1-5')])
    const b = next.categories.find((c) => c.id === 'steamcol:uc-b')!
    expect(b).toMatchObject({ name: 'Monkey Island 1-5', pinned: true, order: 0 })
    expect(next.categories.some((c) => c.id === 'steamcol:uc-a')).toBe(false)
  })

  it('cannot be renamed, deleted or assigned from Lumen', () => {
    let p = ops.syncSteamCollections(defaultPrefs(), [col('uc-a', 'Yakuza')])
    expect(() => ops.renameCategory(p, 'steamcol:uc-a', 'X')).toThrow(PrefsError)
    expect(() => ops.deleteCategory(p, 'steamcol:uc-a')).toThrow(PrefsError)
    p = ops.setGameCategories(p, 'steam:1', ['steamcol:uc-a'])
    expect(p.gameCategories['steam:1']).toBeUndefined()
  })
})
