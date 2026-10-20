import { useEffect, useRef, useState } from 'react'
import { sortedCategories, tabCategoryId, useStore, type Tab } from '../store'
import { Glyph } from './Hints'
import { JobsPill } from './Jobs'
import { api } from '../store'

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
  const emu = useStore((s) => s.snapshot?.emustart)
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
  const emuLabel = !emu || emu.engine === 'disabled'
    ? null
    : emu.engine === 'starting'
      ? 'EmuStart: uruchamianie…'
      : emu.engine !== 'ready'
        ? 'EmuStart nie działa'
        : !emu.server
          ? 'EmuStart: nie zalogowano'
          : emu.server.ok
            ? `EmuStart${emu.server.name ? `: ${emu.server.name}` : ''}`
            : emu.server.checking
              ? 'EmuStart: łączę…'
              : 'Serwer EmuStart niedostępny'
  const emuOk = emu?.engine === 'ready' && !!emu.server?.ok
  const steamLabel =
    steam === 'running' ? 'Steam działa' : steam === 'notRunning' ? 'Steam wyłączony' : steam === 'notInstalled' ? 'Brak Steam' : 'Steam: ?'

  return (
    <header className="topbar">
      <div className="brand">lumen</div>
      {mode === 'gamepad' && <Glyph action="lb" />}
      <nav className="tabs" ref={trackRef} aria-label="Grupy">
        {tabs.map((t) => (
          // switched with LB/RB (Q/E) or the mouse only — never reachable with the D-pad / arrows
          <button
            key={t}
            tabIndex={-1}
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
        <JobsPill />
        {emuLabel && (
          <span className={`pill pill--steam ${emuOk ? 'is-running' : 'is-notRunning'}`} title={emu?.message ?? emuLabel}>
            <i />
            {emuLabel}
          </span>
        )}
        <span className={`pill pill--steam is-${steam}`} title={steamLabel}>
          <i />
          {steamLabel}
        </span>
        <button className="pill pill--mode" tabIndex={-1} onClick={() => void api().ui.setMode('fullscreen')} title="Tryb pełnoekranowy (F10 · View+Start)">
          ⛶ Tryb TV
        </button>
        <Clock />
      </div>
    </header>
  )
}
