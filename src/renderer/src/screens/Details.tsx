import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DetailsResult, Game, Job } from '@shared/types'
import { api, attempt, steamCollectionsOf, useStore } from '../store'
import { useActions } from '../nav/input'
import { focusEl, focusFirst } from '../nav/engine'
import { Art } from '../components/Art'
import { CategoryPicker } from '../modals/CategoryPicker'
import { ArtPicker } from '../modals/ArtPicker'
import { EmuSaves } from '../components/EmuSaves'
import { GameOptions } from '../components/GameOptions'
import { Controllers } from '../components/Controllers'
import { usePrimaryAction } from '../lib/primary'
import { formatBytes, formatEta, formatLastPlayed, formatPlaytime, htmlToParagraphs, STATE_LABEL, stateLabel, versionCountLabel } from '../lib/format'

export function DetailsScreen({ gameId }: { gameId: string }) {
  const game = useStore((s) => s.snapshot?.games.find((g) => g.id === gameId))
  const prefs = useStore((s) => s.prefs)!
  const collections = useStore((s) => s.snapshot?.collections ?? null)
  const close = (): void => useStore.getState().openDetails(null)
  const [details, setDetails] = useState<DetailsResult | null>(null)
  const [modal, setModal] = useState<'categories' | 'art' | 'saves' | 'options' | 'pads' | null>(null)
  const [logoOk, setLogoOk] = useState(true)
  const isEmu = game?.source === 'emustart'
  const emuSummary = useStore((s) => s.snapshot?.emustart)
  const allJobs = useStore((s) => s.jobs.jobs)
  const gameJobs = useMemo(() => allJobs.filter((j) => j.gameId === gameId && j.kind !== 'emuLaunch'), [allJobs, gameId])
  const { primary, busy, ready } = usePrimaryAction(game)
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
          <button className="btn" data-nav data-key="art" onClick={() => setModal('art')}>
            Grafiki
          </button>
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
              <button className="btn" data-nav data-key="saves" onClick={() => setModal('saves')}>
                Zapisy
              </button>
              <button className="btn" data-nav data-key="options" onClick={() => setModal('options')}>
                Opcje gry
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
              {game.appId && emuSummary?.engine === 'ready' && (
                <button className="btn" data-nav data-key="pads" onClick={() => setModal('pads')}>
                  Kontrolery
                </button>
              )}
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
        {details?.ok && d?.source === 'emustart' && <p className="details__muted">Opis: biblioteka serwera EmuStart. Plakat i tło: SteamGridDB, gdy jest klucz (zmiana: „Grafiki”), inaczej grafiki z serwera.</p>}
      </div>

      {modal === 'categories' && <CategoryPicker gameId={gameId} onClose={() => setModal(null)} />}
      {modal === 'art' && <ArtPicker game={game} onClose={() => setModal(null)} />}
      {modal === 'saves' && <EmuSaves game={game} onClose={() => setModal(null)} />}
      {modal === 'options' && <GameOptions game={game} onClose={() => setModal(null)} />}
      {modal === 'pads' && game.appId && (
        <Controllers game={{ id: game.id, name: game.name, key: `steam:${game.appId}` }} onClose={() => setModal(null)} />
      )}
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
