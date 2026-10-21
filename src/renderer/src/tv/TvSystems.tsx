import { useEffect, useState } from 'react'
import type { EmuSystemInfo } from '@shared/types'
import { api } from '../store'
import { useActions } from '../nav/input'
import { STEAM, systemMeta, type TvSystem } from './data'
import { SystemOptions } from '../components/SystemOptions'

// System carousel (EmuStart look): the selected platform's logo in the middle, neighbours smaller
// and dimmed, the carousel wraps around; below — name, counts and the platform description.

const GAP_VW = 25
const info: Record<string, EmuSystemInfo> = {}

const STEAM_INFO: EmuSystemInfo = {
  manufacturer: 'Valve',
  description: 'Gry z biblioteki Steam. Instalacją, aktualizacjami, uruchamianiem i synchronizacją zapisów (Steam Cloud) zarządza klient Steam.'
}

function useSystemInfo(sys: TvSystem | undefined): EmuSystemInfo | null {
  const [d, setD] = useState<EmuSystemInfo | null>(null)
  useEffect(() => {
    if (!sys) return setD(null)
    if (sys.key === STEAM) return setD(STEAM_INFO)
    if (info[sys.key]) return setD(info[sys.key])
    setD(null)
    let alive = true
    let tries = 0
    let timer: ReturnType<typeof setTimeout>
    const load = async (): Promise<void> => {
      const r = await api()
        .emustart.systemInfo(sys.key)
        .catch(() => null)
      if (!alive || !r) return
      if (r.pending) {
        if (++tries < 40) timer = setTimeout(() => void load(), 1500)
        return
      }
      info[sys.key] = r
      setD(r)
    }
    timer = setTimeout(() => void load(), 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [sys])
  return d
}

function SysCard({ sys, d }: { sys: TvSystem; d: number }) {
  const [broken, setBroken] = useState(false)
  const ad = Math.abs(d)
  return (
    <div
      className="tv-syscard"
      style={{
        transform: `translate(calc(-50% + ${d * GAP_VW}vw), -50%) scale(${ad === 0 ? 1 : 0.55})`,
        opacity: ad === 0 ? 1 : ad <= 2 ? 0.45 : 0,
        filter: ad === 0 ? 'none' : 'grayscale(.6)',
        zIndex: 10 - ad
      }}
    >
      {sys.logo && !broken ? (
        <img src={api().art.url(`emusys:${sys.key}`, 'logo')} alt="" onError={() => setBroken(true)} draggable={false} />
      ) : (
        <div className="txt">{sys.display}</div>
      )}
    </div>
  )
}

export function TvSystems({
  systems,
  index,
  onIndex,
  onOpen,
  onMenu,
  active
}: {
  systems: TvSystem[]
  index: number
  onIndex: (i: number) => void
  onOpen: () => void
  onMenu: () => void
  active: boolean
}) {
  const n = systems.length
  const sys = systems[index]
  const d = useSystemInfo(sys)
  const [opts, setOpts] = useState(false)
  useActions(
    {
      left: () => {
        if (n) onIndex((index - 1 + n) % n)
        return true
      },
      right: () => {
        if (n) onIndex((index + 1) % n)
        return true
      },
      up: () => true,
      down: () => true,
      confirm: () => {
        if (n) onOpen()
        return true
      },
      menu: () => {
        onMenu()
        return true
      },
      x: () => {
        if (sys && sys.key !== STEAM) setOpts(true)
        return true
      },
      back: () => true
    },
    {
      enabled: active && !opts,
      hints: n
        ? [
            { action: 'left', label: 'System' },
            { action: 'confirm', label: 'Wybierz' },
            ...(sys && sys.key !== STEAM ? [{ action: 'x' as const, label: 'Opcje systemu' }] : []),
            { action: 'menu', label: 'Menu' }
          ]
        : [{ action: 'menu', label: 'Menu' }]
    }
  )

  if (!n)
    return (
      <section className="tv-screen">
        <div className="tv-empty">
          <h2>Brak gier w bibliotece</h2>
          <p>Zaloguj to urządzenie do serwera EmuStart albo uruchom Steam — Start → Ustawienia.</p>
        </div>
      </section>
    )

  const facts = d ? [d.manufacturer, d.release ? (d.end ? `${d.release}–${d.end}` : `premiera ${d.release}`) : '', d.media, d.controllers ? `pady: ${d.controllers}` : ''].filter(Boolean) : []
  return (
    <section className="tv-screen tv-systems">
      <div className="tv-carousel">
        {systems.map((s, i) => {
          let dd = i - index
          if (dd > n / 2) dd -= n // the carousel is a loop
          if (dd < -n / 2) dd += n
          if (Math.abs(dd) > 3) return null
          return (
            <div key={s.key} onClick={() => (i === index ? onOpen() : onIndex(i))}>
              <SysCard sys={s} d={dd} />
            </div>
          )
        })}
      </div>
      {opts && sys && <SystemOptions es={sys.key} onClose={() => setOpts(false)} />}
      <div className="tv-sysinfo">
        <h1>{sys.display}</h1>
        <p>{systemMeta(sys)}</p>
        {(facts.length > 0 || d?.description) && (
          <div className="tv-sysabout">
            {facts.length > 0 && (
              <p className="tv-sysfacts">
                {facts.map((f, i) => (i === 0 && d?.manufacturer ? <b key={i}>{f}</b> : <span key={i}>{(i ? '  ·  ' : '') + f}</span>))}
              </p>
            )}
            {d?.description && <p className="tv-sysdesc">{d.description}</p>}
          </div>
        )}
      </div>
    </section>
  )
}
