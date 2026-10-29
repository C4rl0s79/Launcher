import { useEffect, useRef, useState } from 'react'
import type { EmuLocalState, EmuRemoteState, EmuSaveSlot, EmuSaves as Saves, EmuStateEditInfo, EmuStateEditOp, EmuTrashState, Game } from '@shared/types'
import { api, attempt, useStore } from '../store'
import { formatBytes, formatLastPlayed, plural } from '../lib/format'
import { currentFocus, focusFirst } from '../nav/engine'
import { Modal } from './Modal'

// A game's saves (both layouts) — the same data as EmuStart's game options: sync status of in-game
// saves, save slots (EmuStart 0.50: separate playthroughs; the game starts on the active one), the
// active slot's save states (the server's bundle, synced when the list opens — "Wczytaj zapis";
// Y / right click — edit a state), its trash, and PS2 states of this PC and the phone (save manager).
// Every slot / state change is done by the engine, which refuses while the game runs; the window
// reads everything again after each change.

const PLATFORM: Record<string, string> = { windows: 'Komputer', android: 'Telefon', shared: 'Wszystkie urządzenia' }

function slotLabel(slot: string): string {
  const s = String(slot).toLowerCase()
  if (s === 'auto') return 'autozapis'
  if (s === 'resume') return 'wznowienie'
  if (s === 'autosave') return 'autozapis przy wyjściu'
  if (s.startsWith('autosave.')) return `autozapis ${s.split('.')[1]}`
  return `slot ${Number(s)}`
}

const when = (unix: number): string => (unix ? new Date(unix * 1000).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }) : '')

export function slotDesc(s: EmuSaveSlot): string {
  if (!s.states && !s.saves) return 'pusty'
  const parts: string[] = []
  if (s.states) parts.push(`${s.states} ${plural(s.states, 'stan', 'stany', 'stanów')}`)
  if (s.saves) parts.push('zapis w grze')
  return parts.join(' + ') + (s.time ? ` · ${when(s.time)}` : '')
}

/** A state the player can change: in the active slot's bundle (not another core's, not EmuStart's quicksave) */
const editable = (st: EmuLocalState, slots: EmuSaveSlot[]): boolean => !!st.arc && !st.resume && (!!st.otherCore || slots.length > 0)

function syncText(s: Saves['sync']): string {
  if (s.state === 'synced') return `Zsynchronizowane z serwerem${s.last ? ` · ${formatLastPlayed(s.last) ?? ''}` : ''}`
  if (s.state === 'pending') return 'Czekają na wysłanie — wyślą się, gdy serwer będzie dostępny'
  if (s.state === 'never') return 'Jeszcze nie synchronizowane — zapisy wyślą się po pierwszej grze'
  if (s.state === 'folder') return 'Ten emulator synchronizuje cały folder zapisów z serwerem przed grą i po niej (bez slotów i kosza)'
  if (s.state === 'none') return 'Ten emulator nie synchronizuje zapisów — zostają na tym urządzeniu'
  return s.state
}

/** „Synchronizuję…” with a bar: MB sent / received and the time left (engine: sync_progress). */
function SyncProgress() {
  const [p, setP] = useState<{ active: boolean; op?: string; done?: number; total?: number; eta?: number }>({ active: false })
  useEffect(() => {
    let on = true
    const tick = (): void => void api().emustart.syncProgress().then((x) => on && setP(x)).catch(() => undefined)
    tick()
    const t = setInterval(tick, 1000)
    return () => {
      on = false
      clearInterval(t)
    }
  }, [])
  const mb = (n = 0): string => (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)
  const eta = p.eta ?? -1
  const left = eta < 0 ? '' : eta < 60 ? ` · ok. ${eta} s` : ` · ok. ${Math.round(eta / 60)} min`
  return (
    <>
      <p className="details__loading">
        {p.active
          ? `${p.op === 'send' ? 'Wysyłam zapisy na serwer' : 'Pobieram zapisy z serwera'}: ${mb(p.done)} / ${mb(p.total)} MB${left}`
          : 'Synchronizuję zapisy tej gry z serwerem…'}
      </p>
      {p.active && p.total ? (
        <div className="download__bar">
          <i style={{ width: `${Math.min(100, Math.round(((p.done ?? 0) / p.total) * 100))}%` }} />
        </div>
      ) : null}
    </>
  )
}

