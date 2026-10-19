import { useEffect, useRef, useState } from 'react'
import { sortedCategories, tabCategoryId, useStore, type Tab } from '../store'
import { Glyph } from './Hints'

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(t)
  }, [])
  return <span className="clock">{now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}</span>
}

/** Top bar: Start, the pinned groups (Steam collections, own categories, built-ins), Settings. */
export function TopBar({ tabs }: { tabs: Tab[] }) {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const prefs = useStore((s) => s.prefs)!
  const steam = useStore((s) => s.snapshot?.steam.status)
  const demo = useStore((s) => s.snapshot?.demo)
  const mode = useStore((s) => s.inputMode)
  const trackRef = useRef<HTMLDivElement>(null)
  const cats = sortedCategories(prefs)

  // keep the active tab visible when switching with LB/RB
  useEffect(() => {
    trackRef.current
      ?.querySelector<HTMLElement>('.tab.is-active')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [tab])

  const label = (t: Tab): string => {
    if (t === 'home') return 'Start'
    if (t === 'settings') return 'Ustawienia'
    return cats.find((c) => c.id === tabCategoryId(t))?.name ?? '?'
  }
  const steamLabel =
    steam === 'running' ? 'Steam działa' : steam === 'notRunning' ? 'Steam wyłączony' : steam === 'notInstalled' ? 'Brak Steam' : 'Steam: ?'

  return (
    <header className="topbar">
      <div className="brand">lumen</div>
      {mode === 'gamepad' && <Glyph action="lb" />}
      <nav className="tabs" ref={trackRef} data-nav-group="tabs" aria-label="Grupy">
        {tabs.map((t) => (
          <button
            key={t}
            data-nav
            data-key={`tab-${t}`}
            className={`tab ${tab === t ? 'is-active' : ''} ${t === 'settings' ? 'tab--settings' : ''}`}
            onClick={() => setTab(t)}
            title={label(t)}
          >
            {t === 'settings' ? <span aria-label="Ustawienia">⚙</span> : label(t)}
          </button>
        ))}
      </nav>
      {mode === 'gamepad' && <Glyph action="rb" />}
      <div className="topbar__status">
        {demo && <span className="pill pill--demo">Tryb demo</span>}
        <span className={`pill pill--steam is-${steam}`} title={steamLabel}>
          <i />
          {steamLabel}
        </span>
        <Clock />
      </div>
    </header>
  )
}
