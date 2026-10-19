import { useEffect, useState, type ReactNode } from 'react'
import type { CacheStats, Category, SecretName, SettingsPatch } from '@shared/types'
import { api, attempt, gamesForCategory, sortedCategories, useStore } from '../store'
import { useActions } from '../nav/input'
import { TextField } from '../components/TextField'
import { Modal } from '../components/Modal'
import { formatBytes, gameCountLabel } from '../lib/format'

export function SettingsScreen({ active }: { active: boolean }) {
  useActions(
    {
      back: () => {
        useStore.getState().setTab('home')
        return true
      }
    },
    { enabled: active, hints: [{ action: 'confirm', label: 'Wybierz' }, { action: 'back', label: 'Start' }, { action: 'lb', label: 'Biblioteka' }] }
  )
  return (
    <div className="settings" data-scroll="center">
      <SteamSection />
      <ArtSection />
      <CategoriesSection />
      <BehaviourSection />
      <DataSection />
      <HelpSection />
    </div>
  )
}

function Section({ title, children, desc }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {desc && <p className="card__desc">{desc}</p>}
      {children}
    </section>
  )
}

function Toggle({ label, value, onChange, desc }: { label: string; value: boolean; onChange: (v: boolean) => void; desc?: string }) {
  return (
    <button className="toggle" data-nav role="switch" aria-checked={value} onClick={() => onChange(!value)}>
      <span className="toggle__text">
        {label}
        {desc && <small>{desc}</small>}
      </span>
      <span className={`toggle__knob ${value ? 'is-on' : ''}`} />
    </button>
  )
}

const patch = async (p: SettingsPatch): Promise<void> => {
  const s = await attempt(api().settings.patch(p))
  if (s) useStore.getState().setSettings(s)
}

function SecretField({ name, label, has }: { name: SecretName; label: string; has: boolean }) {
  const [value, setValue] = useState('')
  const save = async (v: string | null): Promise<void> => {
    const s = await attempt(api().settings.setSecret(name, v))
    if (s) {
      useStore.getState().setSettings(s)
      useStore.getState().toast(v ? 'Zapisano klucz' : 'Usunięto klucz')
      setValue('')
    }
  }
  return (
    <div className="field-row">
      <label>{label}</label>
      <span className={`pill ${has ? 'pill--ok' : ''}`}>{has ? 'Zapisany' : 'Brak'}</span>
      <TextField type="password" label={label} placeholder={has ? 'Wpisz nowy, aby zmienić' : 'Wklej klucz'} value={value} onChange={setValue} onSubmit={(v) => v && void save(v)} />
      <button className="btn" data-nav disabled={!value.trim()} onClick={() => void save(value)}>
        Zapisz
      </button>
      {has && (
        <button className="btn btn--ghost" data-nav onClick={() => void save(null)}>
          Usuń
        </button>
      )}
    </div>
  )
}

