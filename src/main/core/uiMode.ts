import { EventEmitter } from 'node:events'
import path from 'node:path'
import { WebContentsView, type BrowserWindow } from 'electron'
import { EMU_UI_SCHEME } from '@shared/api'
import { EMU_UI } from '@shared/emuPad'
import type { UiMode } from '@shared/types'
import { log } from '../logger'

/**
 * Two presentation layers in one window, over one core:
 *  - desktop: Lumen's React UI (the window's own webContents),
 *  - fullscreen: the TV layout of the same React UI (default), or — while the TV layout does not
 *    have every function yet (docs/PLAN-TV-REACT.md) — EmuStart's UI (engine/web) in a
 *    WebContentsView on top (settings: tvInterface 'emustart').
 * Switching only shows/hides the view — no reload, no restart; running jobs live in the core
 * and the engine, so they are unaffected. The selected game travels with the switch.
 * Emits "mode" (mode, selection).
 */
export class UiModeManager extends EventEmitter {
  private view: WebContentsView | null = null
  private _mode: UiMode = 'desktop'
  private selection: string | null = null
  private wasFullScreen = false
  /** what the fullscreen UI should show once it can: a settings page or the selected game */
  private pending: 'settings' | 'game' | null = null
  private loaded = false
  /** EmuStart's own interface is shown in fullscreen mode (setting, or opened for a function the
   *  TV layout does not have yet: login, profiles, emulator of a game…) */
  private legacyNow = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly opts: {
      preloadDir: string
      /** where a game is in the EmuStart UI: system + id (steam:<appid> or the engine number) */
      locate: (gameId: string) => { es: string; id: string | number } | null
      /** keyboard shortcuts of the window (F10 switches the interface) */
      onInput?: (input: Electron.Input, wc: Electron.WebContents) => void
      /** fullscreen mode shows EmuStart's own interface instead of Lumen's TV layout */
      legacyTv: () => boolean
    }
  ) {
    super()
    win.on('resize', () => this.layout())
    win.on('enter-full-screen', () => this.layout())
    win.on('leave-full-screen', () => this.layout())
  }

  get mode(): UiMode {
    return this._mode
  }

  get selected(): string | null {
    return this.selection
  }

  /** the fullscreen mode shows EmuStart's own interface (separate view) */
  get legacyShown(): boolean {
    return this._mode === 'fullscreen' && this.legacyNow && !!this.view
  }

  /** webContents of the visible interface (input, focus) */
  get activeContents(): Electron.WebContents {
    return this.legacyShown ? this.view!.webContents : this.win.webContents
  }

  get emuContents(): Electron.WebContents | null {
    return this.view?.webContents ?? null
  }

  select(gameId: string | null): void {
    this.selection = gameId
  }

  /** create the fullscreen view in the background, so the first switch is instant */
  preload(): void {
    if (this.opts.legacyTv()) this.ensureView()
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(this.opts.preloadDir, 'emu.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    view.setBackgroundColor('#0b0d12')
    view.setVisible(false)
    const wc = view.webContents
    // the hidden TV view takes keyboard focus when its page loads — in desktop mode keys went to
    // an invisible page until the window was clicked; give it back to the visible interface
    wc.on('focus', () => {
      // not inside the event: Chromium finishes moving focus to this view afterwards
      setTimeout(() => {
        if (!this.legacyShown && !this.win.isDestroyed()) this.win.webContents.focus()
      }, 0)
    })
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e, url) => {
      if (!url.startsWith(`${EMU_UI_SCHEME}://`)) e.preventDefault()
    })
    wc.on('before-input-event', (_e, input) => this.opts.onInput?.(input, wc))
    wc.on('render-process-gone', (_e, d) => log.error('ui', `fullscreen view gone: ${d.reason}`))
    // a message sent while the page was still loading is lost — repeat the pending one when it is up
    wc.on('did-finish-load', () => {
      this.loaded = true
      this.sendPending()
    })
    wc.on('did-start-loading', () => (this.loaded = false))
    this.win.contentView.addChildView(view)
    this.view = view
    this.layout()
    void wc.loadURL(`${EMU_UI_SCHEME}://ui/index.html?lumen`)
    return view
  }

  private sendPending(): void {
    const wc = this.view?.webContents
    if (!wc || !this.loaded || !this.pending) return
    if (this.pending === 'settings') wc.send(EMU_UI.open, 'settings')
    else {
      const at = this.selection ? this.opts.locate(this.selection) : null
      if (at) wc.send(EMU_UI.focusGame, at.es, at.id)
    }
    this.pending = null
  }

  /** reload EmuStart's UI (e.g. the engine started after the view was created) */
  reloadEmu(): void {
    this.view?.webContents.reload()
  }

  private layout(): void {
    if (!this.view) return
    const b = this.win.getContentBounds()
    this.view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  }

  /**
   * `then` opens EmuStart's own interface (until the TV layout has these functions,
   * docs/PLAN-TV-REACT.md): "settings" — login, account, profiles; "game" — options of the
   * selected game (emulator, metadata…).
   */
  setMode(mode: UiMode, then?: 'settings' | 'game'): void {
    if (mode === this._mode) {
      if (then && mode === 'fullscreen') this.showLegacy(then)
      return
    }
    this._mode = mode
    this.legacyNow = mode === 'fullscreen' && (this.opts.legacyTv() || !!then)
    if (mode === 'fullscreen' && !this.legacyNow) {
      // Lumen's TV layout: the same interface, another layout — the renderer switches on "mode"
      this.view?.setVisible(false)
      this.wasFullScreen = this.win.isFullScreen()
      if (!this.wasFullScreen) this.win.setFullScreen(true)
      this.win.webContents.focus()
    } else if (mode === 'fullscreen') {
      const view = this.ensureView()
      this.wasFullScreen = this.win.isFullScreen()
      if (!this.wasFullScreen) this.win.setFullScreen(true)
      view.setVisible(true)
      this.layout()
      view.webContents.focus()
      this.pending = then === 'settings' ? 'settings' : this.selection ? 'game' : null
      this.sendPending()
    } else {
      this.view?.setVisible(false)
      if (!this.wasFullScreen && this.win.isFullScreen()) this.win.setFullScreen(false)
      this.win.webContents.focus()
    }
    log.info('ui', `mode ${mode}${this.selection ? ` (gra ${this.selection})` : ''}`)
    this.emit('mode', mode, this.selection)
  }

  /** already in fullscreen mode (TV layout): show EmuStart's interface on top */
  private showLegacy(then: 'settings' | 'game'): void {
    const view = this.ensureView()
    this.legacyNow = true
    view.setVisible(true)
    this.layout()
    view.webContents.focus()
    this.pending = then === 'settings' ? 'settings' : this.selection ? 'game' : null
    this.sendPending()
    log.info('ui', `EmuStart interface (${then})`)
  }

  toggle(): void {
    this.setMode(this._mode === 'desktop' ? 'fullscreen' : 'desktop')
  }
}
