import type { Game, InstallState } from '@shared/types'
import { sortKey } from './merge'

// DEMO DATA — used only when the user enables demo mode in Settings (or there is no Steam).
// Titles are fictional; ids use the "demo:" prefix so they can never collide with real games
// and actions on them are blocked in the main process.

const TITLES: [string, InstallState, number?, number?][] = [
  ['Gwiezdny Przewoźnik', 'installed', 2, 3400],
  ['Echo Głębin', 'installed', 9, 720],
  ['Kroniki Mgły', 'notInstalled', undefined, 45],
  ['Neonowa Pętla', 'updateRequired', 30, 1800],
  ['Ostatni Latarnik', 'installing'],
  ['Pola Bursztynu', 'notInstalled'],
  ['Rdzawe Ostrza', 'installed', 120, 9600],
  ['Szepty Lasu', 'notInstalled'],
  ['Tunele Północy', 'installed', 400, 210],
  ['Wieża Zegarmistrza', 'notInstalled', undefined, 12],
  ['Zimowy Dryf', 'installed', 1, 60],
  ['Ziarno Burzy', 'notInstalled']
]

export function demoGames(): Game[] {
  const now = Math.floor(Date.now() / 1000)
  return TITLES.map(([name, state, daysAgo, minutes], i) => ({
    id: `demo:${i + 1}`,
    source: 'demo' as const,
    appId: 0,
    name: `${name}`,
    sortName: sortKey(name),
    provenance: ['demo' as const],
    installState: state,
    installed: state === 'installed' || state === 'updateRequired',
    lastPlayed: daysAgo !== undefined ? now - daysAgo * 86400 : undefined,
    playtimeMinutes: minutes
  }))
}
