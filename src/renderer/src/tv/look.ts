import { useSyncExternalStore } from 'react'

// The TV look editor's settings — the same keys, ranges and defaults as EmuStart's look editor
// (engine/web/look.js), so one stored look (EmuStart's config.json "look", with the profile unless
// "look_scope" is "machine") drives both apps. Values become CSS variables on the .tv frame (tv.css).

export type LookValue = number | string
export type LookValues = Record<string, LookValue>

interface Base {
  k: string
  t: string
}
export interface LookRange extends Base {
  min: number
  max: number
  step: number
  def: number
  fmt: (v: number) => string
}
export interface LookChoice extends Base {
  opts: string[]
  def: string
  fmt: (v: string) => string
  swatch?: boolean
}
/** an engine setting shown in the editor (not part of "look"): saved through the shared options */
export interface LookSetting extends Base {
  setting: 'gamesLogo' | 'lookScope'
}
export type LookItem = LookRange | LookChoice | LookSetting
export type LookRow = { head: string } | LookItem

export const ACCENTS: [string, string][] = [
  ['#4f8cff', 'niebieski'],
  ['#8a5cff', 'fioletowy'],
  ['#1fb5c4', 'turkusowy'],
  ['#2fb36f', 'zielony'],
  ['#d4a017', 'złoty'],
  ['#ff8a3d', 'pomarańczowy'],
  ['#e5484d', 'czerwony'],
  ['#e0559b', 'różowy']
]
/** name → [background, glow at the top, label] */
export const BACKS: Record<string, [string, string, string]> = {
  granat: ['#0b0d12', '#1b2236', 'granatowe'],
  czern: ['#000000', '#000000', 'czarne'],
  grafit: ['#101010', '#2a2a2a', 'grafitowe'],
  fiolet: ['#0d0b14', '#2a1f45', 'fioletowe'],
  zielen: ['#0a100d', '#173226', 'zielone'],
  bordo: ['#120a0b', '#3a171c', 'bordowe']
}

const pct = (v: number): string => `${Math.round(v)}%`
const vh = (v: number): string => `${+v.toFixed(1)} vh`
const fs = (k: string, t: string, min: number, max: number): LookRange => ({ k, t, min, max, step: 5, def: 100, fmt: pct })

export const LOOK_SPEC: LookRow[] = [
  { head: 'Logo' },
  { k: 'tlogo', t: 'Logo tytułu na liście — wysokość', min: 50, max: 100, step: 2, def: 92, fmt: (v: number) => `${v}% wiersza` },
  { k: 'tlogo_w', t: 'Logo tytułu na liście — szerokość', min: 30, max: 95, step: 5, def: 75, fmt: (v: number) => `do ${v}%` },
  { k: 'syslogo', t: 'Logo systemu w karuzeli', min: 50, max: 150, step: 5, def: 100, fmt: pct },
  { k: 'car_gap', t: 'Odstęp między logo systemów', min: 14, max: 40, step: 1, def: 25, fmt: (v: number) => `${v} vw` },
  { k: 'listlogo', t: 'Logo systemu i gry nad listą', min: 3, max: 14, step: 0.5, def: 6.5, fmt: vh },
  { head: 'Lista i podgląd' },
  { k: 'row', t: 'Wysokość wiersza listy', min: 3, max: 10, step: 0.2, def: 4.6, fmt: vh },
  { k: 'list_w', t: 'Szerokość listy gier', min: 25, max: 65, step: 1, def: 42, fmt: (v: number) => `${v}% ekranu` },
  { k: 'media_h', t: 'Wysokość okładki i zrzutu', min: 20, max: 62, step: 1, def: 44, fmt: vh },
  { k: 'setrow', t: 'Wysokość wiersza w ustawieniach', min: 2.4, max: 8, step: 0.2, def: 4.6, fmt: vh },
  { k: 'desc_lines', t: 'Liczba linii opisu gry', min: 3, max: 40, step: 1, def: 14, fmt: (v: number) => String(v) },
  { head: 'Wielkość czcionek' },
  fs('fs', 'Cały interfejs', 70, 170),
  fs('fs_list', 'Lista gier', 60, 200),
  fs('fs_title', 'Tytuł gry w podglądzie', 60, 220),
  fs('fs_meta', 'Metadane (rok, gatunek…)', 60, 200),
  fs('fs_desc', 'Opis gry', 60, 200),
  fs('fs_sys', 'Nazwa systemu (karuzela)', 50, 200),
  fs('fs_sysdesc', 'Informacje i opis systemu', 60, 200),
  fs('fs_menu', 'Menu, okna i ustawienia', 60, 180),
  fs('fs_hint', 'Pasek podpowiedzi (dół)', 60, 180),
  fs('fs_top', 'Pasek górny', 60, 180),
  { head: 'Kolory' },
  { k: 'accent', t: 'Kolor akcentu', opts: ACCENTS.map(([c]) => c), def: '#4f8cff', fmt: (v: string) => (ACCENTS.find(([c]) => c === v) ?? [v, v])[1], swatch: true },
  { k: 'bg', t: 'Tło', opts: Object.keys(BACKS), def: 'granat', fmt: (v: string) => (BACKS[v] ?? BACKS.granat)[2] },
  { head: 'Inne' },
  { k: 'games_logo', t: 'Tytuły gier jako logo', setting: 'gamesLogo' },
  { k: 'look_scope', t: 'Wygląd zapisywany', setting: 'lookScope' }
]