function SteamSection() {
  const snapshot = useStore((s) => s.snapshot)!
  const settings = useStore((s) => s.settings)!
  const [steamId, setSteamId] = useState(settings.steamIdOverride ?? '')
  const { steam, account } = snapshot
  const statusText = { running: 'działa', notRunning: 'zainstalowany, wyłączony', notInstalled: 'nie znaleziono', unknown: 'nieznany' }[steam.status]

  const accountText =
    account.state === 'ok'
      ? `${gameCountLabel(account.count)} na koncie · pobrano ${new Date(account.fetchedAt).toLocaleString('pl-PL')}`
      : account.state === 'private'
        ? 'Steam zwrócił pustą odpowiedź — profil lub „Szczegóły gier” są prywatne.'
        : account.state === 'error'
          ? account.message
          : account.reason === 'noKey'
            ? 'Wyłączona — brak klucza Web API.'
            : 'Wyłączona — nie ustalono SteamID.'

  return (
    <Section
      title="Steam"
      desc="Gry zainstalowane są odczytywane z plików Steam na dysku (bez logowania). Pełną listę posiadanych gier daje oficjalne Steam Web API — wymaga osobistego klucza."
    >
      <dl className="facts facts--compact">
        <div className="facts__row">
          <dt>Klient Steam</dt>
          <dd>{statusText}</dd>
        </div>
        {steam.installPath && (
          <div className="facts__row">
            <dt>Instalacja</dt>
            <dd>{steam.installPath}</dd>
          </div>
        )}
        {steam.libraryFolders.length > 0 && (
          <div className="facts__row">
            <dt>Biblioteki</dt>
            <dd>{steam.libraryFolders.join(' · ')}</dd>
          </div>
        )}
        <div className="facts__row">
          <dt>Konto (SteamID64)</dt>
          <dd>{steam.activeSteamId ?? 'nie wykryto'}</dd>
        </div>
        <div className="facts__row">
          <dt>Biblioteka konta</dt>
          <dd>{accountText}</dd>
        </div>
      </dl>
      <SecretField name="steamWebApiKey" label="Klucz Steam Web API" has={settings.hasSteamWebKey} />
      <p className="card__desc">
        Klucz wygenerujesz na stronie{' '}
        <button className="link" data-nav onClick={() => void api().app.openExternal('https://steamcommunity.com/dev/apikey')}>
          steamcommunity.com/dev/apikey
        </button>
        . Klucz jest przechowywany lokalnie{settings.secretsEncrypted ? ' i szyfrowany (Windows DPAPI)' : ''}.
      </p>
      <div className="field-row">
        <label>Inne SteamID64 (opcjonalnie)</label>
        <TextField label="SteamID64" placeholder="automatycznie" value={steamId} onChange={setSteamId} onSubmit={(v) => void patch({ steamIdOverride: v.trim() })} />
        <button className="btn" data-nav onClick={() => void patch({ steamIdOverride: steamId.trim() })}>
          Zastosuj
        </button>
      </div>
      <div className="modal__row">
        <button
          className="btn btn--primary"
          data-nav
          onClick={() =>
            void attempt(api().library.refresh(true)).then((s) => s && useStore.getState().toast(`Odświeżono: ${gameCountLabel(s.games.length)}`))
          }
        >
          Odśwież bibliotekę
        </button>
        <button className="btn" data-nav onClick={() => void attempt(api().game.openInSteam('', 'downloads'))}>
          Pobieranie w Steam
        </button>
      </div>
    </Section>
  )
}

function ArtSection() {
  const settings = useStore((s) => s.settings)!
  return (
    <Section
      title="Grafiki (SteamGridDB)"
      desc="Plakaty, tła i logotypy mogą pochodzić ze SteamGridDB (wymaga darmowego klucza API) albo z oficjalnych grafik Steam. Pobrane obrazy są zapisywane w lokalnej pamięci podręcznej."
    >
      <SecretField name="sgdbApiKey" label="Klucz SteamGridDB" has={settings.hasSgdbKey} />
      <p className="card__desc">
        Klucz znajdziesz po zalogowaniu na{' '}
        <button className="link" data-nav onClick={() => void api().app.openExternal('https://www.steamgriddb.com/profile/preferences/api')}>
          steamgriddb.com → Preferences → API
        </button>
        .
      </p>
      <Toggle
        label="Najpierw grafiki ze SteamGridDB"
        desc={settings.artPriority === 'sgdbFirst' ? 'SteamGridDB, a przy braku wyników — Steam' : 'Oficjalne grafiki Steam, a przy braku — SteamGridDB'}
        value={settings.artPriority === 'sgdbFirst'}
        onChange={(v) => void patch({ artPriority: v ? 'sgdbFirst' : 'steamFirst' })}
      />
    </Section>
  )
}

