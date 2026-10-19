import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DetailsResult, Game } from '@shared/types'
import { api, attempt, steamCollectionsOf, useStore } from '../store'
import { useActions } from '../nav/input'
import { focusEl, focusFirst } from '../nav/engine'
import { Art } from '../components/Art'
import { CategoryPicker } from '../modals/CategoryPicker'
import { ArtPicker } from '../modals/ArtPicker'
import { formatBytes, formatLastPlayed, formatPlaytime, htmlToParagraphs, STATE_LABEL } from '../lib/format'

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
  const ref = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)

  useEffect(() => {
    let alive = true
    // only Steam store apps have store metadata
    if (!gameId.startsWith('steam:')) return
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
  }, [game, gameId, steamStatus])

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
  const paragraphs = d?.descriptionHtml ? htmlToParagraphs(d.descriptionHtml) : d?.shortDescription ? [d.shortDescription] : []
  const facts: [string, string | undefined][] = [
    ['Gatunki', d?.genres?.join(', ')],
    ['Premiera', d?.releaseDate],
    ['Producent', d?.developers?.join(', ')],
    ['Wydawca', d?.publishers?.join(', ')],
    ['Rozmiar na dysku', game.installed ? formatBytes(game.sizeOnDisk) : undefined],
    ['Biblioteka', game.installed ? game.libraryPath : undefined],
    ['Platforma', game.shortcut?.tags.join(', ') || undefined],
    ['Źródło', game.shortcut ? 'Skrót spoza Steam (uruchamiany przez Steam)' : undefined]
  ]
  const presentFacts = facts.filter((f): f is [string, string] => !!f[1])
  const chips = [
    { label: game.running ? 'Uruchomiona' : STATE_LABEL[game.installState], tone: game.installed ? 'ok' : 'muted' },
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

        {(game.installState === 'installing' || game.installState === 'updating' || game.installState === 'updatePaused') && (
          <DownloadStatus game={game} />
        )}

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
        {details === null && game.source === 'steam' && <p className="details__loading">Wczytywanie informacji ze sklepu Steam…</p>}
        {details && !details.ok && game.source === 'steam' && <p className="details__muted">{details.error}</p>}
        {details?.ok && details.stale && <p className="details__muted">Informacje z pamięci podręcznej (brak połączenia ze sklepem).</p>}
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
