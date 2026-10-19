import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Game } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { useActions } from '../nav/input'
import { Art } from '../components/Art'
import { LibraryNotice } from '../components/LibraryNotice'
import { PosterGridRows, toggleFavoriteOfFocused } from '../components/PosterGrid'
import { formatLastPlayed, formatPlaytime, STATE_LABEL } from '../lib/format'

// Start: a featured game on top and two Steam-style poster grids — recently played and
// recently added. Everything else lives in the group tabs of the top bar.

const SECTION_ROWS = 2

export function HomeScreen({ active }: { active: boolean }) {
  const snapshot = useStore((s) => s.snapshot)!
  const prefs = useStore((s) => s.prefs)!
  const openDetails = useStore((s) => s.openDetails)
  const [spot, setSpot] = useState<Game | null>(null)

  const recent = useMemo(
    () =>
      snapshot.games
        .filter((g) => g.lastPlayed)
        .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
        .slice(0, 40),
    [snapshot.games]
  )
  const added = useMemo(
    () =>
      snapshot.games
        .filter((g) => g.addedAt)
        .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
        .slice(0, 40),
    [snapshot.games]
  )

  // keep the spotlight in sync with live data (install state, running…)
  const spotGame = spot ? (snapshot.games.find((g) => g.id === spot.id) ?? null) : null
  const shown = spotGame ?? recent[0] ?? added[0] ?? null

  const onFocusGame = useCallback((g: Game) => setSpot(g), [])
  const favs = useMemo(() => new Set(prefs.favorites), [prefs.favorites])
  const open = useCallback((g: Game) => openDetails(g.id), [openDetails])

  useActions(
    { x: toggleFavoriteOfFocused },
    {
      enabled: active,
      hints: [
        { action: 'confirm', label: 'Otwórz' },
        { action: 'x', label: 'Ulubiona' },
        { action: 'y', label: 'Szukaj' },
        { action: 'rb', label: 'Grupy' },
        { action: 'menu', label: 'Ustawienia' }
      ]
    }
  )

  return (
    <div className="home">
      <Spotlight game={shown} />
      <div className="home__sections" data-scroll="center">
        <LibraryNotice compact />
        {snapshot.games.length === 0 && <EmptyLibrary />}
        {recent.length > 0 && (
          <section className="section">
            <h2 className="section__title">Ostatnio grane</h2>
            <PosterGridRows games={recent} favs={favs} onOpen={open} onFocusGame={onFocusGame} navGroup="home-recent" rows={SECTION_ROWS} autofocusFirst />
          </section>
        )}
        {snapshot.games.length > 0 && (
          <section className="section">
            <h2 className="section__title">Nowo dodane</h2>
            {added.length > 0 ? (
              <PosterGridRows
                games={added}
                favs={favs}
                onOpen={open}
                onFocusGame={onFocusGame}
                navGroup="home-added"
                rows={SECTION_ROWS}
                autofocusFirst={recent.length === 0}
              />
            ) : (
              <p className="section__empty">
                Steam nie udostępnia dat zakupu, więc Lumen zapisuje, kiedy gra pierwszy raz pojawiła się w bibliotece. Gry dodane od
                teraz będą widoczne tutaj.
              </p>
            )}
          </section>
        )}
        <div className="home__spacer" />
      </div>
    </div>
  )
}

function Spotlight({ game }: { game: Game | null }) {
  // debounce so fast movement through the grid doesn't thrash big hero images
  const [shown, setShown] = useState(game)
  useEffect(() => {
    const t = setTimeout(() => setShown(game), 160)
    return () => clearTimeout(t)
  }, [game])
  const [logoOk, setLogoOk] = useState(true)
  useEffect(() => setLogoOk(true), [shown?.id])

  if (!shown) return <div className="spotlight spotlight--empty" />
  const meta = [
    shown.running ? 'Uruchomiona' : STATE_LABEL[shown.installState],
    formatPlaytime(shown.playtimeMinutes) && `Czas gry: ${formatPlaytime(shown.playtimeMinutes)}`,
    formatLastPlayed(shown.lastPlayed) && `Ostatnio: ${formatLastPlayed(shown.lastPlayed)}`,
    shown.shortcut?.tags.length ? shown.shortcut.tags.join(', ') : undefined
  ].filter(Boolean)

  return (
    <div className="spotlight">
      <div className="spotlight__bg" key={shown.id}>
        <Art gameId={shown.id} name={shown.name} kind="hero" fallback="hero" eager />
      </div>
      <div className="spotlight__shade" />
      <div className="spotlight__info" key={`i-${shown.id}`}>
        {logoOk ? (
          <Art gameId={shown.id} name={shown.name} kind="logo" className="spotlight__logo" fallback="none" eager onState={setLogoOk} />
        ) : (
          <h1 className="spotlight__title">{shown.name}</h1>
        )}
        <div className="spotlight__meta">
          {meta.map((m) => (
            <span key={m as string}>{m}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

function EmptyLibrary() {
  const snapshot = useStore((s) => s.snapshot)!
  const setTab = useStore((s) => s.setTab)
  const notInstalled = snapshot.steam.status === 'notInstalled'
  return (
    <div className="empty">
      <h2>{notInstalled ? 'Nie znaleziono Steam' : 'Nie wykryto żadnych gier'}</h2>
      <p>
        {notInstalled
          ? 'Lumen nie znalazł instalacji klienta Steam. Zainstaluj Steam albo włącz dane demonstracyjne, aby obejrzeć interfejs.'
          : 'W bibliotekach Steam na tym komputerze nie ma zainstalowanych gier. Dodaj klucz Steam Web API w ustawieniach, aby zobaczyć całą bibliotekę konta.'}
      </p>
      <div className="empty__actions">
        <button className="btn btn--primary" data-nav data-autofocus onClick={() => setTab('settings')}>
          Otwórz ustawienia
        </button>
        <button className="btn" data-nav onClick={() => void attempt(api().library.refresh(true))}>
          Odśwież
        </button>
      </div>
    </div>
  )
}
