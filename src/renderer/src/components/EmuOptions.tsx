import { useEffect, useState, type ReactNode } from 'react'
import type { EmuEmulatorOption, EmuOptions, EmuOptionsPatch } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { Modal } from './Modal'

// EmuStart's library settings in the desktop interface — the same values as EmuStart's settings
// screen in TV mode (stored by the engine, per profile where EmuStart keeps them per profile).

function Switch({
  label,
  desc,
  value,
  onChange,
  disabled
}: {
  label: string
  desc?: string
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button className="toggle" data-nav role="switch" aria-checked={value} disabled={disabled} onClick={() => onChange(!value)}>
      <span className="toggle__text">
        {label}
        {desc && <small>{desc}</small>}
      </span>
      <span className={`toggle__knob ${value ? 'is-on' : ''}`} />
    </button>
  )
}

function Stepper({
  label,
  value,
  step,
  min,
  max,
  format,
  onChange
}: {
  label: string
  value: number
  step: number
  min: number
  max: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="stepper">
      <span className="stepper__label">{label}</span>
      <button className="btn btn--sm" data-nav disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))} aria-label="Mniej">
        −
      </button>
      <span className="stepper__value">{format(value)}</span>
      <button className="btn btn--sm" data-nav disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))} aria-label="Więcej">
        +
      </button>
    </div>
  )
}

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="opt-group">
    <h3>{title}</h3>
    {children}
  </div>
)

