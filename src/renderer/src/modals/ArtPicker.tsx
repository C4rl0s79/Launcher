import { useEffect, useState } from 'react'
import type { ArtKind, ArtOptionsResult, EmuServerArt, Game, LbArtOptionsResult, SgdbGame } from '@shared/types'
import { api, attempt, useStore, pickPath } from '../store'
import { Modal } from '../components/Modal'
import { TextField } from '../components/TextField'

const KINDS: [ArtKind, string][] = [
  ['grid', 'Plakat'],
  ['hero', 'Tło'],
  ['logo', 'Logo'],
  ['icon', 'Ikona']
]

const ZOOM_MIN = 0.6
const ZOOM_MAX = 2.4
const ZOOM_STEP = 0.2
let lastZoom = 1
const isEmuGame = (g: Game): boolean => g.source === 'emustart'

const CHOICE_LABEL: Record<string, string> = {
  sgdb: 'wybrana ze SteamGridDB',
  launchbox: 'wybrana z LaunchBox',
  file: 'plik lokalny',
  steam: 'oficjalna grafika Steam',
  none: 'brak'
}

/** admin: this device's account administers the EmuStart server (art on the server, all devices) */
export function ArtPicker({ game, onClose, admin }: { game: Game; onClose: () => void; admin?: boolean }) {
  const prefs = useStore((s) => s.prefs)!
  const hasKey = useStore((s) => s.settings?.hasSgdbKey)
  const [kind, setKind] = useState<ArtKind>('grid')
  // thumbnail size (LT smaller / RT larger), kept while the program runs
  const [zoom, setZoomState] = useState(lastZoom)
  const setZoom = (z: number): void => {
    lastZoom = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100
    setZoomState(lastZoom)
  }
  const kinds = KINDS.filter(([k]) => !(isEmuGame(game) && k === 'icon'))
  const nextKind = (step: number): void => {
    const i = kinds.findIndex(([k]) => k === kind)
    setKind(kinds[(i + step + kinds.length) % kinds.length][0])
  }
  const [result, setResult] = useState<ArtOptionsResult | null>(null)
  const [searching, setSearching] = useState(false)
  const gp = prefs.art[game.id]
  const current = gp?.[kind]
  const isEmu = game.source === 'emustart'

  useEffect(() => {
    let alive = true
    setResult(null)
    if (!hasKey) {
      setResult({ ok: false, error: 'Dodaj klucz SteamGridDB w Ustawieniach, aby wybierać spośród grafik społeczności.' })
      return
    }
    void api()
      .art.options(game.id, kind)
      .then((r) => alive && setResult(r))
      .catch(() => alive && setResult({ ok: false, error: 'Nie udało się pobrać listy grafik.' }))
    return () => {
      alive = false
    }
  }, [game.id, kind, hasKey, gp?.sgdbGameId])

  const done = (msg: string) => (p: unknown) => p && useStore.getState().toast(msg)

  if (searching) return <MatchSearch game={game} onClose={() => setSearching(false)} />

  return (
    <Modal
      title={`Grafiki — ${game.name}`}
      onClose={onClose}
      wide
      className="art-picker"
      handlers={{
        lb: () => (nextKind(-1), true),
        rb: () => (nextKind(1), true),
        lt: () => (setZoom(zoom - ZOOM_STEP), true),
        rt: () => (setZoom(zoom + ZOOM_STEP), true)
      }}
      hints={[
        { action: 'confirm', label: 'Wybierz' },
        { action: 'rb', label: 'Rodzaj grafiki' },
        { action: 'rt', label: 'Większe / mniejsze' },
        { action: 'back', label: 'Zamknij' }
      ]}
    >
      <style>{`.art-picker .thumbs { --thumb-zoom: ${zoom}; }`}</style>
      <div className="segmented" role="tablist">
        {kinds.map(([k, label]) => (
          <button key={k} className={`seg ${kind === k ? 'is-on' : ''}`} data-nav data-autofocus={k === kind || undefined} onClick={() => setKind(k)}>
            {label}
          </button>
        ))}
      </div>
      <p className="details__muted">
        Obecnie: {current ? (isEmu && current.type === 'steam' ? 'grafika z serwera EmuStart' : CHOICE_LABEL[current.type]) : 'automatycznie'}
        {result?.ok && result.sgdbGame && ` · SteamGridDB: ${result.sgdbGame.name}`}
      </p>
      <div className="modal__row">
        <button
          className="btn"
          data-nav
          onClick={async () => {
            const file = await pickPath({ kind: 'file', title: 'Własny plik graficzny', extensions: ['png', 'jpg', 'jpeg', 'webp'] })
            if (file) void attempt(api().art.useFile(game.id, kind, file)).then(done('Ustawiono własny plik'))
          }}
        >
          Wybierz plik…
        </button>
        {game.source === 'steam' && kind !== 'icon' && (
          <button className="btn" data-nav onClick={() => void attempt(api().art.useSteam(game.id, kind)).then(done('Użyto grafiki Steam'))}>
            Oficjalna grafika Steam
          </button>
        )}
        {isEmu && kind !== 'icon' && (
          <button
            className="btn"
            data-nav
            onClick={() => void attempt(api().art.useSteam(game.id, kind)).then(done('Użyto grafiki z serwera EmuStart'))}
          >
            Grafika z serwera EmuStart
          </button>
        )}
        <button
          className="btn"
          data-nav
          disabled={!current}
          onClick={() => void attempt(api().art.reset(game.id, kind)).then(done('Przywrócono automatyczny wybór'))}
        >
          Przywróć automatyczne
        </button>
        {hasKey && (
          <button className="btn" data-nav onClick={() => setSearching(true)}>
            Zmień dopasowanie gry
          </button>
        )}
      </div>
      {!result && <p className="details__loading">Wczytywanie grafik ze SteamGridDB…</p>}
      {result && !result.ok && <p className="details__muted">{result.error}</p>}
      {result?.ok && result.options.length === 0 && (
        <p className="details__muted">SteamGridDB nie ma grafik tego typu dla tej gry. Spróbuj „Zmień dopasowanie gry” albo wybierz plik.</p>
      )}
      {result?.ok && result.options.length > 0 && (
        <div className={`thumbs thumbs--${kind}`} data-nav-group={`thumbs-${kind}`}>
          {result.options.slice(0, 48).map((o) => {
            const chosen = current?.type === 'sgdb' && current.imageId === o.id
            return (
              <button
                key={o.id}
                className={`thumb ${chosen ? 'is-on' : ''}`}
                data-nav
                data-key={`t-${o.id}`}
                title={o.author ? `Autor: ${o.author}` : undefined}
                onClick={() => void attempt(api().art.choose(game.id, kind, o)).then(done('Zapisano wybór grafiki'))}
              >
                <img src={o.thumb} alt="" loading="lazy" decoding="async" />
                {o.style && <span className="thumb__tag">{o.style}</span>}
              </button>
            )
          })}
        </div>
      )}
      {isEmu && kind !== 'icon' && <LaunchBoxThumbs game={game} kind={kind} chosen={current?.type === 'launchbox' ? current.url : undefined} />}
      {isEmu && admin && kind !== 'icon' && <ServerArt game={game} kind={kind} />}
      <div className="modal__footer">
        <button className="btn btn--primary" data-nav onClick={onClose}>
          Gotowe
        </button>
      </div>
    </Modal>
  )
}

