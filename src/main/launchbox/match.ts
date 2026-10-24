// Title matching for the LaunchBox Games DB — a port of EmuStart's emustart/launchbox.py
// (norm_title, _nums_ok, similarity) so both programs pick the same entries.

const TAG_RE = /\s*[([][^)\]]*[)\]]/g
const ART_RE = /^(.*?),\s+(the|a|an)(?![a-z])(.*)$/
const LEAD_ART_RE = /^(the|an|a)\s+/
const NON_ALNUM = /[^a-z0-9]+/g

/** Match key: no tags, punctuation or leading article. "Legend of Zelda, The - X" = "The Legend of Zelda: X". */
export function normTitle(name: string): string {
  let s = (name ?? '').toLowerCase().replace(TAG_RE, ' ')
  const m = ART_RE.exec(s)
  if (m) s = `${m[2]} ${m[1]} ${m[3]}`
  s = s.replace(/&/g, ' and ').trim().replace(LEAD_ART_RE, '')
  return s.replace(NON_ALNUM, '')
}

export function plainTitle(name: string): string {
  return name.replace(TAG_RE, '').trim()
}

/** Dice coefficient on character bigrams. */
export function similarity(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const t = s.toLowerCase().replace(/[^a-z0-9 ]/g, '')
    const out = new Set<string>()
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const ba = bigrams(a)
  const bb = bigrams(b)
  if (!ba.size || !bb.size) return ba.size === bb.size ? 1 : 0
  let common = 0
  for (const x of ba) if (bb.has(x)) common++
  return (2 * common) / (ba.size + bb.size)
}

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }

/** Sequel numbers in the main title (before ":" / " - "), Roman numerals as integers. */
export function titleNumbers(title: string): Set<number> {
  const main = (title ?? '').replace(TAG_RE, ' ').split(/:| - /)[0]
  const out = new Set<number>()
  for (const w of main.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (/^\d+$/.test(w)) out.add(Number(w))
    else if (w in ROMAN) out.add(ROMAN[w])
  }
  return out
}

/** "Part 3" must not match "Part II". */
export function numbersMatch(a: string, b: string): boolean {
  const x = titleNumbers(a)
  const y = titleNumbers(b)
  return x.size === y.size && [...x].every((n) => y.has(n))
}

// Steam shortcut tags (as set by Steam ROM Manager or by hand) → LaunchBox platform names.
const PLATFORM_TAGS: Record<string, string> = {
  ps1: 'Sony Playstation',
  psx: 'Sony Playstation',
  playstation: 'Sony Playstation',
  ps2: 'Sony Playstation 2',
  'playstation 2': 'Sony Playstation 2',
  ps3: 'Sony Playstation 3',
  psp: 'Sony PSP',
  psvita: 'Sony Playstation Vita',
  vita: 'Sony Playstation Vita',
  nes: 'Nintendo Entertainment System',
  famicom: 'Nintendo Entertainment System',
  snes: 'Super Nintendo Entertainment System',
  n64: 'Nintendo 64',
  gb: 'Nintendo Game Boy',
  gbc: 'Nintendo Game Boy Color',
  gba: 'Nintendo Game Boy Advance',
  nds: 'Nintendo DS',
  ds: 'Nintendo DS',
  '3ds': 'Nintendo 3DS',
  gc: 'Nintendo GameCube',
  gcn: 'Nintendo GameCube',
  ngc: 'Nintendo GameCube',
  gamecube: 'Nintendo GameCube',
  wii: 'Nintendo Wii',
  wiiu: 'Nintendo Wii U',
  'wii u': 'Nintendo Wii U',
  switch: 'Nintendo Switch',
  sms: 'Sega Master System',
  mastersystem: 'Sega Master System',
  genesis: 'Sega Genesis',
  megadrive: 'Sega Genesis',
  'mega drive': 'Sega Genesis',
  md: 'Sega Genesis',
  gamegear: 'Sega Game Gear',
  gg: 'Sega Game Gear',
  segacd: 'Sega CD',
  '32x': 'Sega 32X',
  saturn: 'Sega Saturn',
  dc: 'Sega Dreamcast',
  dreamcast: 'Sega Dreamcast',
  xbox: 'Microsoft Xbox',
  x360: 'Microsoft Xbox 360',
  xbox360: 'Microsoft Xbox 360',
  'xbox 360': 'Microsoft Xbox 360',
  pce: 'NEC TurboGrafx-16',
  pcengine: 'NEC TurboGrafx-16',
  tg16: 'NEC TurboGrafx-16',
  neogeo: 'SNK Neo Geo AES',
  arcade: 'Arcade',
  mame: 'Arcade',
  fbneo: 'Arcade',
  windows: 'Windows',
  pc: 'Windows',
  dos: 'MS-DOS',
  amiga: 'Commodore Amiga',
  c64: 'Commodore 64',
  // EmuStart system names (es) not covered above
  '3do': '3DO Interactive Multiplayer',
  amigawhdgames: 'Commodore Amiga',
  atari2600: 'Atari 2600',
  atari5200: 'Atari 5200',
  atari7800: 'Atari 7800',
  atarijaguar: 'Atari Jaguar',
  lynx: 'Atari Lynx',
  atarist: 'Atari ST',
  fds: 'Nintendo Famicom Disk System',
  intellivision: 'Mattel Intellivision',
  msx: 'Microsoft MSX',
  msx2: 'Microsoft MSX2',
  n64dd: 'Nintendo 64DD',
  ngp: 'SNK Neo Geo Pocket',
  ngpc: 'SNK Neo Geo Pocket Color',
  odyssey2: 'Magnavox Odyssey 2',
  pc88: 'NEC PC-8801',
  pc98: 'NEC PC-9801',
  pico: 'Sega Pico',
  pokemini: 'Nintendo Pokemon Mini',
  satellaview: 'Nintendo Satellaview',
  scv: 'Epoch Super Cassette Vision',
  sega32x: 'Sega 32X',
  snesmsu1: 'Super Nintendo Entertainment System',
  vectrex: 'GCE Vectrex',
  virtualboy: 'Nintendo Virtual Boy',
  wswan: 'WonderSwan',
  wswanc: 'WonderSwan Color',
  zxspectrum: 'Sinclair ZX Spectrum'
}

/** LaunchBox platform of an EmuStart system (its es name) */
export function platformForEs(es: string): string | undefined {
  return PLATFORM_TAGS[es.toLowerCase()]
}

/** LaunchBox platform for a shortcut, from its Steam tags (first recognised tag wins). */
export function platformForTags(tags: string[]): string | undefined {
  for (const t of tags) {
    const p = PLATFORM_TAGS[t.trim().toLowerCase()]
    if (p) return p
  }
  return undefined
}
