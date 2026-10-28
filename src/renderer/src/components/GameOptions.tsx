import { useEffect, useRef, useState } from 'react'
import type { EmuGameOptions, EmuMetaField, EmuSettingsChange, Game } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { focusFirst } from '../nav/engine'
import { formatBytes, formatLastPlayed, plural, versionCountLabel } from '../lib/format'
import { usePrimaryAction } from '../lib/primary'
import { Modal } from './Modal'
import { EmuSaves } from './EmuSaves'
import { OnScreenKeyboard } from './TextField'
import { ArtPicker } from '../modals/ArtPicker'
import { Controllers } from './Controllers'

// "Opcje gry" of an EmuStart game — one implementation for both layouts (TV: X on the list,
// desktop: the details' "Opcje gry"), with EmuStart's pages: version (translation), emulator,
// emulator settings (and their history), saves, metadata, art, keep / remove on this PC.

type Page = 'main' | 'versions' | 'variants' | 'emus' | 'emuset' | 'meta'

const META: [EmuMetaField, string][] = [
  ['title', 'Tytuł'],
  ['developer', 'Producent'],
  ['publisher', 'Wydawca'],
  ['year', 'Rok premiery'],
  ['genre', 'Gatunek'],
  ['players', 'Gracze'],
  ['description', 'Opis']
]

const TITLES: Record<Page, string> = {
  main: 'Opcje gry',
  versions: 'Wersja regionalna',
  variants: 'Wersja gry',
  emus: 'Emulator dla tej gry',
  emuset: 'Ustawienia emulatora',
  meta: 'Metadane i opis'
}

interface Row {
  label: string
  value?: string
  act?: () => void
  disabled?: boolean
}

const when = (unix: number): string => (unix ? new Date(unix * 1000).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }) : '')

function syncValue(o: EmuGameOptions): string {
  const s = o.sync
  const st = s.state === 'synced' ? `zsynchronizowane${s.last ? ` · ${formatLastPlayed(s.last) ?? ''}` : ''}` : s.state === 'pending' ? 'czekają na wysłanie' : 'jeszcze nie synchronizowane'
  return `${o.states ? `${o.states} ${plural(o.states, 'stan', 'stany', 'stanów')} · ` : ''}${st}`
}

