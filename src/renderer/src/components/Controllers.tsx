import { useEffect, useRef, useState } from 'react'
import type { LumenController, LumenControllers, LumenPadProfile, LumenPadProfileState } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { focusEl, focusFirst } from '../nav/engine'
import type { Hint } from '../nav/input'
import { Modal } from './Modal'
import { OnScreenKeyboard } from './TextField'
import {
  addIn,
  devValue,
  effectiveLabel,
  FAMILIES,
  familyNote,
  hideNote,
  hideIn,
  moveIn,
  nextPolicy,
  playerNumbers,
  POLICY,
  scopeWord,
  startProfile
} from '../lib/controllers'

// "Kontrolery" (both layouts): every game controller Lumen sees (also wheels and PS pads, not only
// XInput) under a stable key with an editable label, and controller profiles — per game (from
// "Opcje gry"), per emulator and the default one: player order, devices hidden in that game, what
// happens to devices outside the profile. Every change is saved at once (engine: lumen_pads.py).

type Page = { kind: 'list' } | { kind: 'edit'; key: string }

const call = <T,>(
  m: 'lumen_controllers' | 'lumen_controller_label' | 'lumen_controller_profile' | 'lumen_controller_profile_set' | 'lumen_hide_status' | 'lumen_hide_setup',
  ...a: unknown[]
): Promise<T> => api().emustart.account<T>(m, ...a)

interface Row {
  id: string
  label: string
  value?: string
  act?: () => void
  /** Y on this row */
  y?: () => void
  head?: boolean
}

