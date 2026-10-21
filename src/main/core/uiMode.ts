import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { UiMode } from '@shared/types'
import { log } from '../logger'

/**
 * One interface, two layouts (docs/PLAN-TV-REACT.md): desktop and TV — the same React renderer.
 * Switching changes only the layout and the window's fullscreen state; running jobs live in the
 * core and the engine, so they are unaffected. The selected game travels with the switch.
 * Emits "mode" (mode, selection).
 */
export class UiModeManager extends EventEmitter {
  private _mode: UiMode = 'desktop'
  private selection: string | null = null
  private wasFullScreen = false

  constructor(private readonly win: BrowserWindow) {
    super()
  }

  get mode(): UiMode {
    return this._mode
  }

  get selected(): string | null {
    return this.selection
  }

  select(gameId: string | null): void {
    this.selection = gameId
  }

  setMode(mode: UiMode): void {
    if (mode === this._mode) return
    this._mode = mode
    if (mode === 'fullscreen') {
      this.wasFullScreen = this.win.isFullScreen()
      if (!this.wasFullScreen) this.win.setFullScreen(true)
    } else if (!this.wasFullScreen && this.win.isFullScreen()) this.win.setFullScreen(false)
    this.win.webContents.focus()
    log.info('ui', `mode ${mode}${this.selection ? ` (gra ${this.selection})` : ''}`)
    this.emit('mode', mode, this.selection)
  }

  toggle(): void {
    this.setMode(this._mode === 'desktop' ? 'fullscreen' : 'desktop')
  }
}
