import { describe, expect, it, vi } from 'vitest'

// input.ts pulls in the zustand store which touches localStorage lazily; stub what node lacks.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })

const { pickInDirection, nearestTo } = await import('../src/renderer/src/nav/spatial')
const { keyToAction, readPadActions, xinputActions } = await import('../src/renderer/src/nav/input')
const { steamUri } = await import('../src/main/steam/actions')

const box = (left: number, top: number, w = 100, h = 150) => ({ left, top, right: left + w, bottom: top + h })

describe('spatial navigation', () => {
  it('after the focused element disappears, continues from the element that took its place', () => {
    // rows of "Odepnij" buttons: the focused one (y=100) was removed, the next row moved up into its place
    const gone = { left: 0, top: 100, right: 80, bottom: 130 }
    const rows = [
      { left: 0, top: 60, right: 80, bottom: 90 },
      { left: 0, top: 100, right: 80, bottom: 130 },
      { left: 90, top: 100, right: 120, bottom: 130 },
      { left: 0, top: 140, right: 80, bottom: 170 }
    ]
    expect(nearestTo(gone, rows)).toBe(1)
    expect(nearestTo(gone, [])).toBe(-1)
  })

  // two rows of posters: row A at y=0 (x = 0,120,240), row B at y=200 (x = 0,120)
  const items = [box(0, 0), box(120, 0), box(240, 0), box(0, 200), box(120, 200)]

  it('moves within a row', () => {
    expect(pickInDirection(items[0], items, 'right')).toBe(1)
    expect(pickInDirection(items[1], items, 'left')).toBe(0)
  })

  it('stays put at the end of a row instead of jumping rows', () => {
    expect(pickInDirection(items[2], items, 'right')).toBe(-1)
    expect(pickInDirection(items[3], items, 'left')).toBe(-1)
  })

  it('moves between rows to the aligned item, or the nearest one', () => {
    expect(pickInDirection(items[1], items, 'down')).toBe(4)
    expect(pickInDirection(items[2], items, 'down')).toBe(4)
    expect(pickInDirection(items[3], items, 'up')).toBe(0)
  })

  it('reaches a wide toolbar button from below', () => {
    const toolbar = { left: 0, top: -80, right: 600, bottom: -40 }
    expect(pickInDirection(items[2], [...items, toolbar], 'up')).toBe(5)
  })
})

describe('keyboard mapping', () => {
  const k = (key: string, ctrl = false) => ({ key, ctrlKey: ctrl, altKey: false, metaKey: false })
  it('maps navigation and actions', () => {
    expect(keyToAction(k('ArrowDown'), false)).toBe('down')
    expect(keyToAction(k('Enter'), false)).toBe('confirm')
    expect(keyToAction(k('Escape'), false)).toBe('back')
    expect(keyToAction(k('f'), false)).toBe('x')
    expect(keyToAction(k('f', true), false)).toBe('y')
  })
  it('leaves typing alone inside text fields', () => {
    expect(keyToAction(k('f'), true)).toBeNull()
    expect(keyToAction(k('ArrowLeft'), true)).toBeNull()
    expect(keyToAction(k('Backspace'), true)).toBeNull()
    expect(keyToAction(k('Escape'), true)).toBe('back')
    expect(keyToAction(k('ArrowDown'), true)).toBe('down')
  })
})

describe('gamepad mapping', () => {
  const pad = (pressed: number[], axes = [0, 0, 0, 0]) =>
    ({
      connected: true,
      mapping: 'standard',
      axes,
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 }))
    }) as unknown as Gamepad

  it('maps standard buttons', () => {
    expect([...readPadActions([pad([0, 12])])].sort()).toEqual(['confirm', 'up'])
    expect([...readPadActions([pad([1])])]).toEqual(['back'])
  })
  it('maps the left stick with a dead zone', () => {
    expect([...readPadActions([pad([], [0.9, 0.1])])]).toEqual(['right'])
    expect([...readPadActions([pad([], [0.3, -0.2])])]).toEqual([])
    expect([...readPadActions([pad([], [0.2, -0.95])])]).toEqual(['up'])
  })
  it('ignores disconnected pads', () => {
    expect(readPadActions([null, { ...pad([0]), connected: false } as Gamepad]).size).toBe(0)
  })
})

describe('XInput mapping (main-process polling backend)', () => {
  const pad = (over: Partial<{ index: number; buttons: number; lt: number; rt: number; lx: number; ly: number }> = {}) => ({
    index: 0,
    buttons: 0,
    lt: 0,
    rt: 0,
    lx: 0,
    ly: 0,
    ...over
  })
  it('maps XINPUT_GAMEPAD button bits', () => {
    expect([...xinputActions([pad({ buttons: 0x1000 | 0x0001 })])].sort()).toEqual(['confirm', 'up'])
    expect([...xinputActions([pad({ buttons: 0x2000 })])]).toEqual(['back'])
    expect([...xinputActions([pad({ buttons: 0x0010 | 0x0020 })])].sort()).toEqual(['menu', 'view'])
    expect([...xinputActions([pad({ buttons: 0x0100 | 0x0200 })])].sort()).toEqual(['lb', 'rb'])
  })
  it('maps triggers and the left stick (Y axis up) with a dead zone', () => {
    expect([...xinputActions([pad({ lt: 200, rt: 30 })])]).toEqual(['lt'])
    expect([...xinputActions([pad({ ly: 30000 })])]).toEqual(['up'])
    expect([...xinputActions([pad({ ly: -30000 })])]).toEqual(['down'])
    expect([...xinputActions([pad({ lx: 28000, ly: 5000 })])]).toEqual(['right'])
    expect(xinputActions([pad({ lx: -536, ly: -49 })]).size).toBe(0) // resting drift
  })
  it('combines several pads and ignores an empty list', () => {
    expect(xinputActions([]).size).toBe(0)
    expect([...xinputActions([pad({ buttons: 0x1000 }), pad({ index: 1, buttons: 0x4000 })])].sort()).toEqual(['confirm', 'x'])
  })
})

describe('steam:// URIs', () => {
  it('builds documented browser-protocol commands', () => {
    expect(steamUri('run', 620)).toBe('steam://rungameid/620')
    expect(steamUri('install', 620)).toBe('steam://install/620')
    expect(steamUri('details', 620)).toBe('steam://nav/games/details/620')
    expect(steamUri('downloads')).toBe('steam://open/downloads')
  })
  it('rejects invalid ids', () => {
    expect(() => steamUri('run', 0)).toThrow()
    expect(() => steamUri('install', -5)).toThrow()
  })
})
