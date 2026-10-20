import { shell } from 'electron'
import { log } from '../logger'

// Actions are delegated to the Steam client through steam:// browser-protocol commands
// (https://developer.valvesoftware.com/wiki/Steam_browser_protocol). Steam itself shows any
// confirmation dialogs (install location, EULA, cloud conflicts…). We never pass credentials.

export type SteamUriAction = 'run' | 'install' | 'details' | 'store' | 'downloads' | 'library' | 'validate'

export function steamUri(action: SteamUriAction, appId?: number): string {
  const id = appId !== undefined ? Math.trunc(appId) : undefined
  const need = (): number => {
    if (!id || id <= 0) throw new Error('Nieprawidłowy identyfikator gry.')
    return id
  }
  switch (action) {
    case 'run':
      return `steam://rungameid/${need()}`
    case 'install':
      return `steam://install/${need()}`
    case 'details':
      return `steam://nav/games/details/${need()}`
    case 'store':
      return `steam://store/${need()}`
    case 'validate':
      return `steam://validate/${need()}`
    case 'downloads':
      return 'steam://open/downloads'
    case 'library':
      return 'steam://open/games'
  }
}

/** Launch a non-Steam shortcut through Steam by its 64-bit game id. */
export function shortcutRunUri(gameId64: string): string {
  if (!/^\d{10,20}$/.test(gameId64)) throw new Error('Nieprawidłowy identyfikator skrótu.')
  return `steam://rungameid/${gameId64}`
}

/**
 * Development / automated UI tests: LUMEN_DRY_RUN=1 logs Steam actions and emulator launches
 * instead of performing them (no game starts, no Steam dialog opens). Never set in normal use.
 */
export const DRY_RUN = process.env.LUMEN_DRY_RUN === '1'

export async function openSteamUri(uri: string): Promise<void> {
  log.info('steam', `${DRY_RUN ? 'DRY RUN, not opening' : 'open'} ${uri}`)
  if (!DRY_RUN) await shell.openExternal(uri)
}

export async function openSteam(action: SteamUriAction, appId?: number): Promise<void> {
  await openSteamUri(steamUri(action, appId))
}
