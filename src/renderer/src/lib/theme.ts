import { useEffect, useState } from 'react'
import type { ThemeMode } from '@shared/types'
import {
  DEFAULT_THEME_ID,
  THEMES,
  builtinTheme,
  isThemeId,
  themeById,
  themeStyleSheet,
  type ThemeAppearance,
  type ThemeId,
  type ThemeSpec
} from '@shared/themes'
import { useStore } from '../store'

/** The concrete appearance actually applied to the DOM — 'system' has been resolved away. */
export type ResolvedTheme = ThemeAppearance

/**
 * Display label for a theme setting. Shared so the View menu, the Settings
 * modal and the command palette name the same option identically.
 */
export function themeModeLabel(mode: ThemeMode): string {
  return mode === 'system' ? 'System' : themeById(mode).name
}

/** Media query used to resolve the 'system' theme against the OS preference. */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * The persisted theme SETTING — what the user picked ('system' or a theme id)
 * rather than what it currently resolves to. Theme controls need this to mark
 * the active option: a 'system' install resolving to dark must still show
 * System selected, not Orbital Dark.
 *
 * Defaults to 'dark' before settings load, and for installs predating this
 * setting, which preserves the original dark-only look. A stored id this build
 * does not ship (a newer build's theme, a hand-edited config) falls back the
 * same way rather than leaving the app with no theme at all.
 */
export function useThemeMode(): ThemeMode {
  const stored = useStore((s) => s.settings?.theme)
  return stored === 'system' || isThemeId(stored) ? stored : DEFAULT_THEME_ID
}

/**
 * Persist a new theme.
 *
 * Sends `theme` and nothing else. The theme lives in the machine-global slice
 * that every workspace instance shares, so writing a whole Settings object here
 * would push this window's snapshot of defaultShell / alerts / debugLogging over
 * whatever another instance had just changed — a one-click control writing five
 * unrelated fields is exactly how a lost update happens. Every theme control
 * funnels through here, so the View menu, the Settings modal and the palette
 * cannot drift apart: there is only one write path.
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
 * pinned a light theme — that annotation exists precisely for the user deciding
 * whether to un-pin, so gating the subscription on `mode === 'system'` would
 * make it report the pinned theme back at them and answer the wrong question.
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
 * The theme id actually applied to the DOM.
 *
 * 'system' tracks the OS preference live and resolves to the BUILT-IN theme for
 * it, so toggling the OS theme re-themes the app without a reload; any other
 * value is a pinned theme and simply wins. Layered over useSystemTheme so there
 * is exactly one matchMedia subscription concept in the app, and no second place
 * for its listener cleanup to be wrong.
 */
export function useThemeId(): ThemeId {
  const mode = useThemeMode()
  const systemTheme = useSystemTheme()
  return mode === 'system' ? builtinTheme(systemTheme) : mode
}

/** The full spec of the applied theme — its seed colours, and its code theme. */
export function useTheme(): ThemeSpec {
  return themeById(useThemeId())
}

/**
 * The appearance of the applied theme, i.e. whether the window is currently
 * light or dark. What everything outside the theme registry actually wants:
 * mermaid's diagram theme, the image-view checkerboard, the accent derivation.
 */
export function useResolvedTheme(): ResolvedTheme {
  return useTheme().appearance
}

/** The themes a picker offers, split the way someone actually chooses between them. */
export const DARK_THEMES: readonly ThemeSpec[] = THEMES.filter((t) => t.appearance === 'dark')
export const LIGHT_THEMES: readonly ThemeSpec[] = THEMES.filter((t) => t.appearance === 'light')

/**
 * Register the generated theme stylesheet, once.
 *
 * Injected at runtime rather than written into app.css because the themes are
 * derived from their seed colours (see shared/themes.ts) — a build step that
 * emitted forty CSS lines per theme would only be the same data, further from
 * the eight lines that define it. Called before the first render, so a pinned
 * theme paints on the first frame instead of flashing the built-in dark.
 */
export function installThemeStyles(doc: Document = document): void {
  const id = 'orbital-themes'
  if (doc.getElementById(id)) return
  const style = doc.createElement('style')
  style.id = id
  style.textContent = themeStyleSheet()
  doc.head.append(style)
}
