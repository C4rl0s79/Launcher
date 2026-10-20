import { memo } from 'react'
import type { Game } from '@shared/types'
import { Art } from './Art'
import { isBusy } from '../lib/format'

interface Props {
  game: Game
  favorite?: boolean
  onOpen: (game: Game) => void
  onFocusGame?: (game: Game) => void
  autofocus?: boolean
}

export const Poster = memo(function Poster({ game, favorite, onOpen, onFocusGame, autofocus }: Props) {
  return (
    <button
      className={`poster ${game.installed ? '' : 'is-uninstalled'}`}
      data-nav
      data-key={game.id}
      data-autofocus={autofocus || undefined}
      onClick={() => onOpen(game)}
      onFocus={() => onFocusGame?.(game)}
      aria-label={game.name}
      title={game.name}
    >
      <div className="poster__frame">
        <Art gameId={game.id} name={game.name} kind="grid" />
        <div className="poster__badges">
          {game.running && <span className="badge badge--live">W grze</span>}
          {isBusy(game) && <span className="badge badge--busy">Pobieranie</span>}
          {game.installState === 'updateRequired' && <span className="badge">Aktualizacja</span>}
          {game.source === 'demo' && <span className="badge badge--demo">DEMO</span>}
        </div>
        {favorite && <span className="poster__fav" aria-label="Ulubiona">★</span>}
        {game.emu && game.emu.discs > 1 && (
          <span className="poster__discs" aria-label={`${game.emu.discs} płyty`} title={`${game.emu.discs} płyty`}>
            💿{game.emu.discs}
          </span>
        )}
        {!game.installed && <span className="poster__cloud" aria-label="Niezainstalowana" />}
      </div>
      <div className="poster__label">{game.name}</div>
    </button>
  )
})