/** `game.key`: the profile key when known (Steam: steam:<appid>); else from the EmuStart game id */
export function Controllers({ game, onClose }: { game?: { id: string; name: string; key?: string }; onClose: () => void }) {
  const [page, setPage] = useState<Page | null>(game ? null : { kind: 'list' })
  const [list, setList] = useState<LumenControllers | null>(null)
  const [st, setSt] = useState<LumenPadProfileState | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [rename, setRename] = useState<LumenController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const focused = useRef<string>('')
  const focusedAt = useRef(0)
  /** row to focus after the next change (the device moves to another section) */
  const follow = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const toast = useStore((s) => s.toast)
  /** hiding by disabling devices in Windows (one-time administrator setup: lumen_hide.py) */
  const [winHide, setWinHide] = useState<{ ready: boolean; reason: string; busy?: boolean } | null>(null)
  useEffect(() => {
    void call<{ ready: boolean; reason: string }>('lumen_hide_status').then(setWinHide, () => setWinHide(null))
  }, [])
  const setupHide = async (): Promise<void> => {
    setWinHide((h) => ({ ready: false, reason: h?.reason ?? '', busy: true }))
    toast('Windows zapyta o zgodę administratora — potwierdź, żeby Lumen mógł ukrywać kontrolery.')
    const r = await attempt(call<{ ok: boolean; reason: string }>('lumen_hide_setup'))
    const s = await call<{ ready: boolean; reason: string }>('lumen_hide_status').catch(() => null)
    setWinHide(s)
    if (r) toast(r.ok ? 'Ukrywanie kontrolerów gotowe.' : r.reason || 'Nie skonfigurowano.', r.ok ? 'info' : 'error')
  }

  // from "Opcje gry": straight to the game's profile (the version that plays)
  useEffect(() => {
    if (!game) return
    if (game.key) return setPage({ kind: 'edit', key: game.key })
    void api()
      .emustart.controllerKey(game.id)
      .then((key) => setPage({ kind: 'edit', key }))
      .catch((e: Error) => setError(e.message || 'Nie udało się odczytać gry.'))
  }, [game?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const editKey = page?.kind === 'edit' ? page.key : null
  useEffect(() => {
    setConfirm(false)
    setMoving(null)
    if (!page) return
    if (page.kind === 'list') void call<LumenControllers>('lumen_controllers').then(setList, (e: Error) => setError(e.message))
    else {
      setSt(null)
      void call<LumenPadProfileState>('lumen_controller_profile', page.key).then(setSt, (e: Error) => setError(e.message))
    }
  }, [page?.kind, editKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // controllers plugged in / out while the screen is open
  useEffect(() => {
    const t = setInterval(async () => {
      const c = await call<LumenControllers>('lumen_controllers').catch(() => null)
      if (!c) return
      setList(c)
      setSt((s) => (s ? { ...s, devices: c.devices, missing: c.missing } : s))
    }, 3000)
    return () => clearInterval(t)
  }, [])

  const ready = page?.kind === 'list' ? !!list : !!st
  useEffect(() => {
    const t = setTimeout(() => listRef.current && focusFirst(listRef.current), 0)
    return () => clearTimeout(t)
  }, [page?.kind, editKey, ready, !!st?.profile]) // eslint-disable-line react-hooks/exhaustive-deps

  // the focus follows the device (moved, hidden, added); a row that is gone → the row in its place
  useEffect(() => {
    const box = listRef.current
    if (!box || rename) return
    const want = moving ? `o:${moving}` : follow.current
    const el = want && box.querySelector<HTMLElement>(`[data-row="${CSS.escape(want)}"]`)
    if (el) {
      follow.current = null
      if (document.activeElement !== el) focusEl(el, false)
    } else if (!box.contains(document.activeElement) && focused.current) {
      const all = [...box.querySelectorAll<HTMLElement>('[data-nav]')]
      const near = all[Math.min(focusedAt.current, all.length - 1)]
      if (near) focusEl(near, false)
    }
  })

  const save = async (p: LumenPadProfile | null): Promise<void> => {
    if (!st) return
    setSt({ ...st, profile: p }) // at once on the screen; the engine's answer replaces it
    const r = await attempt(call<LumenPadProfileState>('lumen_controller_profile_set', st.key, p))
    if (!r) return
    if (r.ok === false) return void toast(r.reason ?? 'Nie udało się zapisać profilu.', 'error')
    setSt(r)
  }

  const devs = new Map<string, LumenController & { on: boolean }>()
  for (const d of (st ?? list)?.missing ?? []) devs.set(d.key, { ...d, on: false })
  for (const d of (st ?? list)?.devices ?? []) devs.set(d.key, { ...d, on: true })
  const nameOf = (k: string): string => devs.get(k)?.label || devs.get(k)?.name || 'Nieznane urządzenie'

  const rows = ((): Row[] => {
    if (page?.kind === 'list') {
      if (!list) return []
      const out: Row[] = [{ id: 'h:dev', label: 'Podłączone — A: zmień nazwę', head: true }]
      for (const d of list.devices)
        out.push({
          id: d.key,
          label: d.label || d.name || 'Kontroler',
          value: devValue(d, d.key),
          act: () => setRename(d)
        })
      if (!list.devices.length) out.push({ id: 'none', label: 'Brak podłączonych kontrolerów' })
      if (list.missing.length) {
        out.push({
          id: 'h:miss',
          label: 'Znane, teraz niepodłączone',
          head: true
        })
        for (const d of list.missing)
          out.push({
            id: d.key,
            label: d.label || 'Kontroler',
            value: `${d.bus_label ? d.bus_label + ' · ' : ''}${d.short}`,
            act: () => setRename(d)
          })
      }
      out.push({ id: 'h:prof', label: 'Profile kontrolerów', head: true })
      const has = (k: string): string => (list.profiles.includes(k) ? 'własny profil' : 'brak')
      out.push({
        id: 'p:default',
        label: 'Domyślny — wszystkie gry',
        value: has('default'),
        act: () => setPage({ kind: 'edit', key: 'default' })
      })
      for (const [f, label] of FAMILIES)
        out.push({
          id: `p:${f}`,
          label,
          value: has(`emu:${f}`),
          act: () => setPage({ kind: 'edit', key: `emu:${f}` })
        })
      out.push({ id: 'h:hide', label: 'Ukrywanie w Windows', head: true })
      out.push({
        id: 'hide',
        label: winHide?.ready ? 'Gotowe' : winHide?.busy ? 'Czekam na zgodę administratora…' : 'Skonfiguruj (jedno pytanie administratora)',
        value: winHide?.ready
          ? 'ukryte kontrolery są wyłączane na czas gry, także w grach Steam'
          : 'bez tego ukryte kontrolery widzą gry Steam i programy bez SDL',
        act: winHide?.ready || winHide?.busy ? undefined : () => void setupHide()
      })
      const games = list.profiles.filter((k) => k.startsWith('game:') || k.startsWith('steam:')).length
      out.push({
        id: 'p:games',
        label: 'Profile gier',
        value: games ? `${games} · zmienisz je w Opcjach gry` : 'ustawisz w Opcjach gry → Kontrolery'
      })
      return out
    }
    if (!st) return []
    const out: Row[] = [{ id: 'eff', label: 'Obowiązuje', value: effectiveLabel(st) }]
    const p = st.profile
    if (!p) {
      out.push({
        id: 'create',
        label: 'Utwórz profil',
        value: st.effective_profile ? 'na podstawie obowiązującego' : 'z podłączonych kontrolerów',
        act: () => void save(startProfile(st))
      })
      return out
    }
    const hide = (k: string): void => ((follow.current = `u:${k}`), void save(hideIn(p, k)))
    const add = (k: string): void => ((follow.current = `o:${k}`), void save(addIn(p, k)))
    out.push({
      id: 'h:order',
      label: moving ? 'Przenoszenie: ▲▼ — miejsce, A / B — gotowe' : 'Kolejność graczy — A: przenieś, Y: ukryj',
      head: true
    })
    const nums = playerNumbers(p.order, new Set([...devs.values()].filter((d) => d.on).map((d) => d.key)))
    p.order.forEach((k, i) => {
      const on = nums[i] > 0
      out.push({
        id: `o:${k}`,
        label: `${on ? `Gracz ${nums[i]}` : 'pominięty'} · ${nameOf(k)}`,
        value: moving === k ? '▲▼' : devValue(devs.get(k), k) + (on ? '' : ' · niepodłączony'),
        act: () => setMoving(k),
        y: () => hide(k)
      })
    })
    if (!p.order.length)
      out.push({
        id: 'o:none',
        label: 'Nikt — dodaj albo przywróć kontroler poniżej'
      })
    const outside = [...devs.values()].filter((d) => d.on && !p.order.includes(d.key) && !p.hidden.includes(d.key))
    if (outside.length) {
      out.push({
        id: 'h:out',
        label: 'Spoza profilu — A: dodaj jako kolejnego gracza, Y: ukryj',
        head: true
      })
      for (const d of outside)
        out.push({
          id: `x:${d.key}`,
          label: nameOf(d.key),
          value: devValue(d, d.key),
          act: () => add(d.key),
          y: () => hide(d.key)
        })
    }
    if (p.hidden.length) {
      out.push({
        id: 'h:hid',
        label: `Ukryte ${scopeWord(st.key)} — A: przywróć`,
        head: true
      })
      for (const k of p.hidden)
        out.push({
          id: `u:${k}`,
          label: nameOf(k),
          value: devValue(devs.get(k), k) + (devs.get(k)?.on ? '' : ' · niepodłączony'),
          act: () => add(k)
        })
    }
    out.push({ id: 'h:opt', label: 'Ustawienia profilu', head: true })
    out.push({
      id: 'policy',
      label: 'Kontrolery spoza profilu',
      value: POLICY.find(([v]) => v === p.unknown)?.[1],
      act: () => void save({ ...p, unknown: nextPolicy(p.unknown) })
    })
    out.push({
      id: 'reset',
      label: confirm ? 'Na pewno usunąć ten profil? A — tak' : 'Resetuj profil',
      value: confirm
        ? 'B — nie'
        : st.key === 'default'
          ? 'wraca kolejność padów EmuStart'
          : st.key.startsWith('emu:')
            ? 'obowiąże profil domyślny albo kolejność padów EmuStart'
            : 'obowiąże profil emulatora albo domyślny',
      act: () => {
        if (!confirm) return setConfirm(true)
        setConfirm(false)
        void save(null)
      }
    })
    return out
  })()

  const move = (d: -1 | 1): boolean => {
    if (st?.profile && moving) setSt({ ...st, profile: moveIn(st.profile, moving, d) })
    return true
  }
  const endMove = (): boolean => {
    setMoving(null)
    if (st?.profile) void save(st.profile)
    return true
  }
  const back = (): boolean => {
    if (moving) return endMove()
    if (confirm) setConfirm(false)
    else if (page?.kind === 'edit' && !game) setPage({ kind: 'list' })
    else onClose()
    return true
  }

  const title =
    page?.kind === 'edit'
      ? `Kontrolery — ${st?.key.startsWith('game:') && game ? game.name : st?.key === 'default' ? 'profil domyślny' : st?.family_label || 'profil'}`
      : 'Kontrolery'
  const hints: Hint[] = moving
    ? [
        { action: 'up', label: 'W górę' },
        { action: 'down', label: 'W dół' },
        { action: 'confirm', label: 'Gotowe' }
      ]
    : [
        { action: 'confirm', label: 'Wybierz' },
        ...(page?.kind === 'edit' && st?.profile ? [{ action: 'y' as const, label: 'Ukryj' }] : []),
        {
          action: 'back',
          label: page?.kind === 'edit' && !game ? 'Wstecz' : 'Zamknij'
        }
      ]

  return (
    <>
      <Modal
        title={title}
        onClose={onClose}
        wide
        className="gopt"
        handlers={
          moving
            ? {
                up: () => move(-1),
                down: () => move(1),
                confirm: endMove,
                back,
                left: () => true,
                right: () => true
              }
            : {
                back,
                y: () => (rows.find((r) => r.id === focused.current)?.y?.(), true)
              }
        }
        hints={hints}
      >
        {error && <p className="details__muted">{error}</p>}
        {!error && !ready && <p className="details__loading">Odczytuję kontrolery…</p>}
        {ready && (
          <div className="gopt__list" ref={listRef} key={page?.kind + (editKey ?? '')}>
            {rows.map((r, i) =>
              r.head ? (
                <h3 key={r.id} className="saves__h">
                  {r.label}
                </h3>
              ) : (
                <button
                  key={r.id}
                  data-row={r.id}
                  className={`gopt__row${r.act ? '' : ' gopt__row--static'}`}
                  data-nav={r.act ? true : undefined}
                  data-autofocus={(i <= 1 && !!r.act) || undefined}
                  onFocus={(e) => {
                    focused.current = r.id
                    focusedAt.current = [...(listRef.current?.querySelectorAll('[data-nav]') ?? [])].indexOf(e.currentTarget)
                  }}
                  onClick={r.act}
                >
                  <span className="gopt__label">{r.label}</span>
                  {r.value && <span className="gopt__value">{r.value}</span>}
                </button>
              )
            )}
          </div>
        )}
        {page?.kind === 'edit' && st && <p className="details__muted">{familyNote(st)}</p>}
        {page?.kind === 'edit' && st?.profile && (st.profile.hidden.length > 0 || st.profile.unknown === 'hide') && (
          <p className="details__muted">{hideNote(!!winHide?.ready)}</p>
        )}
      </Modal>
      {rename && (
        <OnScreenKeyboard
          label={`Nazwa kontrolera (${rename.short})`}
          initial={rename.label}
          secret={false}
          onChange={() => undefined}
          onClose={(submit, v) => {
            const d = rename
            setRename(null)
            if (submit && v.trim())
              void attempt(call<LumenControllers>('lumen_controller_label', d.key, v)).then((c) => {
                if (c) setList(c)
              })
          }}
        />
      )}
    </>
  )
}
