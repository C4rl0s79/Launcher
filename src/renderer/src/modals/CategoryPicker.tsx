import { useState } from 'react'
import { api, attempt, sortedCategories, steamCollectionsOf, useStore } from '../store'
import { Modal } from '../components/Modal'
import { TextField } from '../components/TextField'

export function CategoryPicker({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const prefs = useStore((s) => s.prefs)!
  const [name, setName] = useState('')
  const custom = sortedCategories(prefs).filter((c) => c.kind === 'custom')
  const game = useStore((s) => s.snapshot?.games.find((g) => g.id === gameId))
  const collections = useStore((s) => s.snapshot?.collections ?? null)
  const steamCols = game ? steamCollectionsOf(game, prefs, collections) : []
  const assigned = new Set(prefs.gameCategories[gameId] ?? [])

  const toggle = (id: string): void => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void attempt(api().prefs.setGameCategories(gameId, [...next]))
  }

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    const p = await attempt(api().prefs.createCategory(name))
    if (!p) return
    const created = p.categories.find((c) => c.name === name.trim())
    if (created) await attempt(api().prefs.setGameCategories(gameId, [...assigned, created.id]))
    setName('')
  }

  return (
    <Modal title="Kategorie gry" onClose={onClose}>
      <div className="list">
        {steamCols.length > 0 && (
          <p className="details__muted">
            W kolekcjach Steam: {steamCols.map((c) => c.name).join(', ')} — te zmienia się w kliencie Steam.
          </p>
        )}
        {custom.length === 0 && <p className="details__muted">Nie masz jeszcze własnych kategorii Lumen. Utwórz pierwszą poniżej.</p>}
        {custom.map((c, i) => (
          <button
            key={c.id}
            className={`list__item list__item--check ${assigned.has(c.id) ? 'is-on' : ''}`}
            data-nav
            data-autofocus={i === 0 || undefined}
            role="checkbox"
            aria-checked={assigned.has(c.id)}
            onClick={() => toggle(c.id)}
          >
            <span className="check" aria-hidden>
              {assigned.has(c.id) ? '✓' : ''}
            </span>
            {c.name}
            {c.pinned && <span className="list__meta">przypięta</span>}
          </button>
        ))}
      </div>
      <div className="modal__row">
        <TextField label="Nowa kategoria" placeholder="Nowa kategoria…" value={name} onChange={setName} onSubmit={() => void create()} />
        <button className="btn" data-nav data-autofocus={custom.length === 0 || undefined} onClick={() => void create()} disabled={!name.trim()}>
          Dodaj
        </button>
      </div>
      <div className="modal__footer">
        <button className="btn btn--primary" data-nav onClick={onClose}>
          Gotowe
        </button>
      </div>
    </Modal>
  )
}
