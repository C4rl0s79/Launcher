import type { ArtKind, RegionOrder } from '@shared/types'

// LaunchBox Games DB artwork: Metadata.xml lists every image of a game (<GameImage>: DatabaseID,
// FileName, Type, Region); the files are on images.launchbox-app.com. Lumen keeps only the types
// it shows and picks by type (best first), then by region (the shown version's, then preference).

export const IMAGE_BASE = 'https://images.launchbox-app.com/'

/** LaunchBox image types per use, best first */
export const LB_TYPES = {
  /** poster slot: box fronts (real box shapes, not 2:3 posters) */
  box: ['Box - Front', 'Box - Front - Reconstructed', 'Fanart - Box - Front', 'Box - 3D'],
  /** wide background */
  fanart: ['Fanart - Background'],
  screenshot: ['Screenshot - Gameplay', 'Screenshot - Game Title'],
  logo: ['Clear Logo'],
  banner: ['Banner'],
  cart: ['Cart - Front', 'Cart - 3D']
} as const

/** types stored in the local database (everything Lumen can show) */
export const STORED_TYPES: ReadonlySet<string> = new Set(Object.values(LB_TYPES).flat())

/** what the "Grafiki" window offers per art kind */
export const PICKER_TYPES: Record<ArtKind, readonly string[]> = {
  grid: [...LB_TYPES.box, ...LB_TYPES.cart],
  hero: [...LB_TYPES.fanart, ...LB_TYPES.screenshot, ...LB_TYPES.banner],
  logo: LB_TYPES.logo,
  icon: []
}

const REGIONS: Record<RegionOrder, string[]> = {
  europe: ['Europe', 'United Kingdom', 'Germany', 'France', 'Italy', 'Spain', 'World', '', 'North America', 'United States', 'Japan'],
  usa: ['North America', 'United States', 'World', '', 'Europe', 'United Kingdom', 'Germany', 'France', 'Japan'],
  japan: ['Japan', 'World', '', 'North America', 'United States', 'Europe', 'United Kingdom']
}

/** LaunchBox regions of a No-Intro tag string: "(USA, Europe)" → North America…, Europe */
export function regionsOfTags(tags: string): string[] {
  const out: string[] = []
  if (/\b(USA|America)\b/i.test(tags)) out.push('North America', 'United States')
  if (/\bEurope\b/i.test(tags)) out.push('Europe')
  if (/\b(UK|United Kingdom)\b/i.test(tags)) out.push('United Kingdom')
  if (/\bGermany\b/i.test(tags)) out.push('Germany')
  if (/\bFrance\b/i.test(tags)) out.push('France')
  if (/\bJapan\b/i.test(tags)) out.push('Japan')
  if (/\bKorea\b/i.test(tags)) out.push('Korea')
  return out
}

export interface LbImage {
  url: string
  type: string
  region: string
}

/**
 * Images of the given types, best first: type order, then the regions of the shown version, then
 * the region preference. Unknown regions go last, in database order.
 */
export function sortImages(rows: { type: string; region: string; fn: string }[], types: readonly string[], order: RegionOrder, prefer: string[] = []): LbImage[] {
  const regions = [...prefer, ...REGIONS[order].filter((r) => !prefer.includes(r))]
  const rank = (r: string): number => {
    const i = regions.indexOf(r)
    return i < 0 ? 99 : i
  }
  return rows
    .filter((r) => types.includes(r.type) && r.fn)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => types.indexOf(a.r.type) - types.indexOf(b.r.type) || rank(a.r.region) - rank(b.r.region) || a.i - b.i)
    .map(({ r }) => ({ url: IMAGE_BASE + r.fn.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), type: r.type, region: r.region }))
}
