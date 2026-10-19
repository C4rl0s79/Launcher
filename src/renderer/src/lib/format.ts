import type { Game, InstallState } from '@shared/types'

export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  const d = n % 10
  const t = n % 100
  if (d >= 2 && d <= 4 && (t < 12 || t > 14)) return few
  return many
}

export function formatPlaytime(minutes?: number): string | undefined {
  if (minutes === undefined) return undefined
  if (minutes <= 0) return 'Nie grano'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  if (h >= 100) return `${h} godz.`
  const m = minutes % 60
  return m ? `${h} godz. ${m} min` : `${h} godz.`
}

export function formatLastPlayed(unix?: number): string | undefined {
  if (!unix) return undefined
  const d = new Date(unix * 1000)
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (days <= 0) return 'Dziś'
  if (days === 1) return 'Wczoraj'
  if (days < 7) return `${days} ${plural(days, 'dzień', 'dni', 'dni')} temu`
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

export function formatBytes(bytes?: number): string | undefined {
  if (!bytes) return undefined
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`
}

export const STATE_LABEL: Record<InstallState, string> = {
  installed: 'Zainstalowana',
  notInstalled: 'Niezainstalowana',
  updateRequired: 'Wymaga aktualizacji',
  updating: 'Aktualizowanie w Steam',
  updatePaused: 'Pobieranie wstrzymane',
  installing: 'Instalowanie w Steam',
  uninstalling: 'Odinstalowywanie',
  broken: 'Wymaga weryfikacji w Steam'
}

export function gameCountLabel(n: number): string {
  return `${n} ${plural(n, 'gra', 'gry', 'gier')}`
}

export function isBusy(g: Game): boolean {
  return g.installState === 'installing' || g.installState === 'updating' || g.installState === 'updatePaused'
}

/** Deterministic hue from a string for placeholder artwork. */
export function hueOf(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

/** Plain text paragraphs from Steam's HTML description (never injected as HTML). */
export function htmlToParagraphs(html: string, max = 6): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('img, video, script, style').forEach((n) => n.remove())
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'))
  doc.querySelectorAll('p, h1, h2, h3, li, div').forEach((n) => n.append('\n'))
  return (doc.body.textContent ?? '')
    .split(/\n+/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 1)
    .slice(0, max)
}
