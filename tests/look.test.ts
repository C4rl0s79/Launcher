import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toEngineSettings } from '../src/main/emustart/ipc'
import { LOOK_ITEMS, carouselGap, isChoice, isRange, isSetting, lookFromEngine, lookStyle, lookToSave, rangeValue, stepLook, type LookChoice, type LookRange } from '../src/renderer/src/tv/look'

const item = <T>(k: string): T => LOOK_ITEMS.find((i) => i.k === k) as T

describe('TV look editor (EmuStart look.js in Lumen)', () => {
  it('has the same keys, ranges and defaults as EmuStart, so both apps share one stored look', () => {
    const js = readFileSync(resolve(import.meta.dirname, '../engine/web/look.js'), 'utf8')
    const engine = new Map<string, string>()
    for (const m of js.matchAll(/\{ k: "(\w+)"[^\n]*/g)) engine.set(m[1], m[0])
    expect([...engine.keys()]).toEqual(LOOK_ITEMS.map((i) => i.k))
    for (const it of LOOK_ITEMS) {
      const line = engine.get(it.k)!
      if (isRange(it)) {
        for (const f of ['min', 'max', 'step', 'def'] as const) expect(line, `${it.k}.${f}`).toMatch(new RegExp(`\\b${f}: ${it[f]},`))
      } else if (isChoice(it)) {
        expect(line).toContain(it.def)
      } else {
        expect(line).toContain('cfg: true')
      }
    }
  })

  it('steps ranges within limits and wraps choices', () => {
    const row = item<LookRange>('row')
    let v = stepLook({}, row, 1)
    expect(v.row).toBe(4.8)
    for (let i = 0; i < 100; i++) v = stepLook(v, row, 1)
    expect(v.row).toBe(10)
    const bg = item<LookChoice>('bg')
    expect(stepLook({}, bg, -1).bg).toBe('bordo')
    expect(stepLook({ bg: 'bordo' }, bg, 1).bg).toBe('granat')
  })

  it('saves only the changed values and reads back only known, valid ones', () => {
    expect(lookToSave({ row: 4.6, list_w: 50, accent: '#4f8cff', bg: 'grafit' })).toEqual({ list_w: 50, bg: 'grafit' })
    expect(lookFromEngine({ list_w: 50, bg: 'nope', accent: '#e5484d', other: 3, fs: 'x' })).toEqual({ list_w: 50, accent: '#e5484d' })
    expect(lookFromEngine(null)).toEqual({})
    expect(rangeValue({ list_w: 999 }, item<LookRange>('list_w'))).toBe(65)
  })

  it('turns the look into the CSS variables of the TV layout (defaults = the current layout)', () => {
    const d = lookStyle({})
    expect(d['--tv-row']).toBe('max(28px, 4.6vh)')
    expect(d['--tv-list-w']).toBe('42%')
    expect(d['--tv-media-h']).toBe('44vh')
    expect(d['--tv-car-h']).toBe('34%')
    expect(d['--tv-car-w']).toBe('26vw')
    expect(d['--tv-bg']).toBe('#0b0d12')
    expect(carouselGap({})).toBe(25)
    const s = lookStyle({ list_w: 55, syslogo: 150, fs_list: 120, accent: '#2fb36f', bg: 'czern', desc_lines: 6 })
    expect(s['--tv-list-w']).toBe('55%')
    expect(s['--tv-car-h']).toBe('51%')
    expect(s['--tv-fs-list']).toBe('1.2')
    expect(s['--tv-accent']).toBe('#2fb36f')
    expect(s['--tv-bg']).toBe('#000000')
    expect(s['--tv-desc-lines']).toBe('6')
  })

  it('engine settings in the editor go through the shared options', () => {
    expect(LOOK_ITEMS.filter(isSetting).map((i) => i.setting)).toEqual(['gamesLogo', 'lookScope'])
    expect(toEngineSettings({ lookScope: 'machine' })).toEqual({ look_scope: 'machine' })
    expect(toEngineSettings({ lookScope: 'x' as never })).toEqual({})
  })
})
