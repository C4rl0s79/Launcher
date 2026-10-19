// Pure geometry for spatial (D-pad) navigation. No DOM access here so it can be unit-tested.

export type Dir = 'up' | 'down' | 'left' | 'right'

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Choose the best candidate in direction `dir` from `from`.
 * Score = distance along the movement axis (edge to edge) + weighted misalignment on the
 * other axis. Candidates overlapping on the cross axis are strongly preferred, which makes
 * movement inside grids and between stacked rows feel predictable.
 */
export function pickInDirection(from: Box, candidates: Box[], dir: Dir): number {
  let best = -1
  let bestScore = Infinity
  const fcx = (from.left + from.right) / 2
  const fcy = (from.top + from.bottom) / 2
  const EPS = 2
  candidates.forEach((c, i) => {
    let primary: number
    let crossGap: number
    let crossCenter: number
    if (dir === 'left' || dir === 'right') {
      primary = dir === 'right' ? c.left - from.right : from.left - c.right
      const ccx = (c.left + c.right) / 2
      // must actually be further in that direction (centre test avoids picking overlapping siblings)
      if (dir === 'right' ? ccx <= fcx + EPS : ccx >= fcx - EPS) return
      crossGap = Math.max(0, Math.max(c.top, from.top) - Math.min(c.bottom, from.bottom))
      crossCenter = Math.abs((c.top + c.bottom) / 2 - fcy)
    } else {
      primary = dir === 'down' ? c.top - from.bottom : from.top - c.bottom
      const ccy = (c.top + c.bottom) / 2
      if (dir === 'down' ? ccy <= fcy + EPS : ccy >= fcy - EPS) return
      crossGap = Math.max(0, Math.max(c.left, from.left) - Math.min(c.right, from.right))
      crossCenter = Math.abs((c.left + c.right) / 2 - fcx)
    }
    primary = Math.max(0, primary)
    const overlaps = crossGap === 0
    // Horizontal moves never jump to another row: at the end of a row focus stays put.
    if (!overlaps && (dir === 'left' || dir === 'right')) return
    const score = primary + (overlaps ? crossCenter * 0.3 : 10000 + crossGap * 3 + crossCenter)
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  })
  return best
}
