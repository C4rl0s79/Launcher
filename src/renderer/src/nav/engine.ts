import { nearestTo, pickInDirection, type Dir } from './spatial'

// DOM side of the focus system.
//  - Focusable elements carry `data-nav`.
//  - The top-most `[data-layer]` (last in DOM order, not inert) is the active focus scope,
//    so modals trap focus without any extra code.
//  - `data-nav-group="id"` on a container makes it remember its last focused child; entering
//    the group from outside restores that child (rows on the home screen, the library grid).
//  - `data-key` gives elements a stable identity for that memory across re-renders.
//  - `data-scroll="center"` keeps the focused element vertically centred (TV-friendly rows).

const FOCUSABLE = '[data-nav]'
const groupMemory = new Map<string, string>()
/** where focus was last (and in which layer) — used when the focused element disappears */
let lastFocus: { rect: DOMRect; layer: HTMLElement } | null = null

export function activeLayer(): HTMLElement {
  const layers = Array.from(document.querySelectorAll<HTMLElement>('[data-layer]')).filter((l) => !l.closest('[inert]'))
  return layers[layers.length - 1] ?? document.body
}

function isUsable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled || el.closest('[inert]') || el.getAttribute('aria-hidden') === 'true') return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

export function focusables(root: HTMLElement = activeLayer()): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isUsable)
}

function groupOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>('[data-nav-group]')
}

export function rememberFocus(el: HTMLElement): void {
  const g = groupOf(el)
  const key = el.dataset.key
  if (g && key) groupMemory.set(g.dataset.navGroup!, key)
}

function remembered(group: HTMLElement): HTMLElement | null {
  const key = groupMemory.get(group.dataset.navGroup!)
  if (!key) return null
  const el = group.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
  return el && isUsable(el) ? el : null
}

export function focusEl(el: HTMLElement, smooth = true): void {
  el.focus({ preventScroll: true })
  const mode = el.dataset.scroll ?? el.closest<HTMLElement>('[data-scroll]')?.dataset.scroll ?? 'nearest'
  el.scrollIntoView({
    block: mode === 'center' ? 'center' : 'nearest',
    inline: 'nearest',
    behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto'
  })
}

/** Focus something sensible inside the active layer (autofocus target → remembered → first). */
export function focusFirst(root: HTMLElement = activeLayer()): boolean {
  const auto = root.querySelector<HTMLElement>('[data-autofocus]')
  if (auto && isUsable(auto)) {
    const g = groupOf(auto)
    focusEl((g && remembered(g)) || auto, false)
    return true
  }
  const list = focusables(root)
  if (!list.length) return false
  const g = groupOf(list[0])
  focusEl((g && remembered(g)) || list[0], false)
  return true
}

export function currentFocus(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null
  if (!a || a === document.body || !a.matches(FOCUSABLE)) return null
  return activeLayer().contains(a) ? a : null
}

/** `within`: only targets inside this element (a pane that must not be left by moving) */
export function move(dir: Dir, smooth = true, within?: HTMLElement): boolean {
  const cur = currentFocus()
  if (!cur) {
    // the focused element was removed (e.g. an unpinned group moved to the other list): continue
    // from the same place instead of jumping to the top of the screen
    const layer = activeLayer()
    if (lastFocus && lastFocus.layer === layer && layer.isConnected) {
      const list = focusables(layer)
      const i = nearestTo(lastFocus.rect, list.map((e) => e.getBoundingClientRect()))
      if (i >= 0) {
        focusEl(list[i], smooth)
        return true
      }
    }
    return focusFirst()
  }
  const list = focusables(within).filter((e) => e !== cur)
  const from = cur.getBoundingClientRect()
  const idx = pickInDirection(from, list.map((e) => e.getBoundingClientRect()), dir)
  if (idx < 0) {
    cur.classList.remove('nav-bump')
    void cur.offsetWidth
    cur.classList.add('nav-bump')
    return false
  }
  let target = list[idx]
  const tg = groupOf(target)
  if (tg && tg !== groupOf(cur) && (dir === 'up' || dir === 'down')) {
    // entering a row (posters): back to where it was left; in a vertical list the next row wins
    const m = remembered(tg)
    if (m) {
      const a = m.getBoundingClientRect()
      const b = target.getBoundingClientRect()
      if (a.top < b.bottom && b.top < a.bottom) target = m
    }
  }
  focusEl(target, smooth)
  return true
}

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement
    if (t?.matches?.(FOCUSABLE)) {
      rememberFocus(t)
      lastFocus = { rect: t.getBoundingClientRect(), layer: activeLayer() }
    }
  })
  // the page scrolls while moving through long lists — keep the remembered spot in view coordinates
  document.addEventListener(
    'scroll',
    () => {
      const a = document.activeElement as HTMLElement | null
      if (a?.matches?.(FOCUSABLE)) lastFocus = { rect: a.getBoundingClientRect(), layer: activeLayer() }
    },
    true
  )
}
