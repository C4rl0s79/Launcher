import { api, useStore } from '../store'

/** State of the EmuStart side shown above a platform group — only when something needs attention. */
export function EmuNotice() {
  const emu = useStore((s) => s.snapshot?.emustart)
  if (!emu) return null
  if (emu.engine !== 'ready') {
    return (
      <div className="notice notice--warn">
        <span>
          <strong>{emu.engine === 'starting' ? 'Uruchamianie silnika EmuStart…' : 'Silnik EmuStart nie działa.'}</strong>{' '}
          {emu.message}
          {emu.fromCache && ' Lista gier pochodzi z ostatniej zapisanej kopii — gry nie dadzą się teraz uruchomić.'}
        </span>
      </div>
    )
  }
  if (!emu.server) {
    return (
      <div className="notice">
        <span>To urządzenie nie jest zalogowane do serwera EmuStart.</span>
        <button className="btn btn--sm" tabIndex={-1} onClick={() => void api().ui.setMode('fullscreen', 'settings')}>
          Zaloguj (tryb TV)
        </button>
      </div>
    )
  }
  if (!emu.server.ok && !emu.server.checking) {
    return (
      <div className="notice notice--warn">
        <span>
          <strong>Serwer EmuStart nie odpowiada.</strong> Pobrane gry (oznaczone jako „na dysku”) działają bez niego; pozostałe pobiorą się, gdy
          serwer wróci.{emu.server.reason ? ` ${emu.server.reason}` : ''}
        </span>
      </div>
    )
  }
  return null
}
