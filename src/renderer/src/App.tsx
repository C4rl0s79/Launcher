import { useEffect, useMemo, useRef, useState } from 'react'
import { api, groupTab, sortedCategories, tabCategoryId, useStore, type Tab } from './store'
import { installGamepad, installKeyboard, installXInputGamepad, useActions } from './nav/input'
import { focusFirst } from './nav/engine'
import { TopBar } from './components/TopBar'
import { HintsBar } from './components/Hints'
import { Toasts } from './components/Toasts'
import { HomeScreen } from './screens/Home'
import { GroupScreen } from './screens/Group'
import { SettingsScreen } from './screens/Settings'
import { DetailsScreen } from './screens/Details'
import { EmuLaunchOverlay, JobsPanel } from './components/Jobs'
import { PathPicker } from './modals/PathPicker'
import { TvApp } from './tv/TvApp'

/** Start, the pinned groups (in their order), Settings. */
export function useTabs(): Tab[] {
  const prefs = useStore((s) => s.prefs)
  return useMemo(
    () => ['home', ...(prefs ? sortedCategories(prefs).filter((c) => c.pinned).map((c) => groupTab(c.id)) : []), 'settings'],
    [prefs]
  )
}

export function App() {
  const tab = useStore((s) => s.tab)
  const prefs = useStore((s) => s.prefs)
  const detailsId = useStore((s) => s.detailsId)
  const loaded = useStore((s) => !!s.snapshot && !!s.prefs && !!s.settings)
  const tabs = useTabs()
  const tvLayout = useStore((s) => s.uiMode === 'fullscreen' && s.settings?.tvInterface !== 'emustart')
  const rootRef = useRef<HTMLDivElement>(null)
  // group screens are mounted on first visit and then kept, so scroll position and focus survive tab switches
  const [visited, setVisited] = useState<Set<string>>(() => new Set([tab]))

  useEffect(() => {
    const s = useStore.getState()
    const a = api()
    void a.library.get().then(s.setSnapshot)
    void a.prefs.get().then(s.setPrefs)
    void a.settings.get().then(s.setSettings)
    void a.jobs.get().then(s.setJobs)
    void a.ui.getMode().then((m) => s.setUiMode(m))
    const offs = [
      a.library.onSnapshot(s.setSnapshot),
      a.jobs.onChange(s.setJobs),
      // back from the fullscreen interface: show the game that was selected there
      a.ui.onMode((mode, selection) => {
        useStore.getState().setUiMode(mode, selection)
        const st = useStore.getState()
        if (mode !== 'desktop' || !selection || st.detailsId === selection) return
        if (st.snapshot?.games.some((g) => g.id === selection)) st.openDetails(selection)
      }),
      a.prefs.onChange(s.setPrefs),
      a.settings.onChange(s.setSettings),
      a.art.onChanged(s.bumpArt),
      installKeyboard()
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // controller backend: XInput from the main process (default) or the Chromium Gamepad API
  const backend = useStore((s) => (s.settings?.gamepadBackend === 'chromium' || s.settings?.xinputAvailable === false ? 'chromium' : s.settings ? 'xinput' : null))
  useEffect(() => {
    if (!backend) return
    return backend === 'xinput' ? installXInputGamepad() : installGamepad()
  }, [backend])

  // a tab that is no longer pinned (or a stale saved one) falls back to Start
  useEffect(() => {
    if (prefs && !tabs.includes(tab)) useStore.getState().setTab('home')
  }, [prefs, tabs, tab])

  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)))
  }, [tab])

  // when switching tabs, move focus into the newly visible screen
  useEffect(() => {
    if (!loaded || detailsId) return
    // Virtualised content (grids) appears a moment after mount, so wait briefly for the
    // screen's preferred target instead of landing on whatever happens to be rendered first.
    let tries = 0
    let r: ReturnType<typeof setTimeout>
    const attempt = (): void => {
      const screen = document.querySelector<HTMLElement>(`[data-screen="${CSS.escape(tab)}"]`)
      if (!screen) {
        if (tries++ < 10) r = setTimeout(attempt, 50)
        return
      }
      if (screen.contains(document.activeElement)) return
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
    const i = Math.max(0, tabs.indexOf(s.tab))
    s.setTab(tabs[(i + delta + tabs.length) % tabs.length])
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
      // search lives in group views; from Start/Settings jump to the first group
      const s = useStore.getState()
      const target = tabCategoryId(s.tab) ? s.tab : tabs.find((t) => tabCategoryId(t))
      if (!target) return true
      s.setTab(target)
      setTimeout(
        () => document.querySelector<HTMLInputElement>(`[data-screen="${CSS.escape(target)}"] input[data-key="search"]`)?.focus(),
        0
      )
      return true
    }
  }, { enabled: !tvLayout })

  if (!loaded || !prefs) {
    return (
      <div className="boot">
        <div className="brand brand--big">lumen</div>
        <div className="boot__spinner" />
      </div>
    )
  }

  const categories = sortedCategories(prefs)

  // the TV layout of the same interface (fullscreen mode; docs/PLAN-TV-REACT.md)
  if (tvLayout)
    return (
      <>
        <TvApp />
        {detailsId && <DetailsScreen key={detailsId} gameId={detailsId} />}
        <JobsPanel />
        <EmuLaunchOverlay />
        <PathPicker />
        <Toasts />
      </>
    )

  return (
    <>
      <div className="app" ref={rootRef} data-layer inert={detailsId ? true : undefined}>
        <TopBar tabs={tabs} />
        <main className="screens">
          {tabs
            .filter((t) => t === tab || visited.has(t))
            .map((t) => {
              const catId = tabCategoryId(t)
              const cat = catId ? categories.find((c) => c.id === catId) : undefined
              const isActive = t === tab && !detailsId
              return (
                <section key={t} className={`screen ${t === tab ? 'is-active' : ''}`} data-screen={t} inert={t !== tab ? true : undefined}>
                  {t === 'home' && <HomeScreen active={isActive} />}
                  {t === 'settings' && <SettingsScreen active={isActive} />}
                  {cat && <GroupScreen category={cat} active={isActive} />}
                </section>
              )
            })}
        </main>
      </div>
      {detailsId && <DetailsScreen key={detailsId} gameId={detailsId} />}
      <JobsPanel />
      <EmuLaunchOverlay />
      <PathPicker />
      <HintsBar />
      <Toasts />
    </>
  )
}
