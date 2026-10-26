import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EmuProfile } from '@shared/types'
import { api, askText, useStore } from '../store'
import { useActions } from '../nav/input'
import { HintsBar } from './Hints'
import { accessFlow, createProfile, joinExisting, profileMenu, renameProfile } from '../lib/account'

// "Kto gra?" — EmuStart's profiles screen for both layouts: the player of this PC (setup), the
// question at start, or "Zmień profil" from a menu. Profiles, PINs, account passwords and
// RetroAchievements are EmuStart's (engine); this is only the interface.

interface State {
  profiles: EmuProfile[]
  current: number
  /** this device is bound to an account (device key): new profiles = other users' accounts */
  account: string
  server: boolean
  rejected: boolean
}

async function load(): Promise<State> {
  const [l, st] = await Promise.all([
    api().emustart.account<{ profiles?: EmuProfile[]; current?: number }>('profiles_list'),
    api().emustart.account<{ account?: string; server?: { key_rejected?: boolean } | null }>('get_state')
  ])
  return { profiles: l.profiles ?? [], current: l.current ?? 0, account: st.account ?? '', server: !!st.server, rejected: !!st.server?.key_rejected }
}

export function Profiles() {
  const mode = useStore((s) => s.profiles)
  // mounted only while open: its input layer is then on top of the screens below
  return mode ? <ProfilesScreen mode={mode} /> : null
}

