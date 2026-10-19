import { useEffect, useState } from 'react'
import { useStore, type Tab } from '../store'
import { Glyph } from './Hints'

const LABELS: Record<Tab, string> = { home: 'Start', library: 'Biblioteka', settings: 'Ustawienia' }

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(t)
  }, [])
  return <span className="clock">{now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}</span>
}

export function TopBar() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const steam = useStore((s) => s.snapshot?.steam.status)
  const demo = useStore((s) => s.snapshot?.demo)
  const mode = useStore((s) => s.inputMode)

  const steamLabel =
    steam === 'running' ? 'Steam działa' : steam === 'notRunning' ? 'Steam wyłączony' : steam === 'notInstalled' ? 'Brak Steam' : 'Steam: ?'

  return (
    <header className="topbar">
      <div className="brand">lumen</div>
      <nav className="tabs" data-nav-group="tabs">
        {mode === 'gamepad' && <Glyph action="lb" />}
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button key={t} data-nav data-key={`tab-${t}`} className={`tab ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
            {LABELS[t]}
          </button>
        ))}
        {mode === 'gamepad' && <Glyph action="rb" />}
      </nav>
      <div className="topbar__status">
        {demo && <span className="pill pill--demo">Tryb demo</span>}
        <span className={`pill pill--steam is-${steam}`}>
          <i />
          {steamLabel}
        </span>
        <Clock />
      </div>
    </header>
  )
}
