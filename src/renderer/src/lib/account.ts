import type { EmuProfile } from '@shared/types'
import { api, askChoice, askText, useStore } from '../store'

// Account, login and profile flows of EmuStart (engine/web/app.js, options.js) for Lumen's one
// interface — the same steps, texts and rules; the engine does the work (api.account → api.py).

type R = { ok?: boolean; reason?: string }
const call = <T extends R = R>(method: Parameters<ReturnType<typeof api>['emustart']['account']>[0], ...args: unknown[]): Promise<T> =>
  api().emustart.account<T>(method, ...args)
const toast = (t: string, kind: 'info' | 'error' = 'info'): void => useStore.getState().toast(t, kind)

export const DEFAULT_SERVER = 'emustart.emucloud.org'

/** Password rules — the same as on the server (emustart/accounts.py: policy). */
export function pwPolicy(pw: string): string {
  const miss: string[] = []
  if (pw.length < 10) miss.push('co najmniej 10 znaków')
  if (!/[A-ZĄĆĘŁŃÓŚŹŻ]/.test(pw)) miss.push('wielka litera')
  if (!/\d/.test(pw)) miss.push('cyfra')
  if (!/[^\p{L}\p{N}\s]|_/u.test(pw)) miss.push('znak specjalny')
  return miss.length ? `Hasło musi mieć: ${miss.join(', ')}.` : ''
}

/** Account password; `isNew` — a new password: the rules and a second entry. */
export async function askPassword(title: string, isNew = false): Promise<string | null> {
  const pw = await askText(title + (isNew ? ' — min. 10 znaków, wielka litera, cyfra, znak specjalny' : ''), { secret: true })
  if (!pw) return null
  if (!isNew) return pw
  const why = pwPolicy(pw)
  if (why) {
    toast(why, 'error')
    return null
  }
  const again = await askText('Powtórz hasło', { secret: true })
  if (again === null) return null
  if (again !== pw) {
    toast('Hasła się różnią — spróbuj jeszcze raz.', 'error')
    return null
  }
  return pw
}

/** PIN of this device (4–8 digits); `twice` — a new PIN, entered twice. */
export async function askPin(title: string, twice = false): Promise<string | null> {
  const pin = (await askText(title, { secret: true }))?.trim()
  if (!pin) return null
  if (!/^\d{4,8}$/.test(pin)) {
    toast('PIN to 4–8 cyfr.', 'error')
    return null
  }
  if (!twice) return pin
  const again = (await askText('Powtórz PIN', { secret: true }))?.trim()
  if (again === undefined || again === null) return null
  if (again !== pin) {
    toast('PIN-y się różnią — spróbuj jeszcze raz.', 'error')
    return null
  }
  return pin
}

// ---------- login / logout ----------

/** Log this device in (EmuStart 0.49): a login link from the server's site (or panel) — at once; or
 *  the server address → the login code from the site, or account + password (waits for approval).
 *  A new account is not created here — an invitation from the administrator (the server's site). */
export async function loginFlow(): Promise<void> {
  const text = (await askText('Adres serwera (albo link logowania ze strony serwera)', { initial: DEFAULT_SERVER }))?.trim()
  if (!text) return
  type E = R & { status?: string; code?: string; account?: string }
  const fail = (e: Error): E => ({ ok: false, reason: e.message })
  if (text.startsWith('emustart://')) return loginCode(await call<E>('server_enroll', text, 'code', '', '', '').catch(fail))
  const site = `https://${text.replace(/^https?:\/\//, '')}`
  const mode = await askChoice(`Logowanie: ${text} · nowe konto — zaproszenie od administratora, potem kod ze strony ${site}`, [
    'Mam kod logowania ze strony serwera',
    'Mam konto i hasło'
  ])
  if (mode === null) return
  if (mode === 0) {
    const code = (await askText(`Kod logowania (strona ${site} → Pokaż kod logowania)`))?.trim()
    if (!code) return
    toast('Łączę z serwerem…')
    return loginCode(await call<E>('server_enroll', text, 'code', '', '', code).catch(fail))
  }
  const acc = (await askText('Nazwa twojego konta'))?.trim()
  if (!acc) return
  const pw = await askPassword(`Hasło konta „${acc}”`)
  if (!pw) return
  toast('Łączę z serwerem…')
  const r = await call<E>('server_enroll', text, 'existing', acc, pw).catch(fail)
  if (!r.ok) return toast(String(r.reason ?? 'Nie udało się połączyć z serwerem.'), 'error')
  useStore.getState().setEnroll({ code: String(r.code ?? ''), account: String(r.account ?? acc), mode: 'existing' })
}

