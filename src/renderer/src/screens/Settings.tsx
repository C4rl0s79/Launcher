import { useEffect, useState, type ReactNode } from 'react'
import type { CacheStats, Category, EmuSettings, LaunchBoxStatus, SecretName, SettingsPatch } from '@shared/types'
import type { PickPathOptions } from '@shared/api'
import { loginFlow, logoutFlow } from '../lib/account'
import { detectEmulators, installMissing, pushArtKeys } from '../lib/emusettings'
import { api, attempt, gamesForCategory, pickPath, sortedCategories, useStore } from '../store'
import { useActions } from '../nav/input'
import { TextField } from '../components/TextField'
import { Modal } from '../components/Modal'
import { formatBytes, gameCountLabel } from '../lib/format'
import { UpdateSection } from '../components/Update'
import { EmuLibraryOptions } from '../components/EmuOptions'

export function SettingsScreen({ active }: { active: boolean }) {
  useActions(
    {
      back: () => {
        useStore.getState().setTab('home')
        return true
      }
    },
    { enabled: active, hints: [{ action: 'confirm', label: 'Wybierz' }, { action: 'back', label: 'Start' }, { action: 'lb', label: 'Poprzednia zakładka' }] }
  )
  return (
    <div className="settings" data-scroll="center">
      <InterfaceSection />
      <SteamSection />
      <EmustartSection />
      <Section
        title="Biblioteka EmuStart"
        desc="Te same ustawienia co w EmuStart (tryb TV → Ustawienia) — zapisane raz, działają w obu trybach."
      >
        <EmuLibraryOptions />
      </Section>
      <ArtSection />
      <LaunchBoxSection />
      <CategoriesSection />
      <BehaviourSection />
      <DataSection />
      <Section
        title="Aktualizacja Lumen"
        desc="Jak w EmuStart: nowe wersje z wydań na GitHubie (C4rl0s79/Launcher), sprawdzane przy starcie i raz dziennie. Plik jest sprawdzany skrótem SHA-256 i podpisem wydania Lumen; dane w LumenData zostają nietknięte."
      >
        <UpdateSection />
      </Section>
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

function LaunchBoxSection() {
  const [st, setSt] = useState<LaunchBoxStatus | null>(null)
  useEffect(() => {
    void api().launchbox.status().then(setSt)
    return api().launchbox.onChange(setSt)
  }, [])
  const job = st?.job
  const pct = job && job.total > 0 ? Math.floor((job.done / job.total) * 100) : null
  return (
    <Section
      title="Opisy gier spoza Steama (LaunchBox)"
      desc="Gry dodane do Steama jako skróty (np. emulatory) nie mają danych w sklepie Steam. Lumen może pobrać otwartą bazę LaunchBox Games DB (~110 MB, ok. 190 tys. gier) i dopasowywać opisy, gatunki, producentów i daty premiery lokalnie, bez sieci. Z tej bazy pochodzą też grafiki gier EmuStart (tła, pudełka, logo) — same obrazki pobierają się dopiero przy wyświetleniu."
    >
      <dl className="facts facts--compact">
        <div className="facts__row">
          <dt>Baza</dt>
          <dd>
            {st?.ready
              ? `${st.games?.toLocaleString('pl-PL')} gier · ${st.images ? `${st.images.toLocaleString('pl-PL')} grafik · ` : ''}${formatBytes(st.sizeBytes) ?? ''} · zaktualizowano ${st.updated ? new Date(st.updated).toLocaleDateString('pl-PL') : '?'}${st.outdated ? ' · bez listy grafik — Lumen przebuduje bazę sam' : ''}`
              : 'nie pobrano'}
          </dd>
        </div>
      </dl>
      {job && (
        <div className="download">
          <div className="download__head">
            <strong>{job.phase === 'download' ? 'Pobieranie Metadata.zip' : 'Budowanie bazy'}</strong>
            <span>
              {job.phase === 'download'
                ? `${formatBytes(job.done) ?? '0 B'}${job.total ? ` z ${formatBytes(job.total)}` : ''}`
                : `${job.done.toLocaleString('pl-PL')} gier`}
            </span>
          </div>
          {pct !== null && (
            <div className="download__bar">
              <i style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}
      {st?.error && <p className="card__desc notice__warn">Ostatnia próba nie powiodła się: {st.error}</p>}
      <div className="modal__row">
        {job ? (
          <button className="btn" data-nav onClick={() => void api().launchbox.cancel()}>
            Przerwij
          </button>
        ) : (
          <button className="btn btn--primary" data-nav onClick={() => void attempt(api().launchbox.update()).then((s) => s && setSt(s))}>
            {st?.ready ? 'Zaktualizuj bazę LaunchBox' : 'Pobierz bazę LaunchBox'}
          </button>
        )}
      </div>
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
    if (count === 0) return `kolekcja Steam · ${total} pozycji, żadna nie jest w bibliotece`
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
      title="Grupy na górnym pasku"
      desc="Przypięte grupy to zakładki na górnym pasku (w tej kolejności; LB/RB lub Q/E przełączają między nimi). Kolekcje Steam są odczytywane z klienta Steam i aktualizują się same — Lumen ich nie zmienia. Własne kategorie przypisujesz w ekranie gry → „Kategorie”."
    >
      <h3 className="cats__heading">Przypięte ({pinned.length})</h3>
      <div className="cats" data-nav-group="categories-pinned">
        {pinned.map((c, i) => row(c, i, pinned))}
        {!pinned.length && <p className="card__desc">Nic nie jest przypięte — na pasku będą tylko Start i Ustawienia.</p>}
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

function InterfaceSection() {
  const settings = useStore((s) => s.settings)!
  return (
    <Section
      title="Tryb interfejsu"
      desc="Dwa wyglądy tej samej aplikacji: pulpit (ten widok) i tryb TV w stylu EmuStart — z tą samą biblioteką, ustawieniami i listą zadań. Przełączanie nie przerywa pobierania ani gry: F10 albo View + Start na padzie."
    >
      <div className="modal__row">
        <button className="btn btn--primary" data-nav onClick={() => void api().ui.setMode('fullscreen')}>
          Przełącz na tryb TV
        </button>
      </div>
      <Toggle
        label="Uruchamiaj w trybie TV"
        desc="Przy starcie od razu tryb pełnoekranowy w stylu EmuStart."
        value={settings.startMode === 'fullscreen'}
        onChange={(v) => void patch({ startMode: v ? 'fullscreen' : 'desktop' })}
      />
    </Section>
  )
}

function EmustartSection() {
  const settings = useStore((s) => s.settings)!
  const emu = useStore((s) => s.snapshot?.emustart)
  // administrator of the server (art source keys) — from the engine, when it runs
  const [admin, setAdmin] = useState(false)
  useEffect(() => {
    if (emu?.engine !== 'ready' || !emu.server) return setAdmin(false)
    void api()
      .emustart.account<{ admin?: boolean }>('get_state')
      .then((st) => setAdmin(!!st.admin))
      .catch(() => setAdmin(false))
  }, [emu?.engine, emu?.server?.ok]) // eslint-disable-line react-hooks/exhaustive-deps
  const [es, setEs] = useState<EmuSettings | null>(null)
  const ready = emu?.engine === 'ready'
  useEffect(() => {
    if (ready) void api().emustart.settings().then(setEs).catch(() => setEs(null))
  }, [ready])

  const engineText =
    emu?.engine === 'ready'
      ? `działa (EmuStart ${emu.version ?? '?'})`
      : emu?.engine === 'starting'
        ? 'uruchamianie…'
        : emu?.engine === 'disabled'
          ? 'wyłączony'
          : `nie działa — ${emu?.message ?? 'brak szczegółów'}`
  const serverText = !emu?.server
    ? 'nie zalogowano'
    : emu.server.ok
      ? `połączono${emu.server.name ? ` (${emu.server.name})` : ''}${es?.serverVia ? ` · przez: ${es.serverVia}` : ''}`
      : emu.server.key_rejected
        ? 'serwer nie przyjmuje tego urządzenia (wylogowane w panelu serwera albo zastąpione innym logowaniem) — zaloguj się ponownie w trybie TV'
        : emu.server.checking
          ? 'łączenie…'
          : 'serwer nie odpowiada (pobrane gry działają bez niego)'

  return (
    <Section
      title="EmuStart"
      desc="Gry na emulowane platformy z serwera EmuStart. Pobieranie, emulatory i BIOS-y z serwera, uruchamianie i synchronizację zapisów wykonuje silnik EmuStart (ten sam kod co program EmuStart) — Lumen go uruchamia i pokazuje jego stan."
    >
      <div className="modal__row">
        <span className="card__desc">Gry z kilkoma wersjami (regiony) — domyślnie pokazuj:</span>
        <div className="segmented" role="group" aria-label="Preferowany region">
          {(
            [
              ['europe', 'Polska / Europa'],
              ['usa', 'USA'],
              ['japan', 'Japonia']
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={`seg ${settings.regionOrder === v ? 'is-on' : ''}`} data-nav onClick={() => void patch({ regionOrder: v })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <Toggle
        label="Gry z serwera EmuStart"
        desc="Wyłączone: silnik EmuStart nie jest uruchamiany, w bibliotece zostają tylko gry Steam."
        value={settings.emustartEnabled}
        onChange={(v) => void patch({ emustartEnabled: v })}
      />
      <dl className="facts facts--compact">
        <div className="facts__row">
          <dt>Silnik</dt>
          <dd>{engineText}</dd>
        </div>
        <div className="facts__row">
          <dt>Serwer</dt>
          <dd>{serverText}</dd>
        </div>
        {es?.account && (
          <div className="facts__row">
            <dt>Konto</dt>
            <dd>
              {es.account}
              {emu?.profile ? ` · profil ${emu.profile}` : ''}
            </dd>
          </div>
        )}
        {emu && (
          <div className="facts__row">
            <dt>Biblioteka</dt>
            <dd>
              {emu.systems.length
                ? `${emu.systems.length} platform, ${gameCountLabel(emu.systems.reduce((n, x) => n + x.games, 0))}`
                : 'pusta'}
              {emu.fromCache ? ' (ostatnia zapisana kopia — silnik nie działa)' : ''}
            </dd>
          </div>
        )}
        {es && (
          <>
            <div className="facts__row">
              <dt>Folder emulatorów</dt>
              <dd>{es.emuRoot || 'nie wybrano'}</dd>
            </div>
            <div className="facts__row">
              <dt>Pobrane gry</dt>
              <dd>
                {es.cacheDir} · ostatnie {es.cacheRecent} + zachowane
              </dd>
            </div>
            <div className="facts__row">
              <dt>Dane EmuStart</dt>
              <dd>{es.dataDir}</dd>
            </div>
          </>
        )}
      </dl>
      {ready && (
        <div className="modal__row">
          <button className="btn" data-nav onClick={() => void chooseEmuFolder('emu_root', 'Folder emulatorów', es?.emuRoot, setEs)}>
            Folder emulatorów…
          </button>
          <button className="btn" data-nav onClick={() => void chooseEmuFolder('cache_dir', 'Folder pobranych gier', es?.cacheDir, setEs)}>
            Folder pobranych gier…
          </button>
          <button
            className="btn"
            data-nav
            onClick={async () => {
              const r = await attempt(api().emustart.refreshLibrary())
              if (r) useStore.getState().toast(r.ok ? (r.message ?? 'Odświeżanie…') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error')
            }}
          >
            Odśwież bibliotekę z serwera
          </button>
        </div>
      )}
      <div className="modal__row">
        <button className="btn btn--primary" data-nav onClick={() => void (emu?.server ? logoutFlow() : loginFlow())}>
          {emu?.server ? 'Wyloguj z serwera' : 'Zaloguj do serwera'}
        </button>
        {emu?.engine === 'ready' && (
          <button className="btn" data-nav onClick={() => useStore.getState().setProfiles('normal')}>
            Profile (kto gra, PIN, RetroAchievements)
          </button>
        )}
        {emu?.engine === 'ready' && (
          <button className="btn" data-nav onClick={() => useStore.getState().setPads(true)}>
            Kolejność padów
          </button>
        )}
      </div>
      {emu?.engine === 'ready' && (
        <div className="modal__row">
          <button className="btn" data-nav onClick={() => void detectEmulators()}>
            Wykryj emulatory
          </button>
          <button className="btn" data-nav onClick={() => void installMissing()}>
            Pobierz brakujące emulatory
          </button>
          {admin && (
            <button className="btn" data-nav onClick={() => void pushArtKeys()} title="Klucze z PyLinks na tym komputerze — na serwer (połączenie szyfrowane)">
              Wyślij klucze źródeł grafik na serwer
            </button>
          )}
        </div>
      )}
      <div className="modal__row">
        {emu?.engine !== 'disabled' && (
          <button className="btn" data-nav onClick={() => void api().emustart.restartEngine()}>
            Uruchom silnik ponownie
          </button>
        )}
      </div>
      <p className="card__desc">
        Logowanie do serwera (kod z panelu albo adres), konta i PIN-y profili są w ustawieniach EmuStart w trybie TV —
        pozostałe ustawienia EmuStart są niżej, w sekcji „Biblioteka EmuStart”.
      </p>
      <PathRow
        label="Folder danych EmuStart"
        value={settings.emustartHome}
        fallback={`domyślny — folder Lumen${es?.dataDir && !settings.emustartHome ? ` (${es.dataDir})` : ''}`}
        pick={{ kind: 'folder', title: 'Folder danych EmuStart (np. folder istniejącej instalacji EmuStart)' }}
        onChange={(v) => void patch({ emustartHome: v })}
      />
      <p className="card__desc">
        Folder istniejącej instalacji EmuStart (z config.json, cache, profiles) zostaje użyty na miejscu — nic nie jest kopiowane ani
        kasowane. Nie uruchamiaj w tym czasie samodzielnego EmuStart z tego samego folderu (Lumen to sprawdza).
      </p>
      <PathRow
        label="Python dla silnika (wersja ze źródeł)"
        value={settings.pythonPath}
        fallback="domyślny — dołączony silnik albo „py -3”"
        pick={{ kind: 'file', title: 'Python (python.exe) dla silnika EmuStart', extensions: ['exe'] }}
        onChange={(v) => void patch({ pythonPath: v })}
      />
    </Section>
  )
}

/**
 * A file or folder setting: chosen only with the Windows dialog (never typed), shown read-only,
 * with a way back to the default. `onChange('')` = default.
 */
function PathRow({
  label,
  value,
  fallback,
  pick,
  onChange
}: {
  label: string
  value?: string
  fallback: string
  pick: Omit<PickPathOptions, 'start'>
  onChange: (v: string) => void
}) {
  return (
    <div className="path-row">
      <div className="path-row__text">
        <span className="path-row__label">{label}</span>
        <span className={`path-row__value ${value ? '' : 'is-default'}`} title={value || fallback}>
          {value || fallback}
        </span>
      </div>
      <button
        className="btn"
        data-nav
        onClick={async () => {
          // start in the current folder (or the one holding the current file)
          const start = value ? (pick.kind === 'file' ? value.replace(/[\\/][^\\/]*$/, '') : value) : undefined
          const v = await pickPath({ ...pick, start })
          if (v) onChange(v)
        }}
      >
        Wybierz…
      </button>
      {value && (
        <button className="btn btn--ghost" data-nav onClick={() => onChange('')}>
          Przywróć domyślny
        </button>
      )}
    </div>
  )
}

async function chooseEmuFolder(
  key: 'emu_root' | 'cache_dir',
  title: string,
  current: string | undefined,
  done: (s: EmuSettings) => void
): Promise<void> {
  const folder = await pickPath({ kind: 'folder', title, start: current || undefined })
  if (!folder) return
  const s = await attempt(api().emustart.setFolder(key, folder))
  if (s) done(s)
}

function BehaviourSection() {
  const settings = useStore((s) => s.settings)!
  const [fs, setFs] = useState(false)
  useEffect(() => void api().app.isFullscreen().then(setFs), [])
  return (
    <Section title="Zachowanie">
      <Toggle
        label="Pad przez XInput (zalecane)"
        desc={
          settings.xinputAvailable === false
            ? 'XInput niedostępny na tym komputerze — używany jest Gamepad API przeglądarki.'
            : settings.gamepadBackend === 'xinput'
              ? 'Lumen tylko odczytuje stan pada, jak gry, i nie inicjalizuje urządzeń. Działa z padami Xbox i padami widzianymi jako Xbox (Steam Input, tryb X).'
              : 'Gamepad API przeglądarki: obsługuje też pady PlayStation/Switch bez Steam Input, ale może zakłócać podłączanie pada w trakcie działania Lumen.'
        }
        value={settings.gamepadBackend === 'xinput' && settings.xinputAvailable !== false}
        onChange={(v) => void patch({ gamepadBackend: v ? 'xinput' : 'chromium' })}
      />
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
    ['Poprzednia / następna grupa (górny pasek)', 'Q / E', 'LB / RB'],
    ['Filtr: wszystkie / zainstalowane / niezainstalowane', 'PgUp / PgDn', 'LT / RT'],
    ['Ustawienia', 'O', 'Start (☰)'],
    ['Sortowanie w grupie', 'V', 'View (⧉)'],
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
