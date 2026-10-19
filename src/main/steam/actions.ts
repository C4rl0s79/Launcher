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

export async function openSteam(action: SteamUriAction, appId?: number): Promise<void> {
  const uri = steamUri(action, appId)
  log.info('steam', `open ${uri}`)
  await shell.openExternal(uri)
}