/** A login code: the account comes from the code, approved at once. */
function loginCode(r: R & { status?: string; account?: string }): void {
  if (!r.ok) return toast(String(r.reason ?? 'Nie udało się połączyć z serwerem.'), 'error')
  if (r.status === 'approved') return loginDone(String(r.account ?? ''))
  toast(String(r.reason ?? 'Serwer nie przyjął kodu.'), 'error')
}

function loginDone(account: string): void {
  toast(`Zalogowano — konto „${account}” na tym urządzeniu.`)
  useStore.getState().setProfiles('setup')
}

/** Log out: the saves go to the server first; unsent ones — retry / log out anyway / cancel. */
export async function logoutFlow(): Promise<void> {
  const sure = await askChoice('Wylogować z serwera? To urządzenie straci dostęp do serwera.', ['Wyloguj', 'Anuluj'])
  if (sure !== 0) return
  let force = false
  for (;;) {
    toast('Wysyłam zapisy na serwer…')
    const r = await call<R & { ask?: boolean; games?: string[] }>('server_logout', force).catch((e: Error) => ({ ok: false, reason: e.message }) as never)
    if (r.ask) {
      const c = await askChoice(`${r.reason ?? 'Zapisy nie doszły na serwer.'} ${(r.games ?? []).join(', ')}`, [
        'Spróbuj jeszcze raz',
        'Wyloguj mimo to — zapisy zostaną tutaj i wyślą się po zalogowaniu na to samo konto'
      ])
      if (c === null) return
      force = c === 1
      continue
    }
    if (!r.ok) return toast(String(r.reason ?? 'Nie udało się wylogować.'), 'error')
    return toast('Wylogowano z serwera. Gry i zapisy na tym urządzeniu zostały.')
  }
}

// ---------- background checks (start + every minute) ----------

/** A login request sent earlier (the program was closed) — its result. */
export async function enrollResume(): Promise<void> {
  const p = await call<R & { status?: string; code?: string; account?: string }>('server_enroll_poll').catch(() => null)
  if (!p || p.status === 'none' || !p.status) return
  if (p.status === 'pending') useStore.getState().setEnroll({ code: String(p.code ?? ''), account: String(p.account ?? ''), mode: 'existing' })
  else if (p.status === 'approved') loginDone(String(p.account ?? ''))
  else if (p.status === 'denied') toast('Prośba o zalogowanie została odrzucona.', 'error')
}

const seen = new Set<string>()
/** Requests this device can approve: new devices of its account („Mam konto”). */
export async function enrollCheck(): Promise<void> {
  if (useStore.getState().dialog) return
  type Q = { id: string; mode: string; account: string; name: string; app?: string; class: string; from_account?: string; ip: string; created: number; code: string; replaces?: string[] }
  const r = await call<R & { requests?: Q[] }>('enroll_pending').catch(() => null)
  const q = (r?.requests ?? []).find((x) => !seen.has(x.id))
  if (!q) return
  seen.add(q.id)
  const kind = ({ pc: 'komputer', phone: 'telefon' } as Record<string, string>)[q.class] ?? q.class
  const when = new Date(q.created * 1000).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })
  const title =
    `Nowe urządzenie konta „${q.account}”: ${q.name} (${q.app || 'EmuStart'}, ${kind}` +
    `${q.from_account ? `, konto ${q.from_account}` : ''}) · ${q.ip} · ${when} · kod ${q.code}` +
    ((q.replaces ?? []).length ? ` · zastąpi wcześniejszą rejestrację tego programu na tym sprzęcie (${q.replaces!.join(', ')})` : '')
  const c = await askChoice(title, ['Zatwierdź — z grami z serwera', 'Zatwierdź — tylko zapisy i profil', 'Odrzuć', 'Później'])
  if (c === null || c === 3) return
  const allow = c < 2
  const x = await call('enroll_decide', q.id, allow, c === 0).catch((e: Error) => ({ ok: false, reason: e.message }) as never)
  toast(x.ok ? (allow ? `Zatwierdzono: ${q.name}` : `Odrzucono: ${q.name}`) : String(x.reason ?? 'Nie udało się.'), x.ok ? 'info' : 'error')
  setTimeout(() => void enrollCheck(), 1500)
}