export const LOOK_ITEMS = LOOK_SPEC.filter((r): r is LookItem => 'k' in r)
const item = (k: string): LookItem | undefined => LOOK_ITEMS.find((i) => i.k === k)
export const isRange = (it: LookItem): it is LookRange => 'min' in it
export const isChoice = (it: LookItem): it is LookChoice => 'opts' in it
export const isSetting = (it: LookItem): it is LookSetting => 'setting' in it

/** the value in force: a valid stored one (clamped to the range), otherwise the default */
export function rangeValue(values: LookValues, it: LookRange): number {
  const v = values[it.k]
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(it.max, Math.max(it.min, v)) : it.def
}
export function choiceValue(values: LookValues, it: LookChoice): string {
  const v = values[it.k]
  return typeof v === 'string' && it.opts.includes(v) ? v : it.def
}
export const lookValue = (values: LookValues, it: LookRange | LookChoice): LookValue => (isChoice(it) ? choiceValue(values, it) : rangeValue(values, it))

/** one step of a range (clamped) or the next / previous choice (wraps), as look.js does */
export function stepLook(values: LookValues, it: LookRange | LookChoice, dir: number): LookValues {
  if (isChoice(it)) {
    const n = it.opts.length
    const i = Math.max(0, it.opts.indexOf(choiceValue(values, it)))
    return { ...values, [it.k]: it.opts[(((i + dir) % n) + n) % n] }
  }
  const v = rangeValue(values, it) + dir * it.step
  return { ...values, [it.k]: +Math.min(it.max, Math.max(it.min, v)).toFixed(2) }
}

/** what EmuStart stores: only known keys that differ from the default (look.js closeLook) */
export function lookToSave(values: LookValues): LookValues {
  const out: LookValues = {}
  for (const it of LOOK_ITEMS) {
    if (isSetting(it) || values[it.k] === undefined) continue
    const v = lookValue(values, it)
    if (v !== it.def) out[it.k] = v
  }
  return out
}

/** the stored look (any shape) → known keys only */
export function lookFromEngine(raw: unknown): LookValues {
  const out: LookValues = {}
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const it of LOOK_ITEMS) {
    const v = r[it.k]
    if (isRange(it) && typeof v === 'number' && Number.isFinite(v)) out[it.k] = v
    else if (isChoice(it) && typeof v === 'string' && it.opts.includes(v)) out[it.k] = v
  }
  return out
}

/** CSS variables of the .tv frame (tv.css) for a look */
export function lookStyle(values: LookValues): Record<string, string> {
  const n = (k: string): number => rangeValue(values, item(k) as LookRange)
  const c = (k: string): string => choiceValue(values, item(k) as LookChoice)
  const back = BACKS[c('bg')] ?? BACKS.granat
  const style: Record<string, string> = {
    '--tv-tlogo-h': String(n('tlogo') / 100),
    '--tv-tlogo-w': `${n('tlogo_w')}%`,
    '--tv-car-h': `${(34 * n('syslogo')) / 100}%`,
    '--tv-car-w': `${(26 * n('syslogo')) / 100}vw`,
    '--tv-listlogo-h': `${n('listlogo')}vh`,
    '--tv-row': `max(28px, ${n('row')}vh)`,
    '--tv-list-w': `${n('list_w')}%`,
    '--tv-media-h': `${n('media_h')}vh`,
    '--tv-setrow': `max(28px, ${n('setrow')}vh)`,
    '--tv-desc-lines': String(n('desc_lines')),
    '--tv-accent': c('accent'),
    '--tv-bg': back[0],
    '--tv-bg-grad': back[1]
  }
  for (const k of ['fs', 'fs_list', 'fs_title', 'fs_meta', 'fs_desc', 'fs_sys', 'fs_sysdesc', 'fs_menu', 'fs_hint', 'fs_top'])
    style[`--tv-${k.replace('_', '-')}`] = String(n(k) / 100)
  return style
}

/** the carousel's spacing between system logos (vw) */
export const carouselGap = (values: LookValues): number => rangeValue(values, item('car_gap') as LookRange)

// ---- the look in force (one per window; loaded from the engine by the TV layout) ----
let current: LookValues = {}
const listeners = new Set<() => void>()

export function setLook(values: LookValues): void {
  current = values
  for (const l of listeners) l()
}
export const getLook = (): LookValues => current

export function useLook(): LookValues {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current
  )
}
