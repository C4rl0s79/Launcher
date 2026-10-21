import { useEffect, useRef } from 'react'
import { api, useStore } from '../store'
import { focusFirst } from '../nav/engine'
import { Modal } from './Modal'
import { OnScreenKeyboard } from './TextField'

// Dialogs shared by both layouts: text from the on-screen keyboard (askText), a choice from a list
// (askChoice), and the login waiting for approval (code). Flows in lib/account.ts build on them.

export function Dialogs() {
  const d = useStore((s) => s.dialog)
  const close = (): void => useStore.setState({ dialog: null })
  return (
    <>
      {d?.kind === 'text' && (
        <OnScreenKeyboard
          key={d.id}
          label={d.label}
          initial={d.initial}
          secret={d.secret}
          onChange={() => undefined}
          onClose={(submit, v) => {
            close()
            d.resolve(submit ? v : null)
          }}
        />
      )}
      {d?.kind === 'choice' && (
        <Modal
          key={d.id}
          title={d.title}
          onClose={() => {
            close()
            d.resolve(null)
          }}
          wide
          className="gopt"
        >
          <div className="gopt__list">
            {d.items.map((label, i) => (
              <button
                key={label + i}
                className="gopt__row"
                data-nav
                data-autofocus={i === 0 || undefined}
                onClick={() => {
                  close()
                  d.resolve(i)
                }}
              >
                <span className="gopt__label">{label}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      <EnrollWait />
    </>
  )
}

/** Login request waiting for approval (another device of the account, or the administrator). */
function EnrollWait() {
  const e = useStore((s) => s.enroll)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!e) return
    let stop = false
    const tick = async (): Promise<void> => {
      const p = await api()
        .emustart.account<{ status?: string; account?: string }>('server_enroll_poll')
        .catch(() => null)
      if (stop || !p) return
      const st = useStore.getState()
      if (p.status === 'approved') {
        st.setEnroll(null)
        st.toast(`Zalogowano — konto „${p.account ?? e.account}” na tym urządzeniu.`, 'info')
        st.setProfiles('setup')
      } else if (p.status === 'denied') {
        st.setEnroll(null)
        st.toast('Prośba o zalogowanie została odrzucona.', 'error')
      } else if (p.status === 'expired' || p.status === 'none') {
        st.setEnroll(null)
        st.toast('Prośba wygasła — wyślij ją ponownie.', 'error')
      }
    }
    const t = setInterval(() => void tick(), 4000)
    void tick()
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [e])
  useEffect(() => {
    if (e && ref.current) focusFirst(ref.current)
  }, [e])
  if (!e) return null
  const cancel = (): boolean => {
    void api().emustart.account('server_enroll_cancel')
    useStore.getState().setEnroll(null)
    useStore.getState().toast('Prośba wycofana.', 'info')
    return true
  }
  return (
    <Modal
      title={e.mode === 'new' ? `Nowe konto „${e.account}”` : `Konto „${e.account}” — nowe urządzenie`}
      onClose={() => useStore.getState().setEnroll(null)}
      className="gopt"
      handlers={{ x: cancel }}
      hints={[
        { action: 'x', label: 'Wycofaj prośbę' },
        { action: 'back', label: 'Zamknij (prośba czeka)' }
      ]}
    >
      <div ref={ref}>
        <p className="details__muted">
          {e.mode === 'new'
            ? 'Czeka na zatwierdzenie przez administratora serwera (aplikacja EmuStart, Lumen albo panel serwera). Sprawdź, czy kod się zgadza.'
            : 'Zatwierdź na innym urządzeniu tego konta (albo administrator). Sprawdź, czy kod się zgadza.'}
        </p>
        <p className="enroll__code">{e.code}</p>
        <p className="details__muted">Możesz zamknąć to okno albo program — prośba czeka do 24 godzin.</p>
        <button className="btn" data-nav data-autofocus onClick={() => useStore.getState().setEnroll(null)}>
          Zamknij
        </button>
      </div>
    </Modal>
  )
}
