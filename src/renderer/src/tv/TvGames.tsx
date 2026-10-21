import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DetailsResult, Game } from '@shared/types'
import { api, useStore } from '../store'
import { useActions } from '../nav/input'
import { Art } from '../components/Art'
import { OnScreenKeyboard } from '../components/TextField'
import { GameOptions } from '../components/GameOptions'
import { usePrimaryAction } from '../lib/primary'
import { formatBytes, formatLastPlayed, plural, formatPlaytime, htmlToParagraphs, stateLabel, versionCountLabel } from '../lib/format'
import type { TvSystem } from './data'

// Game list of one system (EmuStart look): titles on the left, cover | details | screenshot on the
// right, the description below. The main action is the same as in the desktop details
// (usePrimaryAction); "Opcje gry" (X) opens the same details (saves, art, versions, favourite) for
// now. View is not used: View+Start switches the interface.

const details: Record<string, DetailsResult> = {}

function useDetails(game: Game | undefined): DetailsResult | null {
  const [d, setD] = useState<DetailsResult | null>(null)
  useEffect(() => {
    if (!game) return setD(null)
    if (details[game.id]) return setD(details[game.id])
    setD(null)
    let alive = true
    const t = setTimeout(() => {
      void api()
        .game.details(game.id)
        .then((r) => {
          details[game.id] = r
          if (alive) setD(r)
        })
        .catch(() => undefined)
    }, 220) // fast scrolling does not fetch every row on the way
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [game])
  return d
}

const letterOf = (g: Game): string => {
  const c = g.name.trim().charAt(0).toUpperCase()
  return /[A-ZĄĆĘŁŃÓŚŹŻ]/.test(c) ? c : '#'
}

export function TvGames({ system, onBack, onMenu, active }: { system: TvSystem; onBack: () => void; onMenu: () => void; active: boolean }) {
  const favorites = useStore((s) => s.prefs?.favorites)
  const opened = useStore((s) => s.uiSelection)
  const [query, setQuery] = useState('')
  const [osk, setOsk] = useState(false)
  const [options, setOptions] = useState(false)
  const games = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? system.games.filter((g) => g.name.toLowerCase().includes(q)) : system.games
  }, [system.games, query])
  const [idx, setIdx] = useState(() => Math.max(0, system.games.findIndex((g) => g.id === opened)))
  const sel = games[Math.min(idx, games.length - 1)]
  const { primary, busy } = usePrimaryAction(sel)
  const d = useDetails(sel)

  // rows: only the visible window is rendered (systems can have thousands of games)
  const rowsRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(15)
  const [top, setTop] = useState(0)
  useLayoutEffect(() => {
    const el = rowsRef.current
    if (!el) return
    const measure = (): void => {
      const rh = parseFloat(getComputedStyle(el).getPropertyValue('--tv-row-px')) || el.clientHeight / 15
      setVisible(Math.max(3, Math.floor(el.clientHeight / rh)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (idx < top) setTop(idx)
    else if (idx >= top + visible) setTop(idx - visible + 1)
  }, [idx, top, visible])
  useEffect(() => {
    if (idx >= games.length) setIdx(Math.max(0, games.length - 1))
  }, [games.length, idx])
  // the selected game travels to the desktop layout when the mode switches
  useEffect(() => {
    if (sel) api().ui.select(sel.id)
  }, [sel])

  const go = (i: number): boolean => {
    if (games.length) setIdx(Math.max(0, Math.min(games.length - 1, i)))
    return true
  }
  const jumpLetter = (dir: 1 | -1): boolean => {
    if (!sel) return true
    const cur = letterOf(sel)
    for (let i = idx + dir; i >= 0 && i < games.length; i += dir) {
      if (letterOf(games[i]) !== cur) {
        // backwards: the first game of that letter
        if (dir < 0) {
          const l = letterOf(games[i])
          while (i > 0 && letterOf(games[i - 1]) === l) i--
        }
        return go(i)
      }
    }
    return go(dir > 0 ? games.length - 1 : 0)
  }
  const play = (): boolean => {
    if (!primary || busy) return true
    if (primary.disabled || !primary.run) useStore.getState().toast(primary.note ?? primary.label, 'info')
    else void primary.run()
    return true
  }

  useActions(
    {
      up: () => go(idx - 1),
      down: () => go(idx + 1),
      left: () => true,
      right: () => true,
      lb: () => go(idx - visible),
      rb: () => go(idx + visible),
      lt: () => jumpLetter(-1),
      rt: () => jumpLetter(1),
      confirm: play,
      x: () => {
        // EmuStart games: game options (the same window as on the desktop); Steam: details
        if (sel?.emu) setOptions(true)
        else if (sel) useStore.getState().openDetails(sel.id)
        return true
      },
      y: () => {
        setOsk(true)
        return true
      },
      view: () => true,
      back: () => {
        if (query) setQuery('')
        else onBack()
        return true
      },
      menu: () => {
        onMenu()
        return true
      }
    },
    {
      enabled: active && !osk && !options,
      hints: [
        { action: 'confirm', label: primary?.label ?? 'Graj' },
        { action: 'x', label: 'Opcje gry' },
        { action: 'y', label: query ? `Szukaj: „${query}”` : 'Szukaj' },
        { action: 'lb', label: 'Strona' },
        { action: 'rt', label: 'Litera' },
        { action: 'back', label: query ? 'Wyczyść' : 'Wstecz' },
        { action: 'menu', label: 'Menu' }
      ]
    }
  )

  return (
    <section className="tv-screen tv-games">
      <div className="tv-gamelist">
        <div className="tv-listhead">
          {system.logo ? <img src={api().art.url(`emusys:${system.key}`, 'logo')} alt="" draggable={false} /> : <h2>{system.display}</h2>}
          <div className="tv-lhtext">
            <p>
              {games.length} {plural(games.length, 'gra', 'gry', 'gier')}
              {query ? ` · „${query}”` : ''}
            </p>
          </div>
        </div>
        <div className="tv-rows" ref={rowsRef}>
          {games.slice(top, top + visible + 1).map((g, i) => (
            <TvRow key={g.id} game={g} sel={top + i === idx} fav={!!favorites?.includes(g.id)} onClick={() => (top + i === idx ? play() : setIdx(top + i))} />
          ))}
          {!games.length && <p className="tv-dim">Brak gier{query ? ` dla „${query}”` : ''}.</p>}
        </div>
      </div>
      {sel && <TvPreview game={sel} details={d} note={primary?.note} />}
      {options && sel && <GameOptions game={sel} onClose={() => setOptions(false)} />}
      {osk && (
        <OnScreenKeyboard
          label={`Szukaj — ${system.display}`}
          initial={query}
          secret={false}
          onChange={setQuery}
          onClose={() => {
            setOsk(false)
            setIdx(0)
          }}
        />
      )}
    </section>
  )
}

function TvRow({ game, sel, fav, onClick }: { game: Game; sel: boolean; fav: boolean; onClick: () => void }) {
  const e = game.emu
  return (
    <div className={`tv-row ${sel ? 'sel' : ''}`} onClick={onClick}>
      <span className="t">{game.name}</span>
      {e?.tags && <span className="g">{e.tags}</span>}
      <span className="ic">
        {fav && <span className="tv-tag f">★</span>}
        {e && e.discs > 1 && <span className="tv-tag">💿{e.discs}</span>}
        {e?.versions && <span className="tv-tag">{versionCountLabel(e.versions.length)}</span>}
        {e?.pinned && <span className="tv-tag p">📌</span>}
        {e?.copying && <span className="tv-tag d">pobieranie</span>}
        {e ? e.cached && <span className="tv-tag c">lokalnie</span> : game.installed && <span className="tv-tag c">zainstalowana</span>}
        {game.running && <span className="tv-tag d">w grze</span>}
      </span>
    </div>
  )
}

function TvPreview({ game, details: dr, note }: { game: Game; details: DetailsResult | null; note?: string }) {
  const [boxOk, setBoxOk] = useState(true)
  const [snapOk, setSnapOk] = useState(true)
  const [logoOk, setLogoOk] = useState(true)
  const [asLogo, setAsLogo] = useState(false)
  // re-read after a settings change (the library snapshot changes with it)
  const emuSnap = useStore((s) => s.snapshot?.emustart)
  useEffect(() => {
    setBoxOk(true)
    setSnapOk(true)
    setLogoOk(true)
  }, [game.id])
  // EmuStart's "Tytuły gier jako logo" (Ustawienia → Biblioteka EmuStart → Tryb TV)
  useEffect(() => {
    if (emuSnap?.engine !== 'ready') return
    void api()
      .emustart.options()
      .then((o) => setAsLogo(o.gamesLogo))
      .catch(() => undefined)
  }, [emuSnap])
  const d = dr?.ok ? dr.details : undefined
  const e = game.emu
  const status = e
    ? e.copying
      ? 'pobieranie…'
      : e.pinned
        ? 'zachowana na dysku'
        : e.cached
          ? 'pobrana'
          : 'na serwerze'
    : stateLabel(game)
  const rows: [string, string | undefined][] = [
    ['Status', status],
    ['Rozmiar', e ? formatBytes(e.size) : formatBytes(game.sizeOnDisk)],
    ['Ostatnio', formatLastPlayed(game.lastPlayed) ?? 'nigdy'],
    ['Czas gry', formatPlaytime(game.playtimeMinutes) ?? '–'],
    ['Gatunek', d?.genres?.join(', ') || e?.genre],
    ['Rok', d?.releaseDate || e?.year],
    ['Producent', d?.developers?.join(', ')],
    ['Wydawca', d?.publishers?.join(', ')],
    ['Gracze', d?.players],
    ['Płyty', e && e.discs > 1 ? String(e.discs) : undefined],
    ['Wersje', e?.versions ? `${e.versions.length} — wybór w opcjach gry` : undefined]
  ]
  const desc = d?.descriptionText ? d.descriptionText.split(/\n+/) : d?.descriptionHtml ? htmlToParagraphs(d.descriptionHtml, 6) : d?.shortDescription ? [d.shortDescription] : []
  return (
    <div className="tv-preview">
      <div className="tv-box">
        {boxOk ? (
          <Art key={`b-${game.id}`} gameId={game.id} name={game.name} kind="grid" className="tv-boxart" fallback="none" eager onState={setBoxOk} />
        ) : (
          <div className="tv-noart">brak okładki</div>
        )}
      </div>
      <div className="tv-meta">
        {asLogo && game.emu && logoOk ? (
          <Art key={`l-${game.id}`} gameId={game.id} name={game.name} kind="logo" className="tv-gamelogo" fallback="none" eager onState={setLogoOk} />
        ) : (
          <h1>{game.name}</h1>
        )}
        {e?.tags && <p className="tags">{e.tags}</p>}
        <dl>
          {rows
            .filter((r): r is [string, string] => !!r[1])
            .map(([k, v]) => (
              <div key={k} className="tv-dlrow">
                <dt>{k}</dt>
                <dd className={k === 'Status' ? (e?.cached || game.installed ? 'st-c' : 'st-n') : undefined}>{v}</dd>
              </div>
            ))}
        </dl>
        {note && <p className="tv-note">{note}</p>}
      </div>
      <div className="tv-snap">{snapOk && <Art key={`s-${game.id}`} gameId={game.id} name={game.name} kind="hero" className="tv-snapart" fallback="none" eager onState={setSnapOk} />}</div>
      <div className="tv-desc">
        {desc.slice(0, 6).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        {game.source !== 'emustart' && !desc.length && <p>Gra z biblioteki Steam.</p>}
      </div>
    </div>
  )
}
