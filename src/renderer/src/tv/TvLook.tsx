import { useEffect, useRef, useState } from 'react'
import { api, attempt, useStore } from '../store'
import { useActions } from '../nav/input'
import {
  LOOK_SPEC,
  choiceValue,
  getLook,
  isChoice,
  isSetting,
  lookFromEngine,
  lookToSave,
  rangeValue,
  setLook,
  stepLook,
  useLook,
  type LookItem,
  type LookValues
} from './look'

// The look editor of the TV layout (EmuStart's look.js in React): a side panel over the live layout,
// every change shows at once; B saves to EmuStart's config ("look", with the profile unless the look is
// kept for this computer), so EmuStart and Lumen share one look.

type Settings = { gamesLogo: boolean; lookScope: 'profile' | 'machine' }
type EngineState = { look?: unknown; look_scope?: string; games_logo?: boolean }

const firstItem = LOOK_SPEC.findIndex((r) => 'k' in r)

/** Loads the stored look when the engine is ready and again after a profile change (look per profile). */
export function useLookSync(): void {
  const ready = useStore((s) => s.snapshot?.emustart?.engine === 'ready')
  const profile = useStore((s) => s.snapshot?.emustart?.profile)
  useEffect(() => {
    if (!ready) return
    let alive = true
    void api()
      .emustart.account('get_state')
      .then((r) => alive && setLook(lookFromEngine((r as EngineState | null)?.look)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ready, profile])
}

export function TvLook({ onClose, onPreview, previewLabel }: { onClose: () => void; onPreview: () => void; previewLabel: string }) {
  const values = useLook()
  const [idx, setIdx] = useState(firstItem)
  const [left, setLeft] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const saved = useRef(JSON.stringify(lookToSave(getLook())))
  const armed = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const toast = useStore((s) => s.toast)

  useEffect(() => {
    void api()
      .emustart.account('get_state')
      .then((r) => {
        const st = r as EngineState | null
        setSettings({ gamesLogo: !!st?.games_logo, lookScope: st?.look_scope === 'machine' ? 'machine' : 'profile' })
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    listRef.current?.querySelector('.tv-lkrow.sel')?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const item = (): LookItem | undefined => {
    const r = LOOK_SPEC[idx]
    return r && 'k' in r ? r : undefined
  }
  const move = (dir: number): void => {
    let i = idx
    do i = (i + dir + LOOK_SPEC.length) % LOOK_SPEC.length
    while (!('k' in LOOK_SPEC[i]))
    setIdx(i)
  }
  const step = (it: LookItem | undefined, dir: number, times = 1): void => {
    if (!it) return
    if (isSetting(it)) {
      if (!settings) return
      const patch: Partial<Settings> = it.setting === 'gamesLogo' ? { gamesLogo: !settings.gamesLogo } : { lookScope: settings.lookScope === 'profile' ? 'machine' : 'profile' }
      setSettings({ ...settings, ...patch })
      void attempt(api().emustart.setOptions(patch))
      return
    }
    let v: LookValues = getLook()
    for (let i = 0; i < (isChoice(it) ? 1 : times); i++) v = stepLook(v, it, dir)
    setLook(v)
  }
  const reset = (it: LookItem | undefined): void => {
    if (!it || isSetting(it)) return
    const v = { ...getLook() }
    delete v[it.k]
    setLook(v)
  }
  const close = async (): Promise<void> => {
    onClose()
    const data = lookToSave(getLook())
    if (JSON.stringify(data) === saved.current) return
    const r = await attempt(api().emustart.account('look_save', data))
    toast((r as { ok?: boolean } | null)?.ok ? 'Zapisano wygląd.' : 'Nie udało się zapisać wyglądu.', (r as { ok?: boolean } | null)?.ok ? 'info' : 'error')
  }

  useActions(
    {
      up: () => (move(-1), true),
      down: () => (move(1), true),
      left: () => (step(item(), -1), true),
      right: () => (step(item(), 1), true),
      lb: () => (step(item(), -1, 5), true),
      rb: () => (step(item(), 1, 5), true),
      x: () => (reset(item()), true),
      y: () => (setLeft((l) => !l), true),
      confirm: () => (onPreview(), true),
      menu: () => {
        if (performance.now() - armed.current > 2500) {
          armed.current = performance.now()
          toast('Wciśnij Start jeszcze raz, żeby przywrócić wszystko.')
          return true
        }
        armed.current = 0
        setLook({})
        toast('Przywrócono domyślny wygląd.')
        return true
      },
      back: () => (void close(), true),
      view: () => true
    },
    {
      modal: true,
      hints: [
        { action: 'left', label: 'Zmień' },
        { action: 'lb', label: '×5' },
        { action: 'confirm', label: `Podgląd: ${previewLabel}` },
        { action: 'y', label: 'Przesuń okno' },
        { action: 'x', label: 'Domyślna' },
        { action: 'menu', label: 'Wszystko domyślne' },
        { action: 'back', label: 'Zapisz' }
      ]
    }
  )

  return (
    <div className={`tv-look ${left ? 'left' : ''}`}>
      <h2>Wygląd</h2>
      <div className="tv-look__list" ref={listRef}>
        {LOOK_SPEC.map((r, i) => {
          if (!('k' in r))
            return (
              <div key={r.head} className="tv-lkrow head">
                {r.head}
              </div>
            )
          const sel = i === idx
          const pick = (dir: number) => (e: React.MouseEvent) => {
            e.stopPropagation()
            setIdx(i)
            step(r, dir)
          }
          let val: React.ReactNode
          let chg = false
          if (isSetting(r)) {
            const text = !settings ? '…' : r.setting === 'gamesLogo' ? (settings.gamesLogo ? 'tak' : 'nie') : settings.lookScope === 'machine' ? 'dla tego komputera' : 'dla profilu (na każdym komputerze)'
            val = (
              <>
                <span className="ch" onClick={pick(-1)}>
                  ◀
                </span>
                <b>{text}</b>
                <span className="ch" onClick={pick(1)}>
                  ▶
                </span>
              </>
            )
          } else if (isChoice(r)) {
            const v = choiceValue(values, r)
            chg = v !== r.def
            val = (
              <>
                <span className="ch" onClick={pick(-1)}>
                  ◀
                </span>
                {r.swatch && <span className="sw" style={{ background: v }} />}
                <b>{r.fmt(v)}</b>
                <span className="ch" onClick={pick(1)}>
                  ▶
                </span>
              </>
            )
          } else {
            const v = rangeValue(values, r)
            chg = v !== r.def
            val = (
              <>
                <span className="ch" onClick={pick(-1)}>
                  −
                </span>
                <span className="track">
                  <i style={{ width: `${((100 * (v - r.min)) / (r.max - r.min)).toFixed(1)}%` }} />
                </span>
                <span className="ch" onClick={pick(1)}>
                  +
                </span>
                <b>{r.fmt(v)}</b>
              </>
            )
          }
          return (
            <div
              key={r.k}
              className={`tv-lkrow ${sel ? 'sel' : ''} ${chg ? 'chg' : ''}`}
              onClick={() => setIdx(i)}
              onWheel={(e) => {
                setIdx(i)
                step(r, e.deltaY < 0 ? 1 : -1)
              }}
            >
              <span className="lk">{r.t}</span>
              <span className="lv">{val}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