function CategoriesSection() {
  const prefs = useStore((s) => s.prefs)!
  const snapshot = useStore((s) => s.snapshot)!
  const [prompt, setPrompt] = useState<{ mode: 'new' } | { mode: 'rename'; cat: Category } | null>(null)
  const [confirm, setConfirm] = useState<Category | null>(null)
  const cats = sortedCategories(prefs)
  const pinned = cats.filter((c) => c.pinned)
  const others = cats.filter((c) => !c.pinned)
  const kindLabel = (c: Category): string => {
    if (c.kind === 'smart') return 'wbudowana'
    const count = gamesForCategory(c, snapshot.games, prefs, snapshot.collections).length
    if (c.kind !== 'steam') return `własna · ${gameCountLabel(count)}`
    const total = snapshot.collections?.find((col) => col.id === c.steamCollectionId)?.appIds.length ?? 0
    if (total === 0) return 'kolekcja Steam · pusta'
    if (count === 0) return `kolekcja Steam · ${total} pozycji spoza Steam (skróty — jeszcze nieobsługiwane)`
    return `kolekcja Steam · ${gameCountLabel(count)}`
  }
  const dynamic = (snapshot.collections ?? []).filter((c) => c.dynamic)

  const row = (c: Category, i: number, list: Category[]) => (
    <div key={c.id} className={`cats__row ${c.pinned ? 'is-pinned' : ''}`}>
      <span className="cats__name">
        {c.name}
        <small>{kindLabel(c)}</small>
      </span>
      <button className={`btn btn--sm ${c.pinned ? 'btn--on' : ''}`} data-nav data-key={`pin-${c.id}`} onClick={() => void attempt(api().prefs.setPinned(c.id, !c.pinned))}>
        {c.pinned ? 'Odepnij' : 'Przypnij'}
      </button>
      {c.pinned && (
        <>
          <button className="btn btn--sm" data-nav data-key={`up-${c.id}`} aria-label="W górę" disabled={i === 0} onClick={() => void attempt(api().prefs.moveCategory(c.id, -1))}>
            ↑
          </button>
          <button className="btn btn--sm" data-nav data-key={`down-${c.id}`} aria-label="W dół" disabled={i === list.length - 1} onClick={() => void attempt(api().prefs.moveCategory(c.id, 1))}>
            ↓
          </button>
        </>
      )}
      {c.kind === 'custom' && (
        <>
          <button className="btn btn--sm" data-nav onClick={() => setPrompt({ mode: 'rename', cat: c })}>
            Zmień nazwę
          </button>
          <button className="btn btn--sm btn--danger" data-nav onClick={() => setConfirm(c)}>
            Usuń
          </button>
        </>
      )}
    </div>
  )

  return (
    <Section
      title="Kategorie i ekran Start"
      desc="Przypięte kategorie to rzędy na ekranie Start (w tej kolejności). Kolekcje Steam są odczytywane z klienta Steam i aktualizują się same — Lumen ich nie zmienia. Własne kategorie przypisujesz w ekranie gry → „Kategorie”."
    >
      <h3 className="cats__heading">Przypięte ({pinned.length})</h3>
      <div className="cats" data-nav-group="categories-pinned">
        {pinned.map((c, i) => row(c, i, pinned))}
        {!pinned.length && <p className="card__desc">Nic nie jest przypięte — ekran Start będzie pusty.</p>}
      </div>
      <h3 className="cats__heading">Pozostałe ({others.length})</h3>
      <div className="cats" data-nav-group="categories-other">
        {others.map((c, i) => row(c, i, others))}
      </div>
      <div className="modal__row">
        <button className="btn btn--primary" data-nav onClick={() => setPrompt({ mode: 'new' })}>
          Nowa kategoria
        </button>
      </div>
      {snapshot.collections === null && !snapshot.demo && (
        <p className="card__desc">Nie udało się odczytać kolekcji Steam (brak Steam lub konta na tym komputerze).</p>
      )}
      {dynamic.length > 0 && (
        <p className="card__desc">
          Kolekcje dynamiczne Steam nie są pokazywane, bo Steam wylicza je z własnych danych o grach, których Lumen nie ma:{' '}
          {dynamic.map((c) => c.name).join(', ')}.
        </p>
      )}
      {prompt && (
        <NamePrompt
          title={prompt.mode === 'new' ? 'Nowa kategoria' : 'Zmień nazwę kategorii'}
          initial={prompt.mode === 'rename' ? prompt.cat.name : ''}
          onClose={() => setPrompt(null)}
          onSubmit={async (name) => {
            const r = await attempt(prompt.mode === 'new' ? api().prefs.createCategory(name) : api().prefs.renameCategory(prompt.cat.id, name))
            if (r) setPrompt(null)
          }}
        />
      )}
      {confirm && (
        <Modal title={`Usunąć kategorię „${confirm.name}”?`} onClose={() => setConfirm(null)}>
          <p className="card__desc">Gry nie zostaną usunięte — zniknie tylko to przypisanie.</p>
          <div className="modal__footer">
            <button className="btn" data-nav data-autofocus onClick={() => setConfirm(null)}>
              Anuluj
            </button>
            <button
              className="btn btn--danger"
              data-nav
              onClick={async () => {
                await attempt(api().prefs.deleteCategory(confirm.id))
                setConfirm(null)
              }}
            >
              Usuń
            </button>
          </div>
        </Modal>
      )}
    </Section>
  )
}

function NamePrompt({ title, initial, onClose, onSubmit }: { title: string; initial: string; onClose: () => void; onSubmit: (v: string) => void }) {
  const [v, setV] = useState(initial)
  return (
    <Modal title={title} onClose={onClose}>
      <TextField label={title} value={v} onChange={setV} onSubmit={(x) => x.trim() && onSubmit(x)} />
      <div className="modal__footer">
        <button className="btn" data-nav onClick={onClose}>
          Anuluj
        </button>
        <button className="btn btn--primary" data-nav disabled={!v.trim()} onClick={() => onSubmit(v)}>
          Zapisz
        </button>
      </div>
    </Modal>
  )
}

