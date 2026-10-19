import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Category, Game } from '@shared/types'
import { api, attempt, gamesForCategory, sortedCategories, useStore } from '../store'
import { useActions } from '../nav/input'
import { currentFocus } from '../nav/engine'
import { Poster } from '../components/Poster'
import { Art } from '../components/Art'
import { LibraryNotice } from '../components/LibraryNotice'
import { formatLastPlayed, formatPlaytime, gameCountLabel, STATE_LABEL } from '../lib/format'

export function HomeScreen({ active }: { active: boolean }) {
  const snapshot = useStore((s) => s.snapshot)!
  const prefs = useStore((s) => s.prefs)!
  const openDetails = useStore((s) => s.openDetails)
  const [spot, setSpot] = useState<Game | null>(null)

  const rows = useMemo(() => {
    return sortedCategories(prefs)
      .filter((c) => c.pinned)
      .map((c) => ({ cat: c, games: gamesForCategory(c, snapshot.games, prefs) }))
      .filter((r) => r.games.length || r.cat.kind === 'custom' || r.cat.smart === 'favorites')
  }, [prefs, snapshot.games])

  // keep the spotlight in sync with live data (install state, running…)
  const spotGame = spot ? (snapshot.games.find((g) => g.id === spot.id) ?? null) : null
  const firstGame = rows.find((r) => r.games.length)?.games[0] ?? null
  const shown = spotGame ?? firstGame

  const onFocusGame = useCallback((g: Game) => setSpot(g), [])
  const favs = useMemo(() => new Set(prefs.favorites), [prefs.favorites])

  useActions(
    {
      x: () => {
        const id = currentFocus()?.dataset.key
        if (!id || !snapshot.games.some((g) => g.id === id)) return false
        void attempt(api().prefs.toggleFavorite(id)).then((p) =>
          p && useStore.getState().toast(p.favorites.includes(id) ? 'Dodano do ulubionych' : 'Usunięto z ulubionych')
        )
        return true
      }
    },
    {
      enabled: active,
      hints: [
        { action: 'confirm', label: 'Otwórz' },
        { action: 'x', label: 'Ulubiona' },
        { action: 'y', label: 'Szukaj' },
        { action: 'rb', label: 'Biblioteka' },
        { action: 'menu', label: 'Ustawienia' }
      ]
    }
  )

  const empty = snapshot.games.length === 0

  return (
    <div className="home">
      <Spotlight game={shown} />
      <div className="home__rows" data-scroll="center">
        <LibraryNotice compact />
        {empty && <EmptyLibrary />}
        {rows.map(({ cat, games }, i) => (
          <Row key={cat.id} cat={cat} games={games} favs={favs} first={i === 0} onOpen={(g) => openDetails(g.id)} onFocusGame={onFocusGame} />
        ))}
        <div className="home__spacer" />
      </div>
    </div>
  )
}

function Row({
  cat,
  games,
  favs,
  first,
  onOpen,
  onFocusGame
}: {
  cat: Category
  games: Game[]
  favs: Set<string>
  first: boolean
  onOpen: (g: Game) => void
  onFocusGame: (g: Game) => void
}) {
  return (
    <section className="row" data-nav-group={`row-${cat.id}`}>
      <header className="row__head">
        <h2>{cat.name}</h2>
        <span className="row__count">{gameCountLabel(games.length)}</span>
      </header>
      {games.length ? (
        <div className="row__track">
          {games.map((g, i) => (
            <Poster key={g.id} game={g} favorite={favs.has(g.id)} onOpen={onOpen} onFocusGame={onFocusGame} autofocus={first && i === 0} />
          ))}
        </div>
      ) : (
        <div className="row__empty">
          {cat.smart === 'favorites'
            ? 'Brak ulubionych. Naciśnij X (lub F) na plakacie, aby dodać grę.'
            : 'Ta kategoria jest pusta. Przypisz gry w ekranie szczegółów gry → „Kategorie”.'}
        </div>
      )}
    </section>
  )
}

function Spotlight({ game }: { game: Game | null }) {
  // debounce so fast scrolling through a row doesn't thrash big hero images
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
    formatLastPlayed(shown.lastPlayed) && `Ostatnio: ${formatLastPlayed(shown.lastPlayed)}`
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
