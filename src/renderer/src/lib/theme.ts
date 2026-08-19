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
 * The settings bridge takes a whole Settings object (main splits it across the
 * machine-global store and the workspace file), so this reads the current
 * settings and writes them back with only `theme` changed. Every theme control
 * funnels through here — the View menu and the Settings modal cannot drift apart
 * because there is only one write path.
 *
 * The store is also updated optimistically: the write round-trips through the
 * main process before the state broadcast that would normally update it lands,
 * and re-theming the whole app should track the click rather than lag an IPC hop
 * behind it. The broadcast then overwrites this with the authoritative value.
 *
 * No-ops until settings have loaded — there is nothing to merge the theme into
 * yet, and writing a fabricated Settings object would clobber the real one.
 */
export function setThemeMode(mode: ThemeMode): void {
  const settings = useStore.getState().settings
  if (!settings || settings.theme === mode) return
  const next = { ...settings, theme: mode }
  useStore.setState({ settings: next })
  void window.orbital.setSettings(next)
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