/** LaunchBox Games DB images of an EmuStart game: box fronts (by region), backgrounds, logos… */
const SERVER_KIND: Record<'grid' | 'hero' | 'logo', 'box' | 'snap' | 'logo'> = { grid: 'box', hero: 'snap', logo: 'logo' }
const SERVER_LABEL = { box: 'okładka', snap: 'zrzut ekranu', logo: 'logo gry' }

/**
 * Administrator of the EmuStart server: the game's art on the server (box / screenshot / logo) —
 * every device sees it; EmuStart's own art sources (SteamGridDB, IGDB, TheGamesDB…).
 */
// the server image picked on this computer (the server's list does not say which one is set)
const pickedKey = (gameId: string, sk: string): string => `lumen.serverArt.${gameId}|${sk}`
function readPicked(gameId: string, sk: string): string | null {
  try {
    return localStorage.getItem(pickedKey(gameId, sk))
  } catch {
    return null
  }
}

function ServerArt({ game, kind }: { game: Game; kind: ArtKind }) {
  const sk = SERVER_KIND[kind as 'grid' | 'hero' | 'logo']
  const [list, setList] = useState<EmuServerArt[] | null>(null)
  // marked only while this device shows the server's art (not after another choice)
  const showsServer = useStore((s) => s.prefs?.art[game.id]?.[kind]?.type === 'steam')
  const [picked, setPicked] = useState(() => readPicked(game.id, sk))
  useEffect(() => setPicked(readPicked(game.id, sk)), [game.id, sk])
  useEffect(() => {
    let alive = true
    setList(null)
    void api()
      .emustart.serverArt(game.id, sk)
      .then((r) => alive && setList(r))
      .catch(() => alive && setList([]))
    return () => {
      alive = false
    }
  }, [game.id, sk])
  const done = (msg: string) => (r: { ok: boolean; message?: string; error?: string } | null | undefined) =>
    r && useStore.getState().toast(r.ok ? (r.message ?? msg) : (r.error ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
  return (
    <>
      <h3 className="saves__h">Serwer EmuStart — {SERVER_LABEL[sk]} dla wszystkich urządzeń (administrator)</h3>
      <div className="modal__row">
        <button className="btn" data-nav onClick={() => void attempt(api().emustart.serverArtClear(game.id, sk)).then(done('Usunięto'))}>
          Usuń z serwera
        </button>
      </div>
      {!list && <p className="details__loading">Szukam grafik na serwerze…</p>}
      {list?.length === 0 && <p className="details__muted">Serwer nie znalazł grafik tego rodzaju.</p>}
      {!!list?.length && (
        <div className={`thumbs thumbs--${kind}`} data-nav-group={`srv-${kind}`}>
          {list.slice(0, 48).map((o) => (
            <button
              key={o.url}
              className={`thumb thumb--fit ${showsServer && picked === o.url ? 'is-on' : ''}`}
              data-nav
              title={o.source}
              onClick={async () => {
                const r = await attempt(api().emustart.serverArtChoose(game.id, sk, o.url))
                done('Zapisano na serwerze')(r)
                // shown here at once: the server's art beats an automatic SteamGridDB / LaunchBox pick
                if (!r?.ok) return
                try {
                  localStorage.setItem(pickedKey(game.id, sk), o.url)
                } catch {
                  /* no browser storage — just not marked next time */
                }
                setPicked(o.url)
                await attempt(api().art.useSteam(game.id, kind))
              }}
            >
              {o.thumb ? <img src={o.thumb} alt="" loading="lazy" decoding="async" /> : <span className="thumb__tag">{o.source ?? 'grafika'}</span>}
              {o.source && <span className="thumb__tag">{o.source}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function LaunchBoxThumbs({ game, kind, chosen }: { game: Game; kind: ArtKind; chosen?: string }) {
  const [res, setRes] = useState<LbArtOptionsResult | null>(null)
  useEffect(() => {
    let alive = true
    setRes(null)
    void api()
      .art.launchboxOptions(game.id, kind)
      .then((r) => alive && setRes(r))
      .catch(() => alive && setRes({ ok: false, error: 'Nie udało się odczytać grafik LaunchBox.' }))
    return () => {
      alive = false
    }
  }, [game.id, kind])
  return (
    <>
      <h3 className="saves__h">LaunchBox Games DB</h3>
      {!res && <p className="details__loading">Wczytywanie…</p>}
      {res && !res.ok && <p className="details__muted">{res.error}</p>}
      {res?.ok && res.options.length === 0 && <p className="details__muted">LaunchBox nie ma grafik tego typu dla tej gry.</p>}
      {res?.ok && res.options.length > 0 && (
        <div className={`thumbs thumbs--${kind}`} data-nav-group={`lb-${kind}`}>
          {res.options.map((o) => (
            <button
              key={o.url}
              className={`thumb thumb--fit ${chosen === o.url ? 'is-on' : ''}`}
              data-nav
              title={`${o.type}${o.region ? ` · ${o.region}` : ''}`}
              onClick={() =>
                void attempt(api().art.chooseLaunchbox(game.id, kind, o.url)).then((p) => p && useStore.getState().toast('Zapisano wybór grafiki'))
              }
            >
              <img src={o.url} alt="" loading="lazy" decoding="async" />
              <span className="thumb__tag">
                {o.type.replace(/^(Box|Fanart|Screenshot|Cart) - /, '')}
                {o.region ? ` · ${o.region}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function MatchSearch({ game, onClose }: { game: Game; onClose: () => void }) {
  const prefs = useStore((s) => s.prefs)!
  const [term, setTerm] = useState(game.name)
  const [results, setResults] = useState<SgdbGame[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const manual = prefs.art[game.id]?.sgdbGameId

  const search = async (t: string): Promise<void> => {
    setError(null)
    setResults(null)
    const r = await attempt(api().art.search(t))
    if (!r) return
    if (r.ok) setResults(r.games)
    else setError(r.error)
  }
  useEffect(() => void search(game.name), []) // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (g: SgdbGame | null): Promise<void> => {
    const p = await attempt(api().art.setMatch(game.id, g))
    if (p) {
      useStore
        .getState()
        .toast(
          g
            ? `Dopasowano do „${g.name}”`
            : game.source === 'steam'
              ? 'Przywrócono dopasowanie po identyfikatorze Steam'
              : 'Przywrócono automatyczne dopasowanie po tytule'
        )
      onClose()
    }
  }

  return (
    <Modal title="Dopasowanie w SteamGridDB" onClose={onClose}>
      <div className="modal__row">
        <TextField label="Szukaj w SteamGridDB" value={term} onChange={setTerm} onSubmit={(t) => void search(t)} />
        <button className="btn" data-nav onClick={() => void search(term)}>
          Szukaj
        </button>
      </div>
      {manual && (
        <button className="btn btn--ghost" data-nav onClick={() => void choose(null)}>
          Użyj automatycznego dopasowania ({game.source === 'steam' ? 'po ID Steam' : 'po tytule'})
        </button>
      )}
      {error && <p className="details__muted">{error}</p>}
      {!results && !error && <p className="details__loading">Szukanie…</p>}
      {results?.length === 0 && <p className="details__muted">Brak wyników.</p>}
      <div className="list">
        {results?.map((g, i) => (
          <button
            key={g.id}
            className={`list__item ${manual === g.id ? 'is-on' : ''}`}
            data-nav
            data-autofocus={i === 0 || undefined}
            onClick={() => void choose(g)}
          >
            {g.name}
            <span className="list__meta">
              {g.releaseDate ? new Date(g.releaseDate * 1000).getFullYear() : ''}
              {g.verified ? ' · zweryfikowana' : ''}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