export function GameOptions({ game, onClose }: { game: Game; onClose: () => void }) {
  const [o, setO] = useState<EmuGameOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState<Page>('main')
  const [hist, setHist] = useState<EmuSettingsChange[] | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [sub, setSub] = useState<'saves' | 'art' | 'pads' | null>(null)
  const [edit, setEdit] = useState<EmuMetaField | null>(null)
  const [readDesc, setReadDesc] = useState(false)
  const isFav = useStore((s) => !!s.prefs?.favorites.includes(game.id))
  // regional versions of one entry (emugrp:…): the one the player chose, else automatic
  const chosenVersion = useStore((s) => s.prefs?.versions?.[game.id])
  const { primary } = usePrimaryAction(game)
  const listRef = useRef<HTMLDivElement>(null)
  const toast = useStore((s) => s.toast)

  const load = (): void => {
    setError(null)
    void api()
      .emustart.gameOptions(game.id)
      .then(setO)
      .catch((e: Error) => setError(e.message || 'Nie udało się odczytać opcji gry.'))
  }
  useEffect(load, [game.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setConfirm(null)
    const t = setTimeout(() => listRef.current && focusFirst(listRef.current), 0)
    return () => clearTimeout(t)
  }, [page, !!o]) // eslint-disable-line react-hooks/exhaustive-deps

  const report = (r: { ok: boolean; message?: string; error?: string } | null | undefined): boolean => {
    if (!r) return false
    toast(r.ok ? (r.message ?? 'Gotowe') : (r.error ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
    return r.ok
  }
  const play = async (state?: string): Promise<void> => {
    onClose()
    if (state === undefined) return void primary?.run?.()
    const r = await attempt(api().emustart.launch(game.id, state))
    if (r && !r.ok) toast(r.error ?? 'Nie udało się uruchomić gry.', 'error')
  }
  const openEmuSet = (): void => {
    setHist(null)
    setPage('emuset')
    void api()
      .emustart.emuSettingsHistory(game.id)
      .then(setHist)
      .catch(() => setHist([]))
  }

  const rows = ((): Row[] => {
    if (!o) return []
    const e = game.emu
    if (page === 'main')
      return [
        { label: primary?.label ?? 'Graj', value: primary?.disabled ? primary.note : undefined, act: () => void play(), disabled: !primary?.run || primary.disabled },
        { label: 'Graj od początku', value: 'bez wczytania stanu', act: () => void play('__od_poczatku__'), disabled: !primary?.run || primary.disabled },
        ...(e?.versions
          ? [
              {
                label: 'Wersja regionalna',
                value: `${e.versions.find((v) => v.id === e.shownVersion)?.tags || 'bez oznaczeń'} · ${chosenVersion ? 'wybrana' : 'automatycznie'} · ${versionCountLabel(e.versions.length)}`,
                act: () => setPage('versions')
              }
            ]
          : []),
        ...(o.variants.length
          ? [{ label: 'Wersja', value: o.variant ? o.variantLabel : `oryginał · ${o.variants.length} ${plural(o.variants.length, 'inna wersja', 'inne wersje', 'innych wersji')}`, act: () => setPage('variants') }]
          : []),
        { label: 'Emulator', value: (o.emulator.label || 'nie wybrano') + (o.emulator.own ? '  (tylko ta gra)' : ''), act: () => setPage('emus') },
        { label: 'Ustawienia emulatora', value: 'obraz, dźwięk, sterowanie — w Twoim profilu', act: openEmuSet },
        { label: 'Wczytaj zapis', value: syncValue(o), act: () => setSub('saves') },
        { label: 'Kontrolery', value: 'kolejność graczy, ukryte w tej grze', act: () => setSub('pads') },
        { label: 'Metadane i opis', value: [o.meta.developer, o.meta.year].filter(Boolean).join(' · '), act: () => setPage('meta') },
        { label: 'Grafiki', value: o.admin ? 'plakat, tło, logo · serwer EmuStart' : 'plakat, tło, logo', act: () => setSub('art') },
        { label: isFav ? '★ W ulubionych' : '☆ Do ulubionych', act: () => void attempt(api().prefs.toggleFavorite(game.id)) },
        {
          label: o.pinned ? 'Nie trzymaj na dysku' : o.cached ? 'Zachowaj na dysku' : 'Pobierz na dysk',
          value: o.pinned ? 'zwolni miejsce, gdy zabraknie' : o.cached ? 'poza limitem ostatnich gier' : formatBytes(e?.size),
          act: () => void attempt(api().emustart.toggleKeep(game.id)).then((r) => report(r) && load())
        },
        ...(o.cached || o.pinned || o.local
          ? [
              {
                label: confirm === 'remove' ? 'Na pewno usunąć z dysku? A — tak' : 'Usuń z dysku',
                value: confirm === 'remove' ? 'B — nie' : o.local ? formatBytes(o.local) : 'kopia lokalna',
                act: () => {
                  if (confirm !== 'remove') return setConfirm('remove')
                  setConfirm(null)
                  void attempt(api().emustart.removeLocal(game.id)).then((r) => report(r) && load())
                }
              }
            ]
          : [])
      ]
    if (page === 'versions' && e?.versions) {
      const choose = (id: string | null): void =>
        void attempt(api().emustart.chooseVersion(game.id, id)).then(() => (setTimeout(load, 300), setPage('main')))
      return [
        ...e.versions.map((v) => ({
          label: v.tags || 'bez oznaczeń',
          value: `${v.copying ? 'pobieranie…' : v.cached ? 'na dysku' : 'na serwerze'}${v.discs > 1 ? ` · 💿${v.discs}` : ''}${v.lastPlayed ? ' · grana' : ''}${v.id === e.shownVersion ? '  ✓' : ''}`,
          act: () => choose(v.id)
        })),
        { label: 'Automatycznie', value: `ostatnio grana, pobrana albo wg regionu${chosenVersion ? '' : '  ✓'}`, act: () => choose(null) }
      ]
    }
    if (page === 'variants') {
      const pick = (id: number): void => void attempt(api().emustart.setVariant(game.id, id)).then((r) => report(r) && (load(), setPage('main')))
      return [
        { label: 'Oryginał', value: o.variant ? '' : '✓', act: () => pick(0) },
        ...o.variants.map((v) => ({ label: v.label, value: `${/^[a-z]{2}$/.test(v.lang ?? '') ? v.lang!.toUpperCase() + ' ' : ''}${o.variant === v.id ? '✓' : ''}`, act: () => pick(v.id) }))
      ]
    }
    if (page === 'emus') {
      const set = (opt: EmuGameOptions['emulators'][number] | null): void =>
        void attempt(api().emustart.setGameEmulator(game.id, opt)).then((r) => report(r) && (load(), setPage('main')))
      return [
        { label: 'Domyślny dla systemu', value: o.emulator.own ? '' : '✓', act: () => set(null) },
        ...o.emulators.map((opt) => ({
          label: opt.label,
          value: o.emulator.own && o.emulator.exe === opt.exe && o.emulator.args === opt.args ? '✓' : '',
          act: () => set(opt)
        })),
        ...(o.emulators.length ? [] : [{ label: 'Na tym komputerze nie ma innych emulatorów dla tego systemu', disabled: true }])
      ]
    }
    if (page === 'emuset') {
      const out: Row[] = [
        {
          label: 'Zmień w emulatorze (bez gry)',
          value: 'zapisze się w Twoim profilu',
          act: () => {
            onClose()
            void attempt(api().emustart.configureEmulator(game.id)).then((r) => r && !r.ok && toast(r.error ?? 'Nie udało się.', 'error'))
          }
        },
        { label: 'Albo w trakcie gry: Start + Select → menu RetroArcha', value: 'zmiana zapisze się po grze', disabled: true }
      ]
      if (o.retroarch)
        out.push({
          label: 'Shader ekranu',
          value: o.shaderOff ? `wyłączony (${o.system})` : `jak w RetroArchu (${o.system})`,
          act: () => void attempt(api().emustart.setShaderOff(o.es, !o.shaderOff)).then((r) => report(r) && setO({ ...o, shaderOff: !o.shaderOff }))
        })
      if (!hist) out.push({ label: 'Wczytuję historię zmian…', disabled: true })
      else if (!hist.length) out.push({ label: 'Historia zmian jest pusta', disabled: true })
      else
        for (const h of hist)
          out.push({
            label: confirm === h.id ? 'Przywrócić ustawienia sprzed tej zmiany? A — tak' : `Cofnij: ${when(h.time)} · ${h.label || 'zmiana'}`,
            value: h.files.map((f) => f.split('/').pop()).slice(0, 3).join(', ') + (h.files.length > 3 ? ` +${h.files.length - 3}` : ''),
            act: () => {
              if (confirm !== h.id) return setConfirm(h.id)
              setConfirm(null)
              void attempt(api().emustart.emuSettingsRestore(game.id, h.id)).then((r) => report(r) && openEmuSet())
            }
          })
      return out
    }
    // meta
    const out: Row[] = META.map(([k, label]) => ({
      label: label + (o.metaEdits[k] ? '  ✎' : ''),
      value: k === 'description' ? (o.meta.description ? 'pokaż' : '—') : o.meta[k] || '—',
      act: () => (o.admin ? setEdit(k) : k === 'description' && o.meta.description ? setReadDesc(true) : undefined)
    }))
    if (o.admin) {
      if (Object.keys(o.metaEdits).length)
        out.push({ label: 'Przywróć dane pobrane', value: 'usuń ręczne zmiany', act: () => void attempt(api().emustart.metaSave(game.id, {})).then((r) => report(r) && load()) })
      out.push({
        label: 'Pobierz opis z sieci',
        value: 'Wikipedia, IGDB, TheGamesDB — na serwerze',
        act: () => void attempt(api().emustart.metaFetchFull(game.id)).then((r) => report(r) && setTimeout(load, 6000))
      })
    }
    return out
  })()

  const back = (): boolean => {
    if (confirm) setConfirm(null)
    else if (page !== 'main') setPage('main')
    else onClose()
    return true
  }

  return (
    <>
      <Modal
        title={`${TITLES[page]} — ${game.name}`}
        onClose={onClose}
        wide
        className="gopt"
        handlers={{ back }}
        hints={[
          { action: 'confirm', label: 'Wybierz' },
          { action: 'back', label: page === 'main' ? 'Zamknij' : 'Wstecz' }
        ]}
      >
        {!o && !error && <p className="details__loading">Wczytuję opcje gry (zapisy synchronizują się z serwerem)…</p>}
        {error && (
          <div className="modal__row">
            <p className="details__muted">{error}</p>
            <button className="btn" data-nav data-autofocus onClick={load}>
              Spróbuj ponownie
            </button>
          </div>
        )}
        {o && (
          <div className="gopt__list" ref={listRef} key={page}>
            {rows.map((r, i) => (
              <button key={r.label + i} className="gopt__row" data-nav={r.disabled && !r.act ? undefined : true} data-autofocus={i === 0 || undefined} disabled={r.disabled} onClick={r.act}>
                <span className="gopt__label">{r.label}</span>
                {r.value && <span className="gopt__value">{r.value}</span>}
              </button>
            ))}
          </div>
        )}
        {o && page === 'meta' && readDesc && <p className="gopt__desc">{o.meta.description}</p>}
      </Modal>
      {sub === 'saves' && <EmuSaves game={game} onClose={() => (setSub(null), load())} />}
      {sub === 'art' && <ArtPicker game={game} admin={!!o?.admin} onClose={() => setSub(null)} />}
      {sub === 'pads' && <Controllers game={{ id: game.id, name: game.name }} onClose={() => setSub(null)} />}
      {edit && o && (
        <OnScreenKeyboard
          label={META.find(([k]) => k === edit)![1]}
          initial={o.meta[edit] ?? ''}
          secret={false}
          onChange={() => undefined}
          onClose={(submit, v) => {
            const k = edit
            setEdit(null)
            if (submit) void attempt(api().emustart.metaSave(game.id, { ...o.metaEdits, [k]: v })).then((r) => report(r) && load())
          }}
        />
      )}
    </>
  )
}