export function EmuSaves({ game, onClose }: { game: Game; onClose: () => void }) {
  const [data, setData] = useState<Saves | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<EmuLocalState | null>(null)
  const [trash, setTrash] = useState<EmuTrashState[] | null>(null)
  const toast = useStore((s) => s.toast)

  const load = (): void => {
    setError(null)
    setTrash(null)
    void api()
      .emustart.saves(game.id)
      .then(setData)
      .catch((e: Error) => setError(e.message || 'Nie udało się odczytać zapisów.'))
  }
  useEffect(load, [game.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const active = data?.slots.find((s) => s.active) ?? null

  const setSlot = async (s: EmuSaveSlot): Promise<void> => {
    if (s.active) return toast('To jest aktywny slot — gra startuje na jego zapisach.', 'info')
    setBusy(true)
    toast(`Przełączam na slot ${s.slot}…`, 'info')
    const r = await attempt(api().emustart.setSaveSlot(game.id, s.slot))
    setBusy(false)
    if (!r) return
    toast(r.ok ? (r.message ?? `Aktywny slot ${s.slot}.`) : (r.error ?? 'Nie udało się zmienić slotu.'), r.ok ? 'info' : 'error')
    load()
  }

  const openTrash = async (): Promise<void> => {
    // trash of the active slot + trashes of the other RetroArch cores on the list
    const cores = [...new Set((data?.states ?? []).map((x) => x.otherCore).filter((c): c is string => !!c))]
    const parts = await Promise.all([active && active.trash > 0 ? attempt(api().emustart.stateTrash(game.id)) : [], ...cores.map((c) => attempt(api().emustart.stateTrash(game.id, c)))])
    setTrash(parts.flatMap((x) => x ?? []))
  }

  const restore = async (it: EmuTrashState): Promise<void> => {
    setBusy(true)
    const r = await attempt(api().emustart.stateEdit(game.id, 'restore', it.name, undefined, it.core))
    setBusy(false)
    if (!r) return
    toast(r.ok ? (r.message ?? 'Przywrócono.') : (r.error ?? 'Nie udało się przywrócić.'), r.ok ? 'info' : 'error')
    load()
  }

  // Y on a focused state (the controller's "more" button in Lumen's lists) — edit it
  const editFocused = (): boolean => {
    const arc = currentFocus()?.dataset.arc
    const st = arc ? data?.states.find((x) => x.arc === arc) : undefined
    if (!st || !data || !editable(st, data.slots)) return false
    setEditing(st)
    return true
  }

  const play = async (st: Saves['states'][number]): Promise<void> => {
    setBusy(true)
    if (st.otherCore) {
      // a state of another core (another device): the game switches to that core and starts from it
      toast(`Przełączam grę na rdzeń ${st.otherCore}…`, 'info')
      const sw = await attempt(api().emustart.playOtherCore(game.id, st.otherCore))
      if (!sw?.ok) {
        setBusy(false)
        if (sw) toast(sw.error ?? 'Nie udało się przełączyć rdzenia.', 'error')
        return
      }
    }
    const r = await attempt(api().emustart.launch(game.id, st.arc ? `arc:${st.arc}` : st.path))
    setBusy(false)
    if (!r) return
    if (!r.ok) toast(r.error ?? 'Nie udało się uruchomić gry.', 'error')
    else onClose()
  }

  const copy = async (st: EmuRemoteState, t: EmuRemoteState['targets'][number]): Promise<void> => {
    setBusy(true)
    const r = await attempt(api().emustart.copyState(game.id, st.rel, t.platform, t.emu))
    setBusy(false)
    if (!r) return
    toast(r.ok ? (r.message ?? 'Skopiowano.') : (r.error ?? 'Nie udało się skopiować.'), r.ok ? 'info' : 'error')
    if (r.ok) load()
  }

  return (
    <Modal
      title={`Zapisy — ${game.name}`}
      onClose={onClose}
      wide
      handlers={{ y: editFocused }}
      hints={[
        { action: 'confirm', label: 'Wybierz' },
        ...(data?.slots.length ? [{ action: 'y' as const, label: 'Edytuj stan' }] : []),
        { action: 'back', label: 'Zamknij' }
      ]}
    >
      {!data && !error && <SyncProgress />}
      {error && (
        <div className="modal__row">
          <p className="details__muted">{error}</p>
          <button className="btn" data-nav data-autofocus onClick={load}>
            Spróbuj ponownie
          </button>
        </div>
      )}
      {data && (
        <>
          <h3 className="saves__h">Zapisy w grze</h3>
          <p className="details__muted">
            {syncText(data.sync)}. Zapisy w grze i karty pamięci synchronizują się same przed grą i po niej — wspólne dla komputera i telefonu.
          </p>

          {data.slots.length > 0 && (
            <>
              <h3 className="saves__h">Slot zapisów</h3>
              <p className="details__muted">Każdy slot to osobne przejście gry: stany, zapisy w grze i karty pamięci. Gra startuje na aktywnym slocie.</p>
              <div className="saves__slots" data-nav-group="saves-slots">
                {data.slots.map((s) => (
                  <button key={s.slot} className="saves__row" data-nav aria-pressed={s.active} disabled={busy} onClick={() => void setSlot(s)}>
                    <span className="saves__text">
                      <strong>
                        Slot {s.slot}
                        {s.active ? ' ✓ aktywny' : ''}
                      </strong>
                      <small>{slotDesc(s)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <h3 className="saves__h">Stany gry (te same na każdym urządzeniu){active ? ` — slot ${active.slot}` : ''}</h3>
          {data.states.length === 0 && <p className="details__muted">Brak stanów tej gry (zapisz stan w emulatorze, a pojawi się tutaj).</p>}
          <div className="saves__list" data-nav-group="saves-local">
            {data.states.map((st, i) => (
              <button
                key={st.arc ?? st.path}
                className="saves__row"
                data-nav
                data-arc={st.arc}
                data-autofocus={i === 0 || undefined}
                disabled={busy}
                onClick={() => void play(st)}
                onContextMenu={(e) => {
                  if (!editable(st, data.slots)) return
                  e.preventDefault()
                  setEditing(st)
                }}
              >
                {st.thumb ? <img className="saves__thumb" src={st.thumb} alt="" /> : <span className="saves__thumb saves__thumb--none" />}
                <span className="saves__text">
                  <strong>
                    {st.otherCore ? '✗ ' : ''}
                    {st.label}
                  </strong>
                  <small>
                    {when(st.time)}
                    {st.detail ? ` · ${st.detail}` : ''}
                  </small>
                </span>
                <span className="saves__act">
                  {st.otherCore ? `Graj od tego stanu (rdzeń ${st.otherCore})` : editable(st, data.slots) ? 'Graj od tego stanu · Y — edytuj' : 'Graj od tego stanu'}
                </span>
              </button>
            ))}
          </div>

          {((active && active.trash > 0) || data.states.some((x) => x.otherCore)) && !trash && (
            <div className="modal__row">
              <button className="btn" data-nav disabled={busy} onClick={() => void openTrash()}>
                {active && active.trash > 0 ? `Kosz (${active.trash} ${plural(active.trash, 'usunięty', 'usunięte', 'usuniętych')})` : 'Kosz'}
              </button>
            </div>
          )}
          {trash && (
            <>
              <h3 className="saves__h">Kosz — slot {active?.slot}</h3>
              {trash.length === 0 && <p className="details__muted">Kosz jest pusty.</p>}
              <div className="saves__list" data-nav-group="saves-trash">
                {trash.map((it, i) => (
                  <button key={it.name} className="saves__row" data-nav data-autofocus={i === 0 || undefined} disabled={busy} onClick={() => void restore(it)}>
                    {it.thumb ? <img className="saves__thumb" src={it.thumb} alt="" /> : <span className="saves__thumb saves__thumb--none" />}
                    <span className="saves__text">
                      <strong>{it.label}</strong>
                      <small>zapisany {when(it.time)}</small>
                    </span>
                    <span className="saves__act">Przywróć</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {data.remote.ok && data.remote.states.length > 0 && (
            <>
              <h3 className="saves__h">Stany PS2 — komputer i telefon</h3>
              <div className="saves__list" data-nav-group="saves-remote">
                {data.remote.states.map((st) => (
                  <div key={st.rel} className="saves__row saves__row--static">
                    <span className="saves__text">
                      <strong>
                        {PLATFORM[st.platform] ?? st.platform} · {st.label.replace(/ na (komputerze|telefonie)$/, '')} · {slotLabel(st.slot)}
                      </strong>
                      <small>
                        {when(st.mtime)} · {formatBytes(st.size)}
                      </small>
                    </span>
                    <span className="saves__targets">
                      {st.targets.length === 0 && <small>brak tego emulatora na drugiej platformie</small>}
                      {st.targets.map((t) => (
                        <button key={t.platform + t.emu} className="btn btn--sm" data-nav disabled={busy} title={t.note} onClick={() => void copy(st, t)}>
                          {t.ok === true ? '✓' : t.ok === false ? '✗' : '?'} Kopiuj na: {t.label}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {!data.remote.ok && <p className="details__muted">Stany z telefonu: {data.remote.reason}</p>}
          <div className="modal__row">
            <button className="btn" data-nav data-autofocus={data.states.length === 0 || undefined} onClick={load}>
              Odśwież
            </button>
          </div>
        </>
      )}
      {editing && data && (
        <StateEdit
          game={game}
          st={editing}
          slots={data.slots}
          onPlay={() => (setEditing(null), void play(editing))}
          onDone={() => (setEditing(null), load())}
          onClose={() => setEditing(null)}
        />
      )}
    </Modal>
  )
}

type EditPage = 'main' | 'num' | 'copy' | 'move' | 'delete'

/** Changes of one state of the active slot (EmuStart's "Stan gry" page after holding A). */
function StateEdit({
  game,
  st,
  slots,
  onPlay,
  onDone,
  onClose
}: {
  game: Game
  st: EmuLocalState
  slots: EmuSaveSlot[]
  onPlay: () => void
  onDone: () => void
  onClose: () => void
}) {
  const [info, setInfo] = useState<EmuStateEditInfo | null>(null)
  const [page, setPage] = useState<EditPage>('main')
  const [busy, setBusy] = useState(false)
  const toast = useStore((s) => s.toast)
  const arc = st.arc ?? ''
  const list = useRef<HTMLDivElement>(null)
  // one dialog for all pages (a new dialog per page would hand the focus back to the list under it)
  useEffect(() => {
    if (list.current) focusFirst(list.current)
  }, [page, info])

  useEffect(() => {
    // another core's state: only delete (no numbers / slots of this core)
    if (st.otherCore) setInfo({ numbers: [], slots: [], slot: 0, retroarch: true } as unknown as EmuStateEditInfo)
    else void attempt(api().emustart.stateEditInfo(game.id)).then((r) => (r ? setInfo(r) : onClose()))
  }, [game.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (op: EmuStateEditOp, arg?: number): Promise<void> => {
    setBusy(true)
    const r = await attempt(api().emustart.stateEdit(game.id, op, arc, arg, st.otherCore))
    setBusy(false)
    if (!r) return
    toast(r.ok ? (r.message ?? 'Gotowe.') : (r.error ?? 'Nie udało się.'), r.ok ? 'info' : 'error')
    if (r.ok) onDone()
  }

  const back = (): void => (page === 'main' ? onClose() : setPage('main'))
  const rows: { key: string; label: string; value?: string; act: () => void }[] = []
  if (!info) rows.push({ key: 'wait', label: 'Wczytuję…', act: () => undefined })
  else if (page === 'main' && st.otherCore) {
    rows.push({ key: 'play', label: 'Wczytaj', value: `graj od tego stanu (rdzeń ${st.otherCore})`, act: onPlay })
    rows.push({ key: 'delete', label: 'Usuń', value: 'do kosza (można przywrócić)', act: () => setPage('delete') })
  } else if (page === 'main') {
    rows.push({ key: 'play', label: 'Wczytaj', value: 'graj od tego stanu', act: onPlay })
    if (!st.continue) rows.push({ key: 'num', label: 'Zmień numer', act: () => setPage('num') })
    rows.push({ key: 'copy_new', label: 'Kopiuj jako nowy numer', act: () => void run('copy_new') })
    if (info.slots.length) {
      rows.push({ key: 'copy', label: 'Kopiuj do slotu…', act: () => setPage('copy') })
      rows.push({ key: 'move', label: 'Przenieś do slotu…', act: () => setPage('move') })
    }
    if (info.retroarch && !st.continue)
      rows.push({ key: 'continue', label: 'Ustaw jako „Kontynuuj”', value: 'dotychczasowy dostanie nowy numer', act: () => void run('continue') })
    rows.push({ key: 'delete', label: 'Usuń', value: 'do kosza (można przywrócić)', act: () => setPage('delete') })
  } else if (page === 'num') {
    if (!info.numbers.length) rows.push({ key: 'none', label: 'Brak wolnych numerów', act: () => undefined })
    for (const n of info.numbers) rows.push({ key: `n${n}`, label: `Stan #${n}`, value: 'wolny', act: () => void run('renumber', n) })
  } else if (page === 'copy' || page === 'move') {
    for (const n of info.slots) {
      const s = slots.find((x) => x.slot === n)
      rows.push({ key: `s${n}`, label: `Slot ${n}`, value: s ? slotDesc(s) : '', act: () => void run(page === 'copy' ? 'copy_slot' : 'move_slot', n) })
    }
  } else if (page === 'delete') {
    rows.push({ key: 'yes', label: 'Tak, usuń do kosza', value: 'przywrócisz go z kosza pod listą stanów', act: () => void run('delete') })
    rows.push({ key: 'no', label: 'Nie', act: () => setPage('main') })
  }
  const titles: Record<EditPage, string> = {
    main: st.label,
    num: `${st.label} — zmień numer`,
    copy: `${st.label} — kopiuj do slotu`,
    move: `${st.label} — przenieś do slotu`,
    delete: `${st.label} — usunąć?`
  }

  return (
    <Modal title={titles[page]} onClose={back}>
      <div ref={list} className="saves__list" data-nav-group={`state-edit-${page}`}>
        {rows.map((r, i) => (
          <button key={r.key} className="saves__row" data-nav data-autofocus={i === 0 || undefined} disabled={busy} onClick={r.act}>
            <span className="saves__text">
              <strong>{r.label}</strong>
              {r.value && <small>{r.value}</small>}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
