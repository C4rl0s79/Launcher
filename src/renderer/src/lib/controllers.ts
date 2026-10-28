import type { LumenController, LumenPadProfile, LumenPadProfileState } from '@shared/types'

// Controller profile edits of the "Kontrolery" screen (components/Controllers.tsx) — the engine
// (lumen_pads.py) cleans and applies the profile; this only shapes what the editor saves.

export const FAMILIES: [string, string][] = [
  ['duckstation', 'DuckStation'],
  ['pcsx2', 'PCSX2'],
  ['retroarch', 'RetroArch'],
  ['dolphin', 'Dolphin']
]

export const POLICY: [LumenPadProfile['unknown'], string][] = [
  ['passthrough', 'kolejni gracze, w kolejności Windows'],
  ['ignore', 'bez gracza'],
  ['hide', 'ukryte (HidHide jeszcze nieobsługiwany — na razie bez gracza)']
]

export const nextPolicy = (u: LumenPadProfile['unknown']): LumenPadProfile['unknown'] => POLICY[(POLICY.findIndex(([v]) => v === u) + 1) % POLICY.length][0]

/** hidden in this game: out of the player order */
export const hideIn = (p: LumenPadProfile, k: string): LumenPadProfile => ({
  ...p,
  order: p.order.filter((x) => x !== k),
  hidden: [...p.hidden.filter((x) => x !== k), k]
})

/** a hidden or outside device becomes the next player */
export const addIn = (p: LumenPadProfile, k: string): LumenPadProfile => ({
  ...p,
  order: [...p.order.filter((x) => x !== k), k],
  hidden: p.hidden.filter((x) => x !== k)
})

/** one place up (-1) or down (1); at the ends the order stays */
export function moveIn(p: LumenPadProfile, k: string, d: -1 | 1): LumenPadProfile {
  const i = p.order.indexOf(k)
  const j = i + d
  if (i < 0 || j < 0 || j >= p.order.length) return p
  const order = [...p.order]
  ;[order[i], order[j]] = [order[j], order[i]]
  return { ...p, order }
}

/** player number of each key in the order (0 = not connected: skipped, as in the engine) */
export function playerNumbers(order: string[], connected: Set<string>): number[] {
  let n = 0
  return order.map((k) => (connected.has(k) ? ++n : 0))
}

/** a new profile starts from what applies now (else: connected controllers in Windows order) */
export function startProfile(st: Pick<LumenPadProfileState, 'effective_profile' | 'devices'>): LumenPadProfile {
  const e = st.effective_profile
  if (e) return { order: [...e.order], hidden: [...e.hidden], unknown: e.unknown }
  const order = [...st.devices].sort((a, b) => (a.xinput_slot ?? 99) - (b.xinput_slot ?? 99)).map((d) => d.key)
  return { order, hidden: [], unknown: 'passthrough' }
}

export function effectiveLabel(st: Pick<LumenPadProfileState, 'effective' | 'key'>): string {
  const e = st.effective
  if (!e) return 'kolejność padów EmuStart (brak profilu)'
  if (e === st.key) return 'ten profil'
  if (e.startsWith('game:')) return 'profil tej gry'
  if (e.startsWith('emu:')) return `profil emulatora ${FAMILIES.find(([f]) => `emu:${f}` === e)?.[1] ?? e.slice(4)}`
  return 'profil domyślny'
}

export function familyNote(st: Pick<LumenPadProfileState, 'key' | 'family' | 'family_label'>): string {
  const f = st.family
  if (st.key === 'default') return 'Profil domyślny obowiązuje w grach i emulatorach bez własnego profilu.'
  if (f === 'duckstation' || f === 'pcsx2') return `${st.family_label}: kolejność graczy ustawiana w emulatorze przy starcie gry, po grze przywracana.`
  if (f === 'retroarch' || f === 'dolphin') return `${st.family_label}: tylko pady XInput — kierownica albo pad bez XInput nie dostanie tu gracza.`
  if (!f) return 'Nie wiadomo, jakim emulatorem uruchomi się gra — profil zadziała, gdy będzie to DuckStation, PCSX2, RetroArch albo Dolphin.'
  return `${st.family_label} nie jest jeszcze ustawiany automatycznie — przy starcie gry zobaczysz, który kontroler ma być pierwszy.`
}

export const scopeWord = (key: string): string => (key.startsWith('game:') ? 'w tej grze' : key.startsWith('emu:') ? 'w tym emulatorze' : 'we wszystkich grach')

export const devValue = (d: LumenController | undefined, key: string): string =>
  d ? `${d.bus_label} · ${d.short}${d.xinput_slot != null ? ` · XInput ${d.xinput_slot + 1}` : ''}` : key.split(':').slice(0, 2).join(':')
