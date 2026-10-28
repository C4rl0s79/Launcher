import { describe, expect, it } from 'vitest'
import type { LumenPadProfile } from '@shared/types'
import { addIn, effectiveLabel, hideIn, moveIn, nextPolicy, playerNumbers, startProfile } from '../src/renderer/src/lib/controllers'

const P: LumenPadProfile = {
  order: ['wheel', 'bt', 'xbox'],
  hidden: [],
  unknown: 'passthrough'
}
const dev = (key: string, xinput_slot: number | null) => ({
  key,
  short: key,
  label: key,
  bus: 'usb',
  bus_label: 'USB',
  xinput_slot
})

describe('controller profile editor', () => {
  it('moves one place and stops at the ends', () => {
    expect(moveIn(P, 'xbox', -1).order).toEqual(['wheel', 'xbox', 'bt'])
    expect(moveIn(P, 'wheel', -1)).toBe(P)
    expect(moveIn(P, 'xbox', 1)).toBe(P)
    expect(moveIn(P, 'nope', 1)).toBe(P)
  })

  it('hides out of the order and brings back as the next player', () => {
    const h = hideIn(P, 'bt')
    expect(h).toEqual({
      order: ['wheel', 'xbox'],
      hidden: ['bt'],
      unknown: 'passthrough'
    })
    expect(hideIn(h, 'bt').hidden).toEqual(['bt'])
    expect(addIn(h, 'bt')).toEqual({ ...P, order: ['wheel', 'xbox', 'bt'] })
    expect(addIn(P, 'new').order).toEqual(['wheel', 'bt', 'xbox', 'new'])
  })

  it('numbers only connected devices (as the engine compacts the players)', () => {
    expect(playerNumbers(P.order, new Set(['bt', 'xbox']))).toEqual([0, 1, 2])
  })

  it('cycles the policy for devices outside the profile', () => {
    expect(nextPolicy('passthrough')).toBe('ignore')
    expect(nextPolicy('ignore')).toBe('hide')
    expect(nextPolicy('hide')).toBe('passthrough')
  })

  it('starts a new profile from the one that applies, else Windows order', () => {
    const fromEff = startProfile({ effective_profile: P, devices: [] })
    expect(fromEff).toEqual(P)
    expect(fromEff.order).not.toBe(P.order)
    expect(
      startProfile({
        effective_profile: null,
        devices: [dev('wheel', null), dev('b', 1), dev('a', 0)]
      }).order
    ).toEqual(['a', 'b', 'wheel'])
  })

  it('names the profile that applies', () => {
    expect(effectiveLabel({ key: 'game:5', effective: null })).toMatch(/EmuStart/)
    expect(effectiveLabel({ key: 'game:5', effective: 'game:5' })).toBe('ten profil')
    expect(effectiveLabel({ key: 'game:5', effective: 'emu:pcsx2' })).toBe('profil emulatora PCSX2')
    expect(effectiveLabel({ key: 'game:5', effective: 'default' })).toBe('profil domyślny')
  })
})
