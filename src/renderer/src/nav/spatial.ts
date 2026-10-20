// Pure geometry for spatial (D-pad) navigation. No DOM access here so it can be unit-tested.

export type Dir = 'up' | 'down' | 'left' | 'right'

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Candidates whose leading edge is within this distance of the nearest one form the "next row". */
const ROW_BAND = 12

/**
 * Choose the best candidate in direction `dir` from `from`.
 * - Horizontal: only items overlapping vertically (same row); at a row end focus stays put.
 * - Vertical: first find the nearest row in that direction, then the item in that row
 *   closest horizontally (overlapping items win). Rows are never skipped.
 */
export function pickInDirection(from: Box, candidates: Box[], dir: Dir): number {
  const fcx = (from.left + from.right) / 2
  const fcy = (from.top + from.bottom) / 2
  const EPS = 2
  const horizontal = dir === 'left' || dir === 'right'

  const eligible: { i: number; primary: number; crossGap: number; crossCenter: number }[] = []
  candidates.forEach((c, i) => {
    if (horizontal) {
      const ccx = (c.left + c.right) / 2
      if (dir === 'right' ? ccx <= fcx + EPS : ccx >= fcx - EPS) return
      const crossGap = Math.max(0, Math.max(c.top, from.top) - Math.min(c.bottom, from.bottom))
      if (crossGap > 0) return
      const primary = Math.max(0, dir === 'right' ? c.left - from.right : from.left - c.right)
      eligible.push({ i, primary, crossGap, crossCenter: Math.abs((c.top + c.bottom) / 2 - fcy) })
    } else {
      const ccy = (c.top + c.bottom) / 2
      if (dir === 'down' ? ccy <= fcy + EPS : ccy >= fcy - EPS) return
      // must start beyond our own edge (with a little tolerance for overlapping layouts)
      const primary = dir === 'down' ? c.top - from.bottom : from.top - c.bottom
      if (primary < -(from.bottom - from.top) / 2) return
      const crossGap = Math.max(0, Math.max(c.left, from.left) - Math.min(c.right, from.right))
      // distance to the centre, or to the left edge — whichever is closer (wide items land on the first child)
      const crossCenter = Math.min(Math.abs((c.left + c.right) / 2 - fcx), Math.abs(c.left - from.left))
      eligible.push({ i, primary: Math.max(0, primary), crossGap, crossCenter })
    }
  })
  if (!eligible.length) return -1

  let pool = eligible
  if (!horizontal) {
    const nearest = Math.min(...eligible.map((e) => e.primary))
    pool = eligible.filter((e) => e.primary <= nearest + ROW_BAND)
  }
  let best = pool[0]
  const score = (e: (typeof pool)[number]): number =>
    horizontal ? e.primary + e.crossCenter * 0.3 : e.crossGap * 2 + e.crossCenter * 0.5
  for (const e of pool) if (score(e) < score(best)) best = e
  return best.i
}

/**
 * The focused element disappeared (unpinned row moved to another list, deleted item): the
 * candidate closest to where it was — usually the element that took its place.
 */
export function nearestTo(from: Box, candidates: Box[]): number {
  const fcx = (from.left + from.right) / 2
  const fcy = (from.top + from.bottom) / 2
  let best = -1
  let bestD = Infinity
  candidates.forEach((c, i) => {
    const dx = (c.left + c.right) / 2 - fcx
    const dy = (c.top + c.bottom) / 2 - fcy
    // rows matter more than columns: stay in the same row when possible
    const d = Math.abs(dy) * 2 + Math.abs(dx)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}
