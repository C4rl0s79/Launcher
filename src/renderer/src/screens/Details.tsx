import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DetailsResult, EmuReadiness, EmustartSummary, Game, Job } from '@shared/types'
import { api, attempt, steamCollectionsOf, useStore } from '../store'
import { useActions } from '../nav/input'
import { focusEl, focusFirst } from '../nav/engine'
import { Art } from '../components/Art'
import { CategoryPicker } from '../modals/CategoryPicker'
import { ArtPicker } from '../modals/ArtPicker'
import { formatBytes, formatEta, formatLastPlayed, formatPlaytime, htmlToParagraphs, STATE_LABEL, stateLabel, versionCountLabel } from '../lib/format'

interface PrimaryAction {
  label: string
  run?: () => Promise<void>
  disabled?: boolean
  note?: string
}

export function DetailsScreen({ gameId }: { gameId: string }) {
  const game = useStore((s) => s.snapshot?.games.find((g) => g.id === gameId))
  const steamStatus = useStore((s) => s.snapshot?.steam.status)
  const prefs = useStore((s) => s.prefs)!
  const collections = useStore((s) => s.snapshot?.collections ?? null)
  const close = (): void => useStore.getState().openDetails(null)
  const [details, setDetails] = useState<DetailsResult | null>(null)
  const [modal, setModal] = useState<'categories' | 'art' | null>(null)
  const [logoOk, setLogoOk] = useState(true)
  const [busy, setBusy] = useState(false)
  const isEmu = game?.source === 'emustart'
  const emuSummary = useStore((s) => s.snapshot?.emustart)
  const allJobs = useStore((s) => s.jobs.jobs)
  const gameJobs = useMemo(() => allJobs.filter((j) => j.gameId === gameId && j.kind !== 'emuLaunch'), [allJobs, gameId])
  const installing = allJobs.some((j) => j.kind === 'emuInstall')
  const [ready, setReady] = useState<EmuReadiness | null>(null)

  // EmuStart: what is missing before the game can start (emulator) — re-checked after installs
  useEffect(() => {
    if (!isEmu || emuSummary?.engine !== 'ready' || installing) return
    let alive = true
    void api()
      .emustart.readiness(gameId)
      .then((r) => alive && setReady(r))
      .catch(() => alive && setReady(null))
    return () => {
      alive = false
    }
  }, [isEmu, gameId, emuSummary?.engine, installing])
  const ref = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)

  useEffect(() => {
    let alive = true
    // only Steam store apps have store metadata
    if (gameId.startsWith('demo:')) return
    void api()
      .game.details(gameId)
      .then((d) => alive && setDetails(d))
      .catch(() => alive && setDetails({ ok: false, error: 'Błąd odczytu szczegółów.' }))
    return () => {
      alive = false
    }
  }, [gameId])

  useEffect(() => {
    if (ref.current) focusFirst(ref.current)
    const o = opener.current
    return () => {
      // the library/home screen stays mounted underneath, so the poster still exists
      setTimeout(() => o?.isConnected && !ref.current?.isConnected && focusEl(o, false), 0)
    }
  }, [])

  const isFav = prefs.favorites.includes(gameId)
  const toggleFav = (): void => void attempt(api().prefs.toggleFavorite(gameId))

  useActions(
    {
      back: () => {
        close()
        return true
      },
      x: () => {
        toggleFav()
        return true
      },
      lb: () => true,
      rb: () => true,
      menu: () => true,
      y: () => true
    },
    {
      modal: true,
      hints: [
        { action: 'confirm', label: 'Wybierz' },
        { action: 'x', label: isFav ? 'Usuń z ulubionych' : 'Ulubiona' },
        { action: 'back', label: 'Wróć' }
      ]
    }
  )

  const primary = useMemo<PrimaryAction | null>(() => {
    if (!game) return null
    const wrap = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => async () => {
      setBusy(true)
      const r = await attempt(fn())
      setBusy(false)
      if (r) useStore.getState().toast(r.ok ? (r.message ?? 'Gotowe') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error')
    }
    if (game.source === 'demo') return { label: 'Gra demonstracyjna', disabled: true, note: 'Dane demonstracyjne — akcje są wyłączone.' }
    if (game.emu) return emuPrimary(game, emuSummary, ready, installing, setBusy)
    if (steamStatus === 'notInstalled') return { label: 'Steam niedostępny', disabled: true, note: 'Nie znaleziono klienta Steam na tym komputerze.' }
    const play = wrap(() => api().game.play(gameId))
    const downloads = wrap(() => api().game.openInSteam(gameId, 'downloads'))
    const steamNote = steamStatus === 'notRunning' ? 'Steam jest wyłączony — zostanie uruchomiony automatycznie.' : undefined
    switch (game.installState) {
      case 'installed':
        return { label: game.running ? 'Gra działa' : 'Graj', run: play, note: game.running ? 'Steam zgłasza, że gra jest uruchomiona.' : steamNote }
      case 'updateRequired':
        return { label: 'Graj', run: play, note: 'Steam zainstaluje aktualizację przed uruchomieniem.' }
      case 'notInstalled':
        return { label: 'Zainstaluj', run: wrap(() => api().game.install(gameId)), note: steamNote ?? 'Instalację przeprowadzi klient Steam.' }
      case 'installing':
      case 'updating':
        return { label: 'Pokaż pobieranie w Steam', run: downloads }
      case 'updatePaused':
        return { label: 'Wznów w Steam', run: downloads, note: 'Pobieranie jest wstrzymane w kliencie Steam.' }
      case 'uninstalling':
        return { label: 'Odinstalowywanie…', disabled: true }
      case 'broken':
        if (game.shortcut)
          return { label: 'Brak programu', disabled: true, note: `Nie znaleziono pliku: ${game.shortcut.exe}` }
        return {
          label: 'Otwórz w Steam',
          run: wrap(() => api().game.openInSteam(gameId, 'details')),
          note: 'Pliki gry wymagają weryfikacji lub naprawy w kliencie Steam.'
        }
    }
  }, [game, gameId, steamStatus, emuSummary, ready, installing])

  if (!game) {
    return createPortal(
      <div className="details" data-layer ref={ref}>
        <div className="details__content">
          <h1 className="details__title">Gra nie jest już dostępna</h1>
          <button className="btn btn--primary" data-nav data-autofocus onClick={close}>
            Wróć
          </button>
        </div>
      </div>,
      document.body
    )
  }

  const d = details?.ok ? details.details : null
  const paragraphs = d?.descriptionHtml
    ? htmlToParagraphs(d.descriptionHtml)
    : d?.descriptionText
      ? d.descriptionText
          .split(/\n+/)
          .map((p) => p.trim())
          .filter(Boolean)
          .slice(0, 8)
      : d?.shortDescription
        ? [d.shortDescription]
        : []
  const facts: [string, string | undefined][] = [
    ['Gatunki', d?.genres?.join(', ')],
    ['Liczba graczy', d?.players],
    ['Ocena społeczności', d?.rating ? `${d.rating.toFixed(1).replace('.', ',')} / 5` : undefined],
    ['Premiera', d?.releaseDate],
    ['Producent', d?.developers?.join(', ')],
    ['Wydawca', d?.publishers?.join(', ')],
    ['Rozmiar na dysku', game.installed && !game.emu ? formatBytes(game.sizeOnDisk) : undefined],
    ['Biblioteka', game.installed ? game.libraryPath : undefined],
    ['Platforma', game.emu?.system],
    ['Rozmiar', game.emu ? formatBytes(game.emu.size) : undefined],
    ['Płyty', game.emu && game.emu.discs > 1 ? `${game.emu.discs} — jedna pozycja, zmiana płyty w emulatorze` : undefined],
    ['Wersja', game.emu?.tags || undefined],
    ['Emulator', isEmu && ready?.ok ? ready.emulator || 'nie wybrano' : undefined],
    ['Zapisy na serwerze', isEmu && ready?.ok && ready.sync ? syncLabel(ready.sync.state, ready.sync.last) : undefined],
    ['Źródło', game.emu ? `Serwer EmuStart${emuSummary?.server?.name ? ` (${emuSummary.server.name})` : ''}` : undefined],
    ['Platforma', game.shortcut?.tags.join(', ') || undefined],
    ['Źródło', game.shortcut ? 'Skrót spoza Steam (uruchamiany przez Steam)' : undefined]
  ]
  const presentFacts = facts.filter((f): f is [string, string] => !!f[1])
  const chips = [
    { label: game.running ? 'Uruchomiona' : stateLabel(game), tone: game.installed ? 'ok' : 'muted' },
    formatPlaytime(game.playtimeMinutes) && { label: `Czas gry: ${formatPlaytime(game.playtimeMinutes)}` },
    formatLastPlayed(game.lastPlayed) && { label: `Ostatnio: ${formatLastPlayed(game.lastPlayed)}` },
    isFav && { label: '★ Ulubiona', tone: 'fav' }
  ].filter(Boolean) as { label: string; tone?: string }[]
  const myCats = prefs.categories.filter((c) => prefs.gameCategories[gameId]?.includes(c.id))
  const steamCols = steamCollectionsOf(game, prefs, collections)

  return createPortal(
    <div className="details" data-layer ref={ref}>
      <div className="details__hero">
        <Art gameId={game.id} name={game.name} kind="hero" fallback="hero" eager />
      </div>
      <div className="details__shade" />
      <div className="details__content" data-scroll="center">
        <div className="details__head">
          {logoOk ? (
            <Art gameId={game.id} name={game.name} kind="logo" className="details__logo" fallback="none" eager onState={setLogoOk} />
          ) : (
            <h1 className="details__title">{game.name}</h1>
          )}
          {logoOk && <h1 className="sr-only">{game.name}</h1>}
          <div className="chips">
            {chips.map((c) => (
              <span key={c.label} className={`chip ${c.tone ? `chip--${c.tone}` : ''}`}>
                {c.label}
              </span>
            ))}
          </div>
        </div>

        {primary && (
          <div className="details__primary">
            <button
              className="btn btn--play"
              data-nav
              data-autofocus
              disabled={primary.disabled || busy}
              onClick={() => void primary.run?.()}
            >
              {game.installed && !game.running && primary.label === 'Graj' && <span className="btn__icon">▶</span>}
              {primary.label}
            </button>
            {primary.note && <p className="details__note">{primary.note}</p>}
          </div>
        )}

        {!game.emu && (game.installState === 'installing' || game.installState === 'updating' || game.installState === 'updatePaused') && (
          <DownloadStatus game={game} />
        )}
        {game.emu && gameJobs.map((j) => <EmuJobStatus key={j.id} job={j} />)}

        {game.emu?.versions && <VersionPicker gameId={gameId} game={game} chosen={prefs.versions[gameId]} />}

        <div className="details__actions" data-nav-group="details-actions">
          <button className="btn" data-nav data-key="fav" onClick={toggleFav}>
            {isFav ? '★ W ulubionych' : '☆ Do ulubionych'}
          </button>
          <button className="btn" data-nav data-key="cats" onClick={() => setModal('categories')}>
            Kategorie{myCats.length ? ` (${myCats.length})` : ''}
          </button>
          {!game.emu && (
            <button className="btn" data-nav data-key="art" onClick={() => setModal('art')}>
              Grafiki
            </button>
          )}
          {game.emu && emuSummary?.engine === 'ready' && (
            <>
              <button
                className="btn"
                data-nav
                data-key="keep"
                onClick={async () => {
                  const r = await attempt(api().emustart.toggleKeep(gameId))
                  if (r) useStore.getState().toast(r.ok ? (r.message ?? 'Gotowe') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error')
                }}
              >
                {game.emu.pinned ? '📌 Zachowana na dysku' : game.emu.cached ? 'Zachowaj na dysku' : 'Pobierz na dysk'}
              </button>
              {(game.emu.cached || game.emu.pinned || game.emu.copying) && (
                <button
                  className="btn btn--danger"
                  data-nav
                  data-key="remove"
                  onClick={async () => {
                    const r = await attempt(api().emustart.removeLocal(gameId))
                    if (r) useStore.getState().toast(r.ok ? (r.message ?? 'Usunięto') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error')
                  }}
                >
                  Usuń z dysku
                </button>
              )}
              <button className="btn" data-nav data-key="tv" onClick={() => void api().ui.setMode('fullscreen')}>
                Opcje gry w trybie TV
              </button>
            </>
          )}
          {game.source === 'steam' && (
            <>
              <button className="btn" data-nav data-key="steam" onClick={() => void attempt(api().game.openInSteam(gameId, 'details'))}>
                Otwórz w Steam
              </button>
              <button className="btn" data-nav data-key="store" onClick={() => void attempt(api().game.openInSteam(gameId, 'store'))}>
                Strona sklepu
              </button>
            </>
          )}
        </div>

        {myCats.length + steamCols.length > 0 && (
          <div className="details__cats">
            {myCats.map((c) => (
              <span key={c.id} className="chip chip--outline">
                {c.name}
              </span>
            ))}
            {steamCols.map((c) => (
              <span key={c.id} className="chip chip--outline chip--steam" title="Kolekcja Steam">
                {c.name}
              </span>
            ))}
          </div>
        )}

        {(paragraphs.length > 0 || presentFacts.length > 0) && (
          <div className="details__body">
            {paragraphs.length > 0 && (
              <div className="details__desc" data-nav tabIndex={0} aria-label="Opis gry">
                {paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            )}
            {presentFacts.length > 0 && (
              <dl className="facts">
                {presentFacts.map(([k, v]) => (
                  <div key={k} className="facts__row">
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
        {details === null && game.source !== 'demo' && (
          <p className="details__loading">
            {game.emu ? 'Wczytywanie opisu z EmuStart…' : game.shortcut ? 'Szukanie w bazie LaunchBox…' : 'Wczytywanie informacji ze sklepu Steam…'}
          </p>
        )}
        {details && !details.ok && game.source !== 'demo' && <p className="details__muted">{details.error}</p>}
        {details?.ok && d?.source === 'launchbox' && (
          <p className="details__muted">
            Opis: LaunchBox Games DB{d.name && d.name !== game.name ? ` · dopasowano „${d.name}”` : ''}
            {d.platform ? ` (${d.platform})` : ''}
          </p>
        )}
        {details?.ok && details.stale && !game.emu && <p className="details__muted">Informacje z pamięci podręcznej (brak połączenia ze sklepem).</p>}
        {details?.ok && d?.source === 'emustart' && <p className="details__muted">Opis i grafiki: biblioteka serwera EmuStart.</p>}
      </div>

      {modal === 'categories' && <CategoryPicker gameId={gameId} onClose={() => setModal(null)} />}
      {modal === 'art' && <ArtPicker game={game} onClose={() => setModal(null)} />}
    </div>,
    document.body
  )
}

function DownloadStatus({ game }: { game: Game }) {
  const p = game.progress
  const total = p ? p.bytesToDownload || p.bytesToStage : 0
  const done = p ? (p.bytesToDownload ? p.bytesDownloaded : p.bytesStaged) : 0
  const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : null
  return (
    <div className="download">
      <div className="download__head">
        <strong>{STATE_LABEL[game.installState]}</strong>
        {pct !== null && (
          <span>
            {pct}% · {formatBytes(done) ?? '0 B'} z {formatBytes(total)}
          </span>
        )}
      </div>
      {pct !== null ? (
        <>
          <div className="download__bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <p className="details__muted">
            Wartości z pliku manifestu Steam — Steam zapisuje je z opóźnieniem, więc dokładny stan widać w oknie pobierania Steam.
          </p>
        </>
      ) : (
        <p className="details__muted">Steam nie podaje jeszcze postępu (gra może czekać w kolejce). Szczegóły w oknie pobierania Steam.</p>
      )}
    </div>
  )
}

/** EmuStart: the one action that fits the game's state, as EmuStart itself would do it. */
function emuPrimary(
  game: Game,
  emu: EmustartSummary | undefined,
  ready: EmuReadiness | null,
  installing: boolean,
  setBusy: (b: boolean) => void
): PrimaryAction {
  const g = game.emu!
  if (!emu || emu.engine !== 'ready')
    return {
      label: emu?.engine === 'starting' ? 'Uruchamianie EmuStart…' : 'EmuStart nie działa',
      disabled: true,
      note: emu?.message ?? 'Silnik EmuStart nie działa — gry z serwera są chwilowo niedostępne (szczegóły w Ustawieniach → EmuStart).'
    }
  const missing = ready?.ok ? ready.missing.find((m) => m.kind === 'emulator') : undefined
  if (installing) return { label: 'Instalowanie emulatora…', disabled: true, note: 'Emulator pobiera się z serwera EmuStart (lista zadań u góry).' }
  if (missing) {
    if (!missing.installable)
      return { label: 'Brak emulatora', disabled: true, note: `Nie ma emulatora dla ${missing.system} na tym komputerze, a serwer EmuStart go nie udostępnia. Wskaż emulator w ustawieniach EmuStart: tryb TV → Menu → Ustawienia → Systemy.` }
    return {
      label: 'Zainstaluj emulator',
      note: `Brak emulatora dla ${missing.system} — pobierze się z serwera EmuStart: ${missing.steps.join(', ')}.`,
      run: async () => {
        setBusy(true)
        const r = await attempt(api().emustart.installEmulators([missing.es]))
        setBusy(false)
        if (r) useStore.getState().toast(r.ok ? (r.message ?? 'Instalacja rozpoczęta') : (r.error ?? 'Błąd'), r.ok ? 'info' : 'error')
      }
    }
  }
  const serverOk = !!emu.server?.ok
  if (!g.cached && !serverOk)
    return {
      label: 'Serwer niedostępny',
      disabled: true,
      note: emu.server
        ? 'Ta gra nie jest pobrana, a serwer EmuStart nie odpowiada. Pobrane gry działają bez serwera.'
        : 'To urządzenie nie jest zalogowane do serwera EmuStart (Ustawienia → EmuStart).'
    }
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = await attempt(api().emustart.launch(game.id))
    setBusy(false)
    if (!r) return
    if (!r.ok) useStore.getState().toast(r.error ?? 'Nie udało się uruchomić gry.', 'error')
    else if (r.message) useStore.getState().toast(r.message, 'info')
  }
  if (g.cached) return { label: 'Graj', run, note: `${g.system}${ready?.ok && ready.emulator ? ` · ${ready.emulator}` : ''}` }
  return {
    label: 'Pobierz i graj',
    run,
    note: `Gra pobierze się z serwera EmuStart (${formatBytes(g.size) ?? '?'}) i uruchomi. Zapisy synchronizuje EmuStart przed i po grze.`
  }
}

function EmuJobStatus({ job }: { job: Job }) {
  const p = job.progress
  const pct = p?.total ? Math.min(100, Math.floor((p.done / p.total) * 100)) : null
  return (
    <div className="download">
      <div className="download__head">
        <strong>{job.phase}</strong>
        {pct !== null && (
          <span>
            {pct}% · {formatBytes(p!.done) ?? '0 B'} z {formatBytes(p!.total)}
            {p?.speed ? ` · ${formatBytes(p.speed)}/s` : ''}
            {formatEta(p?.eta) ? ` · zostało ${formatEta(p?.eta)}` : ''}
          </span>
        )}
      </div>
      {pct !== null && (
        <div className="download__bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {job.message && <p className="details__muted">{job.message}</p>}
      {job.cancellable && (
        <button className="btn btn--sm btn--danger" data-nav onClick={() => void attempt(api().jobs.cancel(job.id))}>
          Anuluj
        </button>
      )}
    </div>
  )
}

function syncLabel(state: string, last: number): string {
  if (state === 'synced') return `zsynchronizowane${last ? ` · ${formatLastPlayed(last) ?? ''}` : ''}`
  if (state === 'pending') return 'czekają na wysłanie (brak połączenia z serwerem)'
  if (state === 'never') return 'jeszcze nie synchronizowane'
  return state
}

/**
 * Regional versions / revisions of one game: which one the entry shows and plays. Shown version
 * is automatic (last played → downloaded → region preference) until the player picks one.
 */
function VersionPicker({ gameId, game, chosen }: { gameId: string; game: Game; chosen?: string }) {
  const versions = game.emu!.versions!
  const shown = game.emu!.shownVersion
  const choose = (id: string | null): void => {
    void attempt(api().emustart.chooseVersion(gameId, id))
  }
  return (
    <div className="versions" data-nav-group="details-versions">
      <div className="versions__head">
        <strong>{versionCountLabel(versions.length)}</strong>
        <span className="details__muted">
          {chosen ? 'wybrana przez Ciebie' : 'automatycznie: ostatnio grana, pobrana albo wg preferowanego regionu (Ustawienia → EmuStart)'}
        </span>
      </div>
      <div className="versions__list">
        {versions.map((v) => (
          <button
            key={v.id}
            className={`version ${v.id === shown ? 'is-shown' : ''}`}
            data-nav
            data-key={`ver-${v.id}`}
            aria-pressed={v.id === shown}
            onClick={() => choose(v.id)}
          >
            <span className="version__tags">{v.tags || 'bez oznaczeń'}</span>
            <span className="version__state">
              {v.copying ? 'pobieranie…' : v.cached ? 'na dysku' : 'na serwerze'}
              {v.discs > 1 ? ` · 💿${v.discs}` : ''}
              {v.lastPlayed ? ' · grana' : ''}
            </span>
          </button>
        ))}
        {chosen && (
          <button className="version version--auto" data-nav data-key="ver-auto" onClick={() => choose(null)}>
            <span className="version__tags">Automatycznie</span>
          </button>
        )}
      </div>
    </div>
  )
}
