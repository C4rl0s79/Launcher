import { useEffect, useRef } from 'react'
import { api, useStore, type Tab } from './store'
import { installGamepad, installKeyboard, useActions } from './nav/input'
import { focusFirst } from './nav/engine'
import { TopBar } from './components/TopBar'
import { HintsBar } from './components/Hints'
import { Toasts } from './components/Toasts'
import { HomeScreen } from './screens/Home'
import { LibraryScreen } from './screens/Library'
import { SettingsScreen } from './screens/Settings'
import { DetailsScreen } from './screens/Details'

const TABS: Tab[] = ['home', 'library', 'settings']

export function App() {
  const tab = useStore((s) => s.tab)
  const detailsId = useStore((s) => s.detailsId)
  const loaded = useStore((s) => !!s.snapshot && !!s.prefs && !!s.settings)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const s = useStore.getState()
    const a = api()
    void a.library.get().then(s.setSnapshot)
    void a.prefs.get().then(s.setPrefs)
    void a.settings.get().then(s.setSettings)
    const offs = [
      a.library.onSnapshot(s.setSnapshot),
      a.prefs.onChange(s.setPrefs),
      a.settings.onChange(s.setSettings),
      a.art.onChanged(s.bumpArt),
      installKeyboard(),
      installGamepad()
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // when switching tabs, move focus into the newly visible screen
  useEffect(() => {
    if (!loaded || detailsId) return
    // Virtualised content (library grid) appears a moment after mount, so wait briefly for the
    // screen's preferred target instead of landing on whatever happens to be rendered first.
    let tries = 0
    let r: ReturnType<typeof setTimeout>
    const attempt = (): void => {
      const screen = document.querySelector<HTMLElement>(`[data-screen="${tab}"]`)
      if (!screen || screen.contains(document.activeElement)) return
      if (!screen.querySelector('[data-autofocus]') && tries++ < 10) {
        r = setTimeout(attempt, 50)
        return
      }
      focusFirst(screen)
    }
    r = setTimeout(attempt, 0)
    return () => clearTimeout(r)
  }, [tab, loaded, detailsId])

  const switchTab = (delta: number): boolean => {
    const s = useStore.getState()
    const i = TABS.indexOf(s.tab)
    s.setTab(TABS[(i + delta + TABS.length) % TABS.length])
    return true
  }

  useActions({
    lb: () => switchTab(-1),
    rb: () => switchTab(1),
    menu: () => {
      useStore.getState().setTab('settings')
      return true
    },
    y: () => {
      useStore.getState().setTab('library')
      setTimeout(() => document.querySelector<HTMLInputElement>('[data-screen="library"] input[data-key="search"]')?.focus(), 0)
      return true
    }
  })

  if (!loaded) {
    return (
      <div className="boot">
        <div className="brand brand--big">lumen</div>
        <div className="boot__spinner" />
      </div>
    )
  }

  return (
    <>
      <div className="app" ref={rootRef} data-layer inert={detailsId ? true : undefined}>
        <TopBar />
        <main className="screens">
          {TABS.map((t) => (
            <section key={t} className={`screen ${t === tab ? 'is-active' : ''}`} data-screen={t} inert={t !== tab ? true : undefined}>
              {t === 'home' && <HomeScreen active={tab === 'home' && !detailsId} />}
              {t === 'library' && <LibraryScreen active={tab === 'library' && !detailsId} />}
              {t === 'settings' && <SettingsScreen active={tab === 'settings' && !detailsId} />}
            </section>
          ))}
        </main>
      </div>
      {detailsId && <DetailsScreen key={detailsId} gameId={detailsId} />}
      <HintsBar />
      <Toasts />
    </>
  )
}