/** `library` — hiding, downloads, TV, profiles; `systems` — the emulator of each system */
export function EmuLibraryOptions({ part }: { part: 'library' | 'systems' }) {
  const ready = useStore((s) => s.snapshot?.emustart.engine === 'ready')
  const [o, setO] = useState<EmuOptions | null>(null)
  const [pick, setPick] = useState<{ es: string; display: string; list: EmuEmulatorOption[] | null } | null>(null)
  // re-read after every library change (a setting changed in the TV interface refreshes the library)
  const emuSnap = useStore((s) => s.snapshot?.emustart)
  useEffect(() => {
    if (ready)
      void api()
        .emustart.options()
        .then(setO)
        .catch(() => setO(null))
  }, [ready, emuSnap])
  if (!ready) return <p className="card__desc">Ustawienia biblioteki EmuStart są dostępne, gdy działa silnik EmuStart.</p>
  if (!o) return <p className="card__desc">Wczytywanie…</p>

  const set = (patch: EmuOptionsPatch): void => {
    void attempt(api().emustart.setOptions(patch)).then((n) => n && setO(n))
  }
  const hide = (k: keyof EmuOptions['hide'], label: string, desc: string) => (
    <Switch label={label} desc={`${o.hide[k] ? 'ukryte' : 'widoczne'} — ${desc}`} value={o.hide[k]} onChange={(v) => set({ hide: { [k]: v } })} />
  )
  const streamOk = o.winfsp === 'dostępny'

  if (part === 'library')
    return (
      <>
        <Group title="Ukrywanie gier · wg oznaczeń w nazwie · osobno dla każdego profilu">
          {hide('beta', 'Wersje rozwojowe', 'Beta, Proto, Alpha, Debug')}
          {hide('demo', 'Dema i wersje promocyjne', 'Demo, Kiosk, Promo, Sample, Trial')}
          {hide('pirate', 'Pirackie i przeróbki', 'Pirate, hack, bootleg')}
          {hide('unl', 'Nielicencjonowane', 'Unl, Aftermarket, Homebrew')}
          {hide('program', 'Programy i BIOS-y', 'Program, BIOS')}
          <Switch
            label="Klony arcade"
            desc={o.arcadeClones ? 'ukryte — tylko wersja główna gry' : 'widoczne — wszystkie wersje setów'}
            value={o.arcadeClones}
            onChange={(v) => set({ arcadeClones: v })}
          />
        </Group>
        <Group title="Pobrane gry i sieć">
          <Stepper
            label="Trzymaj ostatnie gry"
            value={o.cacheRecent}
            step={1}
            min={1}
            max={100}
            format={(v) => `${v} + zachowane`}
            onChange={(v) => set({ cacheRecent: v })}
          />
          <Switch
            label="Graj w trakcie pobierania"
            desc={
              !streamOk
                ? `niedostępne — ${o.winfsp} (https://winfsp.dev)`
                : o.streamPlay
                  ? 'gra startuje od razu, brakujące fragmenty dociągane na bieżąco'
                  : 'najpierw pobranie całej gry'
            }
            value={o.streamPlay && streamOk}
            disabled={!streamOk}
            onChange={(v) => set({ streamPlay: v })}
          />
          {o.streamPlay && streamOk && (
            <Stepper
              label="…gdy pobieranie potrwa dłużej niż"
              value={o.streamMinSeconds}
              step={15}
              min={0}
              max={600}
              format={(v) => (v ? `${v} s` : 'zawsze')}
              onChange={(v) => set({ streamMinSeconds: v })}
            />
          )}
        </Group>
        <Group title="Tryb TV">
          <Switch
            label="Tytuły gier jako logo"
            desc={o.gamesLogo ? 'tak — Clear Logo gry (z LaunchBox, gdy jest) zamiast tytułu' : 'nie — tytuł tekstem'}
            value={o.gamesLogo}
            onChange={(v) => set({ gamesLogo: v })}
          />
        </Group>
        <Group title="Profile">
          {o.profiles.length > 1 && (
            <div className="modal__row">
              <span className="card__desc">Profil tego komputera (dostaje zapisy i konto RA zastane w emulatorach):</span>
              <div className="segmented" role="group" aria-label="Profil tego komputera">
                {o.profiles.map((p) => (
                  <button
                    key={p.id}
                    className={`seg ${o.machineProfile === p.id ? 'is-on' : ''}`}
                    data-nav
                    onClick={() => set({ machineProfile: p.id })}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Switch label="Pytaj, kto gra, przy starcie" value={o.askProfile} onChange={(v) => set({ askProfile: v })} />
          <Switch
            label="Ustawienia emulatorów osobno dla profilu"
            desc="RetroArch, DuckStation, PCSX2 — kopia w profilu na serwerze"
            value={o.profileSettings}
            onChange={(v) => set({ profileSettings: v })}
          />
        </Group>
      </>
    )

  return (
    <>
      <Group title="Emulator na tym komputerze">
        {o.systems.length === 0 && <p className="card__desc">Biblioteka z serwera jest pusta.</p>}
        {o.systems.map((s) => (
          <div key={s.es} className={`sysrow ${s.enabled ? '' : 'is-off'}`}>
            <span className="sysrow__name">
              {s.display} <small>({s.es})</small>
            </span>
            <span className="sysrow__emu">{s.enabled ? s.emulator || 'brak emulatora' : 'wyłączony'}</span>
            <button
              className="btn btn--sm"
              data-nav
              onClick={() => {
                setPick({ es: s.es, display: s.display, list: null })
                void attempt(api().emustart.emulatorOptions(s.es)).then((list) => setPick({ es: s.es, display: s.display, list: list ?? [] }))
              }}
            >
              Emulator…
            </button>
            <button
              className="btn btn--sm"
              data-nav
              onClick={() => void attempt(api().emustart.setSystem(s.es, { enabled: !s.enabled })).then((n) => n && setO(n))}
            >
              {s.enabled ? 'Wyłącz' : 'Włącz'}
            </button>
          </div>
        ))}
      </Group>
      {pick && (
        <Modal title={`Emulator: ${pick.display}`} onClose={() => setPick(null)}>
          {pick.list === null && <p className="card__desc">Szukam emulatorów…</p>}
          {pick.list?.length === 0 && (
            <p className="card__desc">
              Na tym komputerze nie ma emulatora dla tego systemu. Brakujące emulatory instaluje serwer EmuStart (szczegóły gry → „Zainstaluj
              emulator”).
            </p>
          )}
          <div className="picker__list">
            {pick.list?.map((e) => (
              <button
                key={e.exe + e.args}
                className="picker__row"
                data-nav
                onClick={() => {
                  void attempt(api().emustart.setSystem(pick.es, { emulator: e })).then((n) => n && setO(n))
                  setPick(null)
                }}
              >
                <span className="picker__name">{e.label}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}
