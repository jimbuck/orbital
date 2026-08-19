import { useEffect, useState } from 'react'
import type { ThemeMode } from '@shared/types'
import { useStore } from '../store'

/** The concrete theme actually applied to the DOM — 'system' has been resolved away. */
export type ResolvedTheme = 'light' | 'dark'

/** The three modes offered by every theme control, in the order they are shown. */
export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']

/**
 * Display label for a mode. Shared so the View menu and the Settings modal name
 * the same option identically — the modal used to lean on a `capitalize` class
 * over the raw value, which would diverge the moment a mode needs a label that
 * isn't just its value with a capital letter.
 */
export function themeModeLabel(mode: ThemeMode): string {
  return mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'
}

/** Media query used to resolve the 'system' theme against the OS preference. */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * The persisted theme MODE ('system' | 'light' | 'dark'), i.e. what the user
 * picked rather than what it currently resolves to. Theme controls need this to
 * mark the active option — a 'system' install resolving to dark must still show
 * System selected, not Dark. Defaults to 'dark' before settings load, and for
 * installs predating this setting, which preserves the original dark-only look.
 */
export function useThemeMode(): ThemeMode {
  return useStore((s) => s.settings?.theme) ?? 'dark'
}

/**
 * Persist a new theme mode.
 *
 * Sends `theme` and nothing else. The theme lives in the machine-global slice
 * that every workspace instance shares, so writing a whole Settings object here
 * would push this window's snapshot of defaultShell / alerts / debugLogging over
 * whatever another instance had just changed — a one-click control writing five
 * unrelated fields is exactly how a lost update happens. Every theme control
 * funnels through here, so the View menu and the Settings modal cannot drift
 * apart: there is only one write path.
 *
 * The store is still updated optimistically: the write round-trips through the
 * main process before the state broadcast that would normally update it lands,
 * and re-theming the whole app should track the click rather than lag an IPC hop
 * behind it. The broadcast then overwrites this with the authoritative value.
 *
 * No-ops until settings have loaded — with nothing to update optimistically the
 * app would not re-theme until the next broadcast anyway, and there is no user
 * to please before the first state arrives.
 *
 * If the write fails the optimistic apply is rolled back. That is the deliberate
 * choice here, over both alternatives:
 *
 * - Leaving the new theme applied is the worst option. The user is shown a
 *   success that never happened, and the app then contradicts it minutes later,
 *   when some unrelated state broadcast lands and snaps the theme back with no
 *   apparent cause. Rolling back puts the failure where the user can connect it
 *   to something — the click they just made visibly did not take.
 * - Popping a message would mean inventing an app-wide notification surface,
 *   which Orbital does not have; this control is also reachable from the View
 *   menu, where there is nothing to render one into. That is disproportionate for
 *   a failure that needs the settings row to be locked by another process for
 *   several seconds. The console line is for whoever is debugging that case.
 *
 * The rollback is conditional: if the store has since moved to some other theme
 * (a later click, or a broadcast carrying another instance's change), that value
 * is newer than what this call knows and is left alone.
 */
export function setThemeMode(mode: ThemeMode): void {
  const settings = useStore.getState().settings
  if (!settings || settings.theme === mode) return
  const previous = settings.theme
  useStore.setState({ settings: { ...settings, theme: mode } })
  void window.orbital.setSettings({ theme: mode }).catch((err: unknown) => {
    const current = useStore.getState().settings
    if (current && current.theme === mode) {
      useStore.setState({ settings: { ...current, theme: previous } })
    }
    console.error("Couldn't save the theme — it has been reverted.", err)
  })
}

/**
 * The OS's own colour preference, tracked live via matchMedia.
 *
 * Deliberately independent of the persisted mode: this is what the OS wants,
 * not what Orbital is currently showing. A control that needs to say "System
 * would mean dark right now" has to keep asking the OS even while the user has
 * pinned Light — that annotation exists precisely for the user deciding whether
 * to un-pin, so gating the subscription on `mode === 'system'` would make it
 * report the pinned theme back at them and answer the wrong question.
 */
export function useSystemTheme(): ResolvedTheme {
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches
  )

  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    // Sync once on subscribe in case the preference changed between the initial
    // render and this effect running.
    setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return systemDark ? 'dark' : 'light'
}

/**
 * Resolve the persisted theme setting to a concrete 'light'|'dark' — i.e. the
 * theme actually applied to the DOM.
 *
 * When the mode is 'system' this tracks the OS preference live, so toggling the
 * OS theme re-themes the app without a reload; a pinned mode simply wins.
 * Layered over useSystemTheme so there is exactly one matchMedia subscription
 * concept in the app, and no second place for its listener cleanup to be wrong.
 */
export function useResolvedTheme(): ResolvedTheme {
  const mode = useThemeMode()
  const systemTheme = useSystemTheme()
  return mode === 'system' ? systemTheme : mode
}