function ProfilesScreen({ mode }: { mode: 'normal' | 'startup' | 'setup' }) {
  const [st, setSt] = useState<State | null>(null)
  const [idx, setIdx] = useState(0)
  const [ask, setAsk] = useState(true)
  const [delArmed, setDelArmed] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const close = (): void => useStore.getState().setProfiles(null)
  const toast = useStore((s) => s.toast)
  const dialog = useStore((s) => s.dialog)
  const tv = useStore((s) => s.uiMode === 'fullscreen')

  const reload = async (keep?: number): Promise<void> => {
    const s = await load().catch(() => null)
    if (!s) return
    setSt(s)
    const i = s.profiles.findIndex((p) => p.id === (keep ?? s.current))
    setIdx(i >= 0 ? i : 0)
  }
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const setup = mode === 'setup'
  const n = (st?.profiles.length ?? 0) + 1
  const p = st?.profiles[idx]
  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const choose = (): void =>
    void run(async () => {
      if (!st) return
      if (!p) {
        // the "+" card: a new profile, or (device bound to an account) another user's account
        if (st.account) {
          const name = (await askText('Nazwa konta innego użytkownika'))?.trim()
          if (name) await joinExisting(name, true)
        } else await createProfile()
        return reload()
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await api().emustart.account<{ ok?: boolean; need?: string; reason?: string }>(setup ? 'profile_setup' : 'profile_select', ...(setup ? [p.id, ask] : [p.id]))
        if (r?.need) {
          if (!(await accessFlow(p, r.need))) return
          continue
        }
        if (r?.ok === false) return toast(r.reason ?? 'Nie udało się wybrać profilu.', 'error')
        toast(setup ? `Ten komputer: ${p.name}` : `Gra: ${p.name}`)
        return close()
      }
    })

  useActions(
    {
      left: () => (setIdx((i) => (i - 1 + n) % n), setDelArmed(null), true),
      up: () => (setIdx((i) => (i - 1 + n) % n), setDelArmed(null), true),
      right: () => (setIdx((i) => (i + 1) % n), setDelArmed(null), true),
      down: () => (setIdx((i) => (i + 1) % n), setDelArmed(null), true),
      confirm: () => (choose(), true),
      menu: () => {
        if (p && st && !setup) void run(() => profileMenu(p, { server: st.server, account: st.account }).then(() => reload(p.id)))
        return true
      },
      y: () => {
        if (setup) setAsk((a) => !a)
        else if (p && !st?.account) void run(() => renameProfile(p).then(() => reload(p.id)))
        return true
      },
      x: () => {
        if (!p || setup || st?.account) return true
        if (delArmed !== p.id) {
          setDelArmed(p.id)
          toast(`Naciśnij X ponownie, aby usunąć profil „${p.name}”. Zapisy zostaną na dysku.`)
          return true
        }
        setDelArmed(null)
        void run(async () => {
          const r = await api().emustart.account<{ ok?: boolean; reason?: string }>('profile_delete', p.id)
          if (r?.ok === false) toast(r.reason ?? 'Nie udało się.', 'error')
          await reload()
        })
        return true
      },
      back: () => {
        if (!setup) close()
        return true
      },
      lb: () => true,
      rb: () => true,
      lt: () => true,
      rt: () => true,
      view: () => true
    },
    {
      enabled: !dialog,
      modal: true,
      hints: !st
        ? []
        : st.account
          ? p
            ? [
                { action: 'confirm', label: 'Graj jako' },
                { action: 'menu', label: 'Hasło / PIN / RetroAchievements' },
                { action: 'back', label: 'Wstecz' }
              ]
            : [
                { action: 'confirm', label: 'Zaloguj innego użytkownika' },
                { action: 'back', label: 'Wstecz' }
              ]
          : setup
            ? [
                { action: 'confirm', label: p ? 'To mój profil' : 'Utwórz' },
                { action: 'y', label: `Pytaj przy starcie: ${ask ? 'tak' : 'nie'}` }
              ]
            : p
              ? [
                  { action: 'confirm', label: 'Graj jako' },
                  { action: 'menu', label: 'Opcje profilu' },
                  { action: 'y', label: 'Zmień nazwę' },
                  { action: 'x', label: 'Usuń' },
                  { action: 'back', label: 'Wstecz' }
                ]
              : [
                  { action: 'confirm', label: 'Utwórz' },
                  { action: 'back', label: 'Wstecz' }
                ]
    }
  )

  return createPortal(
    <div className="profiles" data-layer>
      <h1>{setup ? 'Kto gra na tym komputerze?' : mode === 'startup' ? 'Kto gra?' : 'Profile'}</h1>
      {setup && (
        <p className="profiles__intro">
          Wybierz swój profil (konta z serwera są już na liście) albo utwórz nowy. Do niego trafią zapisy i konto RetroAchievements zastane w emulatorach na tym komputerze.
          Później zmienisz to w menu: Zmień profil.
        </p>
      )}
      {!st && <p className="details__loading">Wczytuję profile…</p>}
      {st?.rejected && (
        <div className="profiles__empty">
          <h2>Klucz tego urządzenia jest nieważny</h2>
          <p>Serwer go nie przyjmuje (urządzenie unieważnione w panelu serwera albo zastąpione nową rejestracją). Zaloguj się ponownie: menu → Zaloguj do serwera.</p>
        </div>
      )}
      {st && !st.rejected && (
        <div className="profiles__cards">
          {st.profiles.map((x, i) => (
            <button key={x.id} className={`pcard ${i === idx ? 'sel' : ''} ${x.id === st.current ? 'cur' : ''}`} onClick={() => (i === idx ? choose() : setIdx(i))}>
              <span className="pcard__av">{(x.name[0] ?? '?').toUpperCase()}</span>
              <span className="pcard__name">
                {x.name}
                {x.pin === 'need_pin' || x.pin === 'need_password' ? ' 🔒' : x.pin === 'set_password' ? ' ⚠' : ''}
              </span>
            </button>
          ))}
          <button className={`pcard add ${idx === st.profiles.length ? 'sel' : ''}`} onClick={() => (idx === st.profiles.length ? choose() : setIdx(st.profiles.length))}>
            <span className="pcard__av">+</span>
            <span className="pcard__name">{st.account ? 'Inny użytkownik' : 'Nowy profil'}</span>
          </button>
        </div>
      )}
      {/* the TV layout's hint bar is under this screen — the shared one on top */}
      {tv && <HintsBar />}
    </div>,
    document.body
  )
}
