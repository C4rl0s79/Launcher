import { describe, expect, it, vi } from 'vitest'
import type { Category, Game, Prefs } from '@shared/types'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
const { gamesForCategory } = await import('../src/renderer/src/store')

const g = (id: string, source: Game['source'], installed: boolean, appId = 1): Game => ({
  id,
  source,
  appId,
  name: id,
  sortName: id,
  provenance: [],
  installState: installed ? 'installed' : 'notInstalled',
  installed
})
const smart = (s: Category['smart']): Category => ({ id: `smart:${s}`, name: String(s), kind: 'smart', smart: s, pinned: true, order: 0 })
const prefs: Prefs = { version: 2, categories: [], gameCategories: {}, favorites: ['shortcut:9'], art: {}, artTv: {}, versions: {} }

describe('built-in groups', () => {
  const games = [g('steam:1', 'steam', true, 1), g('steam:2', 'steam', false, 2), g('shortcut:9', 'shortcut', true, 9)]

  it('"all", "installed" and "to install" cover Steam games only', () => {
    expect(gamesForCategory(smart('all'), games, prefs, null).map((x) => x.id)).toEqual(['steam:1', 'steam:2'])
    expect(gamesForCategory(smart('installed'), games, prefs, null).map((x) => x.id)).toEqual(['steam:1'])
    expect(gamesForCategory(smart('notInstalled'), games, prefs, null).map((x) => x.id)).toEqual(['steam:2'])
  })

  it('emulator shortcuts stay in their Steam collection and in favourites', () => {
    expect(gamesForCategory(smart('favorites'), games, prefs, null).map((x) => x.id)).toEqual(['shortcut:9'])
    const ps2: Category = { id: 'steamcol:ps2', name: 'PS2', kind: 'steam', steamCollectionId: 'ps2', pinned: true, order: 1 }
    const cols = [{ id: 'ps2', name: 'PS2', appIds: [9], dynamic: false, kind: 'user' as const }]
    expect(gamesForCategory(ps2, games, prefs, cols).map((x) => x.id)).toEqual(['shortcut:9'])
  })
})
