import { useEffect, useState } from 'react'
import type { ArtKind, ArtOptionsResult, Game, SgdbGame } from '@shared/types'
import { api, attempt, useStore, pickPath } from '../store'
import { Modal } from '../components/Modal'
import { TextField } from '../components/TextField'

const KINDS: [ArtKind, string][] = [
  ['grid', 'Plakat'],
  ['hero', 'Tło'],
  ['logo', 'Logo'],
  ['icon', 'Ikona']
]

const CHOICE_LABEL: Record<string, string> = {
  sgdb: 'wybrana ze SteamGridDB',
  file: 'plik lokalny',
  steam: 'oficjalna grafika Steam',
  none: 'brak'
}

export function ArtPicker({ game, onClose }: { game: Game; onClose: () => void }) {
  const prefs = useStore((s) => s.prefs)!
  const hasKey = useStore((s) => s.settings?.hasSgdbKey)
  const [kind, setKind] = useState<ArtKind>('grid')
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
    <Modal title={`Grafiki — ${game.name}`} onClose={onClose} wide>
      <div className="segmented" role="tablist">
        {KINDS.map(([k, label]) => (
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
          <button className="btn" data-nav onClick={() => void attempt(api().art.useSteam(game.id, kind)).then(done('Użyto grafiki z serwera EmuStart'))}>
            Grafika z serwera EmuStart
          </button>
        )}
        <button className="btn" data-nav disabled={!current} onClick={() => void attempt(api().art.reset(game.id, kind)).then(done('Przywrócono automatyczny wybór'))}>
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
      <div className="modal__footer">
        <button className="btn btn--primary" data-nav onClick={onClose}>
          Gotowe
        </button>
      </div>
    </Modal>
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
      useStore.getState().toast(g ? `Dopasowano do „${g.name}”` : game.source === 'steam' ? 'Przywrócono dopasowanie po identyfikatorze Steam' : 'Przywrócono automatyczne dopasowanie po tytule')
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
          <button key={g.id} className={`list__item ${manual === g.id ? 'is-on' : ''}`} data-nav data-autofocus={i === 0 || undefined} onClick={() => void choose(g)}>
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