function BehaviourSection() {
  const settings = useStore((s) => s.settings)!
  const [fs, setFs] = useState(false)
  useEffect(() => void api().app.isFullscreen().then(setFs), [])
  return (
    <Section title="Zachowanie">
      <Toggle
        label="Minimalizuj po uruchomieniu gry"
        desc="Lumen schodzi z drogi grze i nie reaguje na kontroler, gdy nie ma fokusu."
        value={settings.afterLaunch === 'minimize'}
        onChange={(v) => void patch({ afterLaunch: v ? 'minimize' : 'keep' })}
      />
      <Toggle
        label="Przywróć po zakończeniu gry (eksperymentalne)"
        desc="Na podstawie wartości RunningAppID, którą Steam zapisuje w rejestrze — nie dla każdej gry musi działać."
        value={settings.restoreAfterGame}
        onChange={(v) => void patch({ restoreAfterGame: v })}
      />
      <Toggle label="Uruchamiaj na pełnym ekranie" value={settings.startFullscreen} onChange={(v) => void patch({ startFullscreen: v })} />
      <Toggle
        label="Pełny ekran teraz (F11)"
        value={fs}
        onChange={() => void api().app.toggleFullscreen().then(setFs)}
      />
      <Toggle
        label="Pokazuj narzędzia Steam"
        desc="Np. Steamworks Common Redistributables, środowiska uruchomieniowe."
        value={settings.showTools}
        onChange={(v) => void patch({ showTools: v })}
      />
    </Section>
  )
}

function DataSection() {
  const settings = useStore((s) => s.settings)!
  const [stats, setStats] = useState<CacheStats | null>(null)
  useEffect(() => void api().app.cacheStats().then(setStats), [])
  return (
    <Section title="Dane" desc="Kategorie, ulubione i wybory grafik są zapisane osobno i nie znikają po wyczyszczeniu pamięci podręcznej.">
      <div className="modal__row">
        <span className="card__desc">
          Pamięć podręczna grafik: {stats ? `${stats.files} plików, ${formatBytes(stats.bytes) ?? '0 B'}` : '…'}
        </span>
        <button
          className="btn"
          data-nav
          onClick={async () => {
            const s = await attempt(api().app.clearCache())
            if (s) {
              setStats(s)
              useStore.getState().toast('Wyczyszczono pamięć podręczną')
            }
          }}
        >
          Wyczyść pamięć podręczną
        </button>
        <button className="btn" data-nav onClick={() => void api().app.openLogs()}>
          Pokaż logi
        </button>
      </div>
      <Toggle
        label="Tryb demonstracyjny"
        desc="Zastępuje bibliotekę fikcyjnymi grami oznaczonymi „DEMO” — tylko do podglądu interfejsu."
        value={settings.demoMode}
        onChange={(v) => void patch({ demoMode: v })}
      />
      <div className="modal__row">
        <button className="btn btn--danger" data-nav onClick={() => void api().app.quit()}>
          Zamknij Lumen
        </button>
      </div>
    </Section>
  )
}

function HelpSection() {
  const rows: [string, string, string][] = [
    ['Nawigacja', 'Strzałki', 'D-pad / lewa gałka'],
    ['Wybierz', 'Enter / Spacja', 'A'],
    ['Wstecz', 'Esc / Backspace', 'B'],
    ['Ulubiona', 'F', 'X'],
    ['Szukaj', 'S, / lub Ctrl+F', 'Y'],
    ['Poprzednia / następna zakładka', 'Q / E', 'LB / RB'],
    ['Ustawienia', 'O', 'Start (☰)'],
    ['Filtr w bibliotece', 'V', 'View (⧉)'],
    ['Pełny ekran', 'F11', '—']
  ]
  return (
    <Section title="Sterowanie">
      <table className="keys">
        <thead>
          <tr>
            <th>Akcja</th>
            <th>Klawiatura</th>
            <th>Kontroler</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, k, p]) => (
            <tr key={a}>
              <td>{a}</td>
              <td>{k}</td>
              <td>{p}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="card__desc" data-nav tabIndex={0}>
        Jeśli kontroler steruje jednocześnie myszą, wyłącz w Steamie „Konfigurację pulpitu” (Steam Input) lub dodaj Lumen jako grę spoza Steam.
      </p>
    </Section>
  )
}
