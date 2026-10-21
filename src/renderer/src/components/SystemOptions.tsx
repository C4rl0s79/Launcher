import { useEffect, useRef, useState } from 'react'
import type { EmuSystemLogo, EmuSystemOptions } from '@shared/types'
import { api, askText, attempt, useStore } from '../store'
import { focusFirst } from '../nav/engine'
import { Modal } from './Modal'

// Options of one platform (EmuStart: hold A on the system logo; TV layout: X on the carousel):
// emulator of the platform, install it from the server, hide the platform; administrator of the
// server: logo (from the server's sources), its glow and the name — for every device.

type Page = 'main' | 'emus' | 'logo'

export function SystemOptions({ es, onClose }: { es: string; onClose: () => void }) {
  const [d, setD] = useState<EmuSystemOptions | null>(null)
  const [page, setPage] = useState<Page>('main')
  const [logos, setLogos] = useState<EmuSystemLogo[] | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const toast = useStore((s) => s.toast)

  const load = (): void => void api().emustart.account<EmuSystemOptions>('system_options', es).then(setD).catch(() => setD(null))
  useEffect(load, [es]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => listRef.current && focusFirst(listRef.current), 0)
    return () => clearTimeout(t)
  }, [page, !!d, !!logos]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = async (data: Record<string, unknown>, msg?: string): Promise<boolean> => {
    const r = await api()
      .emustart.account<{ ok?: boolean; reason?: string }>('system_set', es, data)
      .catch((e: Error): { ok?: boolean; reason?: string } => ({ ok: false, reason: e.message }))
    if (r.ok === false) toast(r.reason ?? 'Nie udało się.', 'error')
    else if (msg) toast(msg)
    load()
    return r.ok !== false
  }
  const openLogos = (): void => {
    setLogos(null)
    setPage('logo')
    void api()
      .emustart.systemLogos(es)
      .then((l) => setLogos([{ id: 'none', thumb: '', source: 'bez logo', label: 'pokaż nazwę' }, ...l]))
      .catch(() => setLogos([]))
  }

  type Row = { label: string; value?: string; act: () => void }
  const rows: Row[] = !d
    ? []
    : page === 'emus'
      ? d.options.map((o) => ({ label: o.label, value: o.label === d.emulator ? '✓' : '', act: () => void set({ emulator: o }, `${d.display}: ${o.label}`).then(() => setPage('main')) }))
      : [
          ...(d.admin
            ? [
                { label: 'Logo', value: d.logo ? 'zmień (dla wszystkich urządzeń)' : 'brak — wybierz', act: openLogos },
                { label: 'Poświata logo', value: d.glow ? 'tak' : 'nie', act: () => void set({ glow: !d.glow }) },
                {
                  label: 'Nazwa',
                  value: d.display,
                  act: async () => {
                    const v = await askText('Nazwa systemu', { initial: d.display })
                    if (v !== null) await set({ name: v })
                  }
                },
                ...(d.display !== d.default_name ? [{ label: 'Przywróć nazwę', value: d.default_name, act: () => void set({ name: '' }) }] : [])
              ]
            : []),
          {
            label: 'Emulator',
            value: d.emulator || 'brak',
            act: () => (d.options.length ? setPage('emus') : toast('Brak zainstalowanych emulatorów dla tego systemu.'))
          },
          ...(d.install.length
            ? [
                {
                  label: 'Pobierz emulator',
                  value: d.install.map((s) => s.label).join(' + '),
                  act: () => {
                    onClose()
                    void attempt(api().emustart.installEmulators([es])).then((r) => r && toast(r.ok ? (r.message ?? 'Pobieranie emulatora — postęp na liście zadań.') : (r.error ?? 'Nie udało się.'), r.ok ? 'info' : 'error'))
                  }
                }
              ]
            : []),
          { label: 'Ukryj system', value: 'przywrócisz w Ustawieniach → Biblioteka EmuStart', act: () => void set({ enabled: false }, `Ukryto: ${d.display}`).then(onClose) }
        ]

  const back = (): boolean => {
    if (page !== 'main') setPage('main')
    else onClose()
    return true
  }
  const title = d ? `${{ main: 'Opcje systemu', emus: 'Emulator systemu', logo: 'Logo systemu' }[page]} — ${d.display}` : 'Opcje systemu'
  return (
    <Modal title={title} onClose={onClose} wide className="gopt" handlers={{ back }} hints={[{ action: 'confirm', label: 'Wybierz' }, { action: 'back', label: page === 'main' ? 'Zamknij' : 'Wstecz' }]}>
      {!d && <p className="details__loading">Wczytuję…</p>}
      {d && page !== 'logo' && (
        <div className="gopt__list" ref={listRef} key={page}>
          {rows.map((r, i) => (
            <button key={r.label} className="gopt__row" data-nav data-autofocus={i === 0 || undefined} onClick={r.act}>
              <span className="gopt__label">{r.label}</span>
              {r.value && <span className="gopt__value">{r.value}</span>}
            </button>
          ))}
        </div>
      )}
      {d && page === 'logo' && (
        <div ref={listRef}>
          {!logos && <p className="details__loading">Szukam logo na serwerze…</p>}
          {logos && (
            <div className="thumbs thumbs--logo" data-nav-group="sys-logos">
              {logos.map((l, i) => (
                <button
                  key={l.id}
                  className="thumb thumb--fit"
                  data-nav
                  data-autofocus={i === 1 || undefined}
                  title={l.source}
                  onClick={async () => {
                    const r = await api()
                      .emustart.account<{ ok?: boolean; reason?: string }>('system_logo_choose', es, l.id)
                      .catch((e: Error): { ok?: boolean; reason?: string } => ({ ok: false, reason: e.message }))
                    if (r.ok === false) return toast(r.reason ?? 'Nie udało się.', 'error')
                    toast('Logo zapisane na serwerze — dla wszystkich urządzeń.')
                    setPage('main')
                    load()
                  }}
                >
                  {l.thumb ? <img src={l.thumb} alt="" /> : <span className="thumb__tag">{l.label ?? l.source}</span>}
                  <span className="thumb__tag">{l.source}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