// ---------- profiles ----------

/** A profile not available on this device: account password (another user), a new password
 *  (account without one) or this device's PIN. true = unlocked. */
export async function accessFlow(p: EmuProfile, need: string): Promise<boolean> {
  if (need === 'set_password') {
    toast(`Konto „${p.name}” nie ma jeszcze hasła — ustaw je (serwer pyta o nie nowe urządzenia i innych użytkowników).`)
    const pw = await askPassword(`Nowe hasło konta „${p.name}”`, true)
    if (!pw) return false
    const r = await call('profile_set_password', p.id, pw, '')
    if (!r.ok) return (toast(String(r.reason ?? 'Nie udało się.'), 'error'), false)
    toast(`Hasło konta „${p.name}” ustawione.`)
    return true
  }
  if (need === 'need_password') {
    const pw = await askPassword(`Hasło konta „${p.name}”`)
    if (!pw) return false
    const r = await call('profile_login', p.id, pw)
    if (!r.ok) return (toast(String(r.reason ?? 'Złe hasło.'), 'error'), false)
    return true
  }
  const pin = await askPin(`PIN profilu „${p.name}” (to urządzenie)`)
  if (!pin) return false
  const r = await call('profile_unlock', p.id, pin)
  if (!r.ok) return (toast(String(r.reason ?? 'Zły PIN.'), 'error'), false)
  return true
}

/** Another user's account (or a taken name when creating): its password. */
export async function joinExisting(name: string, asked = false): Promise<void> {
  if (!asked) toast(`Profil „${name}” już istnieje. Jeśli to Twój — podaj hasło konta; inaczej wybierz inną nazwę.`)
  const pw = await askPassword(`Hasło konta „${name}”`)
  if (!pw) return
  const r = await call<R & { missing?: boolean; name?: string; profile?: { name: string } }>('profile_join', name, pw)
  if (r.missing) return askNewAccount(String(r.name ?? name))
  if (!r.ok) return toast(String(r.reason ?? 'Złe hasło.'), 'error')
  toast(`Konto „${r.profile?.name ?? name}” jest teraz na tym urządzeniu.`)
}

/** No such account: new accounts come from an invitation (the server's site) or the server panel. */
function askNewAccount(name: string): void {
  toast(`Nie ma konta „${name}”. Nowe konto: poproś administratora o zaproszenie, zaloguj się na stronie serwera i ustaw tam hasło konta — potem dodasz je tutaj.`, 'error')
}

/** New profile: local (without the server); with the server the engine says how to get an account. */
export async function createProfile(): Promise<void> {
  const name = (await askText('Nazwa nowego profilu'))?.trim()
  if (!name) return
  const r = await call<R & { exists?: string; profile?: { name: string } }>('profile_create', name)
  if (r.exists) return joinExisting(String(r.exists))
  if (!r.ok) return toast(String(r.reason ?? 'Nie udało się.'), 'error')
  toast(`Utworzono profil: ${r.profile?.name ?? name}.`)
}

const RA_FAM: Record<string, string> = { retroarch: 'RetroArch', duckstation: 'DuckStation', pcsx2: 'PCSX2' }

