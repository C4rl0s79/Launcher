import { describe, expect, it } from 'vitest'
import type { Game } from '@shared/types'
import { applyFirstSeen, emptyFirstSeen, updateFirstSeen } from '../src/main/library/firstSeen'

const game = (appId: number, provenance: Game['provenance'], source: Game['source'] = 'steam'): Game => ({
  id: `${source === 'shortcut' ? 'shortcut' : 'steam'}:${appId}`,
  source,
  appId,
  name: `G${appId}`,
  sortName: `g${appId}`,
  provenance,
  installState: 'installed',
  installed: true
})

describe('recently added (first seen) tracking', () => {
  it('treats games present at the start as undated, later ones as new', () => {
    let d = updateFirstSeen(emptyFirstSeen(), [game(1, ['localManifest'])], false, 1000)
    expect(d.seen['steam:1']).toBe(0)
    d = updateFirstSeen(d, [game(1, ['localManifest']), game(2, ['localManifest'])], false, 2000)
    expect(d.seen['steam:2']).toBe(2000)
    expect(applyFirstSeen([game(1, ['localManifest']), game(2, ['localManifest'])], d).map((g) => g.addedAt)).toEqual([undefined, 2000])
  })

  it('keeps the original date across uninstall and reinstall', () => {
    let d = updateFirstSeen(emptyFirstSeen(), [], false, 1000)
    d = updateFirstSeen(d, [game(5, ['localManifest'])], false, 2000)
    d = updateFirstSeen(d, [], false, 3000) // uninstalled
    d = updateFirstSeen(d, [game(5, ['localManifest'])], false, 9000) // reinstalled
    expect(d.seen['steam:5']).toBe(2000)
  })

  it('does not flood "new" when a Web API key is added later', () => {
    let d = updateFirstSeen(emptyFirstSeen(), [game(1, ['localManifest'])], false, 1000)
    d = updateFirstSeen(d, [game(1, ['localManifest', 'accountApi']), game(7, ['accountApi']), game(8, ['accountApi'])], true, 5000)
    expect(d.seen['steam:7']).toBe(0)
    expect(d.seen['steam:8']).toBe(0)
    d = updateFirstSeen(d, [game(9, ['accountApi'])], true, 6000) // a real new purchase
    expect(d.seen['steam:9']).toBe(6000)
  })

  it('leaves shortcuts (ROM dates) alone and returns the same object when nothing changed', () => {
    const sc = { ...game(42, ['steamShortcut'], 'shortcut'), addedAt: 123 }
    const d = updateFirstSeen(emptyFirstSeen(), [sc], false, 1000)
    expect(d.seen['shortcut:42']).toBeUndefined()
    expect(applyFirstSeen([sc], d)[0].addedAt).toBe(123)
    expect(updateFirstSeen(d, [sc], false, 2000)).toBe(d)
  })
})
