import { useMemo } from 'react'
import type { Game } from '@shared/types'
import { useStore } from '../store'
import { plural } from '../lib/format'

// Systems and their games for the TV layout — computed from the same library as the desktop
// layout (one interface, two layouts): EmuStart platforms from the engine, Steam as one more system.

export const STEAM = 'steam'

export interface TvSystem {
  key: string
  display: string
  games: Game[]
  /** downloaded (EmuStart cache) / installed (Steam) */
  ready: number
  emulator?: string
  /** platform logo from the EmuStart server (lumen-art: emusys:<es>) */
  logo: boolean
}

const byName = (a: Game, b: Game): number => a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' })

export function useTvSystems(): TvSystem[] {
  const snapshot = useStore((s) => s.snapshot)
  return useMemo(() => {
    if (!snapshot) return []
    const out: TvSystem[] = []
    const steam = snapshot.games.filter((g) => g.source !== 'emustart' && g.source !== 'demo').sort(byName)
    if (steam.length) out.push({ key: STEAM, display: 'Steam', games: steam, ready: steam.filter((g) => g.installed).length, logo: false })
    const emu = new Map<string, Game[]>()
    for (const g of snapshot.games) {
      if (!g.emu) continue
      const list = emu.get(g.emu.es)
      if (list) list.push(g)
      else emu.set(g.emu.es, [g])
    }
    for (const s of snapshot.emustart?.systems ?? []) {
      const games = (emu.get(s.es) ?? []).sort(byName)
      if (!games.length) continue
      out.push({ key: s.es, display: s.display, games, ready: games.filter((g) => g.emu?.cached).length, emulator: s.emulator, logo: !!s.hasLogo })
    }
    return out
  }, [snapshot])
}

/** "66 gier · 12 w pamięci podręcznej · RetroArch: Opera" — like EmuStart's carousel */
export function systemMeta(s: TvSystem): string {
  const n = s.games.length
  let t = `${n} ${plural(n, 'gra', 'gry', 'gier')}`
  if (s.ready) t += s.key === STEAM ? ` · ${s.ready} zainstalowanych` : ` · ${s.ready} w pamięci podręcznej`
  t += s.key === STEAM ? ' · klient Steam' : s.emulator ? ` · ${s.emulator}` : ' · brak emulatora'
  return t
}