/** Profile options (Start on a profile card): RetroAchievements, this PC's profile, name, password, PIN. */
export async function profileMenu(p: EmuProfile, ctx: { server: boolean; account: string }): Promise<void> {
  type Ra = R & { user?: string; hardcore?: boolean; found?: { user: string; family: string }[] }
  const st = await call<Ra>('ra_status', p.id).catch((): Ra => ({}))
  const items: [string, () => Promise<unknown> | void][] = []
  if (st.user) {
    items.push([`RetroAchievements: ${st.user} — wyloguj`, async () => (await call('ra_logout', p.id), toast('Wylogowano z RetroAchievements.'))])
    items.push([
      `Tryb hardcore: ${st.hardcore ? 'tak' : 'nie'} (bez stanów zapisu)`,
      async () => {
        const r = await call('ra_hardcore', p.id, !st.hardcore)
        toast(r.ok ? `Hardcore: ${!st.hardcore ? 'włączony' : 'wyłączony'}` : String(r.reason ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
      }
    ])
  }
  items.push([st.user ? 'Zaloguj inne konto RetroAchievements' : 'Zaloguj do RetroAchievements', () => raLogin(p)])
  for (const f of st.found ?? [])
    if (f.user !== st.user)
      items.push([
        `Użyj konta ${f.user} z ${RA_FAM[f.family] ?? f.family}`,
        async () => {
          const r = await call<R & { user?: string }>('ra_import', p.id, f.family)
          toast(r.ok ? `Profil „${p.name}” używa konta ${r.user}.` : String(r.reason ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
        }
      ])
  items.push([
    'Ustaw jako profil tego komputera',
    async () => {
      const r = await api().emustart.setOptions({ machineProfile: p.id })
      if (r) toast(`Profil tego komputera: ${p.name}`)
    }
  ])
  items.push(['Zmień nazwę', () => renameProfile(p)])
  if (ctx.server) {
    if (p.pin === 'set_password') items.push(['Ustaw hasło konta', () => accessFlow(p, 'set_password')])
    else
      items.push([
        'Zmień hasło konta',
        async () => {
          const old = await askPassword(`Dotychczasowe hasło „${p.name}”`)
          if (!old) return
          const pw = await askPassword('Nowe hasło konta', true)
          if (!pw) return
          const r = await call('profile_set_password', p.id, pw, old)
          toast(r.ok ? 'Hasło zmienione. Inni użytkownicy tego konta na innych urządzeniach podadzą nowe.' : String(r.reason ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
        }
      ])
  }
  if (!p.has_pin)
    items.push([
      'Ustaw PIN na tym urządzeniu',
      async () => {
        const pin = await askPin(`PIN profilu „${p.name}” (4–8 cyfr, tylko to urządzenie)`, true)
        if (!pin) return
        const r = await call('profile_set_pin', p.id, pin, '')
        toast(r.ok ? 'PIN ustawiony — to urządzenie zapyta o niego przy wyborze profilu.' : String(r.reason ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
      }
    ])
  else {
    items.push([
      'Zmień PIN tego urządzenia',
      async () => {
        const old = await askPin(`Dotychczasowy PIN „${p.name}”`)
        if (!old) return
        const pin = await askPin('Nowy PIN (4–8 cyfr)', true)
        if (!pin) return
        const r = await call('profile_set_pin', p.id, pin, old)
        toast(r.ok ? 'PIN zmieniony.' : String(r.reason ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
      }
    ])
    items.push([
      'Usuń PIN z tego urządzenia',
      async () => {
        const pin = await askPin(`PIN profilu „${p.name}”`)
        if (!pin) return
        const r = await call('profile_clear_pin', p.id, pin)
        toast(r.ok ? 'PIN usunięty.' : String(r.reason ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
      }
    ])
  }
  if (ctx.server && (p.nas_name || p.name).toLowerCase() !== ctx.account.toLowerCase())
    items.push(['Wyloguj konto z tego urządzenia', async () => (await call('profile_logout', p.id), toast(`Konto „${p.name}” wylogowane — następnym razem hasło.`))])
  const c = await askChoice(`Profil „${p.name}”`, items.map(([l]) => l))
  if (c !== null) await items[c][1]()
}

export async function renameProfile(p: EmuProfile): Promise<void> {
  const name = (await askText('Nowa nazwa profilu', { initial: p.name }))?.trim()
  if (!name || name === p.name) return
  const r = await call('profile_rename', p.id, name)
  if (!r.ok) toast(String(r.reason ?? 'Nie udało się.'), 'error')
}

async function raLogin(p: EmuProfile): Promise<void> {
  const user = (await askText(`RetroAchievements — nazwa użytkownika (${p.name})`))?.trim()
  if (!user) return
  const pw = await askText(`Hasło RetroAchievements dla ${user}`, { secret: true })
  if (!pw) return
  toast('Loguję…')
  const r = await call<R & { user?: string }>('ra_login', p.id, user, pw)
  toast(r.ok ? `Zalogowano: ${r.user}. Konto zadziała w RetroArch, DuckStation i PCSX2.` : String(r.reason ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
}
