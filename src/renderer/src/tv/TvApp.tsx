import { useEffect, useState } from 'react'
import { api, attempt, useStore } from '../store'
import { useActions, useHints, type Action } from '../nav/input'
import { focusFirst } from '../nav/engine'
import { SettingsScreen } from '../screens/Settings'
import { TvSystems } from './TvSystems'
import { TvGames } from './TvGames'
import { useTvSystems } from './data'
import { loginFlow, logoutFlow } from '../lib/account'
import './tv.css'

// The TV layout of Lumen's one interface (fullscreen mode) with EmuStart's look: system carousel →
// game list → play. Same library, same actions and the same overlays (launch, save conflict,
// profile lock, details) as the desktop layout — only the layout differs (docs/PLAN-TV-REACT.md).

type Screen = 'systems' | 'games' | 'settings'

export function TvApp() {
  const systems = useTvSystems()
  const [screen, setScreen] = useState<Screen>('systems')
  const [sysIdx, setSysIdx] = useState(0)
  const [menu, setMenu] = useState(false)
  const selection = useStore((s) => s.detailsId)

  // opened from the desktop with a game selected: start on its system
  const opened = useStore((s) => s.uiSelection)
  useEffect(() => {
    if (!opened) return
    const i = systems.findIndex((s) => s.games.some((g) => g.id === opened))
    if (i >= 0) setSysIdx(i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])
  useEffect(() => {
    if (sysIdx >= systems.length && systems.length) setSysIdx(0)
  }, [systems.length, sysIdx])

  const sys = systems[sysIdx]
  return (
    <div className="tv" data-layer inert={selection ? true : undefined}>
      <TvTopBar />
      {screen === 'systems' && (
        <TvSystems
          systems={systems}
          index={sysIdx}
          onIndex={setSysIdx}
          onOpen={() => sys && setScreen('games')}
          onMenu={() => setMenu(true)}
          active={!menu}
        />
      )}
      {screen === 'games' && sys && <TvGames key={sys.key} system={sys} onBack={() => setScreen('systems')} onMenu={() => setMenu(true)} active={!menu} />}
      {screen === 'settings' && <TvSettings onBack={() => setScreen('systems')} />}
      {menu && (
        <TvMenu
          onClose={() => setMenu(false)}
          onSettings={() => {
            setMenu(false)
            setScreen('settings')
          }}
        />
      )}
      <TvHints />
    </div>
  )
}

function TvTopBar() {
  const emu = useStore((s) => s.snapshot?.emustart)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  const server = emu?.server
  const net = !server
    ? { cls: 'warn', text: 'Serwer: nie zalogowano' }
    : server.ok
      ? { cls: 'ok', text: `Serwer ${server.name ?? ''}`.trim() }
      : server.key_rejected
        ? { cls: 'err', text: 'Serwer nie przyjmuje urządzenia' }
        : { cls: 'warn', text: 'Serwer: łączę…' }
  return (
    <header className="tv-top">
      <div className="tv-brand">
        Lu<b>men</b>
      </div>
      <div className="tv-status">
        {emu?.profile && <span className="tv-pill">👤 {emu.profile}</span>}
        {emu?.engine === 'ready' && <span className={`tv-pill ${net.cls}`}>{net.text}</span>}
        <span className="tv-clock">{now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </header>
  )
}

const PAD: Partial<Record<Action, [string, string]>> = {
  confirm: ['A', 'a'],
  back: ['B', 'b'],
  x: ['X', 'x'],
  y: ['Y', 'y'],
  lb: ['LB', 'sq'],
  rb: ['RB', 'sq'],
  lt: ['LT', 'sq'],
  rt: ['RT', 'sq'],
  menu: ['Start', 'sq'],
  view: ['View', 'sq'],
  ls: ['L3', 'sq'],
  rs: ['R3', 'sq'],
  left: ['↔', 'sq'],
  up: ['↕', 'sq']
}
const KEYS: Partial<Record<Action, string>> = {
  confirm: 'Enter',
  back: 'Esc',
  x: 'F',
  y: 'S',
  lb: 'Q',
  rb: 'E',
  lt: 'PgUp',
  rt: 'PgDn',
  menu: 'O',
  view: 'V',
  ls: 'Z',
  rs: 'U',
  left: '←→',
  up: '↑↓'
}

/** Button hints in EmuStart's style (coloured A/B/X/Y), from the active input layer. */
function TvHints() {
  const hints = useHints()
  const mode = useStore((s) => s.inputMode)
  if (mode === 'mouse') return <footer className="tv-hints" />
  return (
    <footer className="tv-hints" aria-hidden="true">
      {hints.map((h) => {
        const [label, cls] = PAD[h.action] ?? [h.action, 'sq']
        return (
          <span key={h.action + h.label} className="tv-hint">
            {mode === 'gamepad' ? <span className={`tv-btn tv-btn--${cls}`}>{label}</span> : <span className="tv-btn tv-btn--sq">{KEYS[h.action] ?? label}</span>}
            {h.label}
          </span>
        )
      })}
    </footer>
  )
}

function TvMenu({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const loggedIn = useStore((s) => !!s.snapshot?.emustart?.server)
  const items: [string, () => void][] = [
    ['Ustawienia', onSettings],
    [
      'Zmień profil',
      () => {
        onClose()
        useStore.getState().setProfiles('normal')
      }
    ],
    [
      'Kolejność padów',
      () => {
        onClose()
        useStore.getState().setPads(true)
      }
    ],
    [
      loggedIn ? 'Wyloguj z serwera' : 'Zaloguj do serwera',
      () => {
        onClose()
        void (loggedIn ? logoutFlow() : loginFlow())
      }
    ],
    [
      'Tryb pulpitu  ·  F10 / View+Start',
      () => {
        onClose()
        void api().ui.setMode('desktop')
      }
    ],
    [
      'Odśwież bibliotekę z serwera',
      () => {
        onClose()
        void attempt(api().emustart.refreshLibrary()).then((r) => r && useStore.getState().toast(r.ok ? (r.message ?? 'Odświeżanie biblioteki…') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error'))
      }
    ],
    [
      'Sprawdź aktualizację Lumen',
      () => {
        onClose()
        void attempt(api().update.check()).then((u) => {
          if (!u) return
          const t = useStore.getState().toast
          if (u.phase === 'available' || u.phase === 'ready') t(`Dostępna wersja ${u.info?.version ?? ''} — Ustawienia → Aktualizacja Lumen.`, 'info')
          else if (u.phase === 'none') t('Lumen jest aktualny.', 'info')
          else if (u.phase === 'error') t(u.error ?? 'Nie udało się sprawdzić aktualizacji.', 'error')
        })
      }
    ],
    ['Wyjdź z Lumen', () => void api().app.quit()]
  ]
  const [idx, setIdx] = useState(0)
  useActions(
    {
      up: () => {
        setIdx((i) => (i - 1 + items.length) % items.length)
        return true
      },
      down: () => {
        setIdx((i) => (i + 1) % items.length)
        return true
      },
      left: () => true,
      right: () => true,
      confirm: () => {
        items[idx][1]()
        return true
      },
      back: () => {
        onClose()
        return true
      },
      menu: () => {
        onClose()
        return true
      }
    },
    {
      modal: true,
      hints: [
        { action: 'confirm', label: 'Wybierz' },
        { action: 'back', label: 'Zamknij' }
      ]
    }
  )
  return (
    <div className="tv-modal">
      <div className="tv-panel">
        <h2>Menu</h2>
        <ul className="tv-menulist">
          {items.map(([label, run], i) => (
            <li key={label} className={i === idx ? 'sel' : ''} onMouseEnter={() => setIdx(i)} onClick={run}>
              {label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Lumen's settings (the same screen as on the desktop) inside the TV frame; B returns. */
function TvSettings({ onBack }: { onBack: () => void }) {
  useActions(
    {
      back: () => {
        // inside a section B goes back to the list of sections (the settings screen handles it)
        if (document.activeElement?.closest('.settings__pane')) return false
        onBack()
        return true
      }
    },
    { hints: [{ action: 'back', label: 'Wróć' }] }
  )
  useEffect(() => {
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>('.tv-settings')
      if (el) focusFirst(el)
    }, 50)
    return () => clearTimeout(t)
  }, [])
  return (
    <section className="tv-screen tv-settings">
      <SettingsScreen active />
    </section>
  )
}
