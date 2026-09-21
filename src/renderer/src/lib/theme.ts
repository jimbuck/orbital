import { useEffect, useState } from 'react'
import type { Settings, SettingsPatch, ThemeMode } from '@shared/types'
import {
  DEFAULT_THEME_ID,
  THEMES,
  isThemeId,
  normalizeSystemTheme,
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
 * Persist ONE theme setting, applying it immediately.
 *
 * Sends that key and nothing else. Writing a whole Settings object here would
 * push this window's snapshot of every other field over whatever had changed
 * meanwhile (a Save in the Settings modal, say). A one-click control writing a
 * dozen unrelated fields is exactly how a lost update happens.
 * Every theme control funnels through here, so the View menu, the Settings
 * modal and the palette cannot drift apart: there is only one write path.
 *
 * The store is updated optimistically: the write round-trips through the main
 * process before the state broadcast that would normally update it lands, and
 * re-theming the whole app should track the click rather than lag an IPC hop
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
 * The rollback is conditional: if the store has since moved on (a later click,
 * or a broadcast carrying another instance's change), that value is newer than
 * what this call knows and is left alone.
 */
function persistThemeSetting<K extends 'theme' | 'systemDarkTheme' | 'systemLightTheme' | 'fontLigatures'>(
  key: K,
  value: Settings[K]
): void {
  const settings = useStore.getState().settings
  if (!settings || settings[key] === value) return
  const previous = settings[key]
  useStore.setState({ settings: { ...settings, [key]: value } })
  void window.orbital.setSettings({ [key]: value } as SettingsPatch).catch((err: unknown) => {
    const current = useStore.getState().settings
    if (current && current[key] === value) {
      useStore.setState({ settings: { ...current, [key]: previous } })
    }
    console.error("Couldn't save the theme — it has been reverted.", err)
  })
}

/** Pin a theme, or hand the choice back to the OS with 'system'. */
export function setThemeMode(mode: ThemeMode): void {
  persistThemeSetting('theme', mode)
}

/**
 * Set the half of the system pair for `appearance` — what 'system' will mean
 * on a dark, or on a light, OS.
 *
 * Setting a half does NOT switch to System. Someone on a dark OS choosing
 * their light theme is configuring what happens at sunrise, and flipping the
 * window white to acknowledge the click would be a poor way to say so.
 */
export function setSystemTheme(appearance: ThemeAppearance, theme: ThemeId): void {
  persistThemeSetting(appearance === 'dark' ? 'systemDarkTheme' : 'systemLightTheme', theme)
}

/**
 * Whether the mono font draws its coding ligatures. Defaults to on before
 * settings load, and for installs predating the setting — the font's own look,
 * and what the app has always shipped.
 */
export function useFontLigatures(): boolean {
  return useStore((s) => s.settings?.fontLigatures) ?? true
}

/** Turn the coding ligatures on or off, through the same one write path. */
export function setFontLigatures(on: boolean): void {
  persistThemeSetting('fontLigatures', on)
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
 * The pair 'system' resolves to: the theme for a dark OS, and the one for a
 * light OS. Normalized on the way out for the same reasons main normalizes it
 * on the way in — the renderer can be handed a stale broadcast from a build
 * that shipped a theme this one does not, and a half naming the wrong
 * appearance must not survive that far.
 */
export function useSystemPair(): Record<ThemeAppearance, ThemeId> {
  const dark = useStore((s) => s.settings?.systemDarkTheme)
  const light = useStore((s) => s.settings?.systemLightTheme)
  return { dark: normalizeSystemTheme(dark, 'dark'), light: normalizeSystemTheme(light, 'light') }
}

/**
 * What 'system' would give right now, read once rather than subscribed to.
 *
 * For the callers that are not components: the palette builds its command list
 * from a store snapshot, so it cannot use the hooks, and the System row there
 * still has to name the theme it would apply. matchMedia is optional-chained
 * because this runs outside a React render and can be reached in environments
 * (jsdom, a test harness) that have no media queries at all.
 */
export function systemThemeId(): ThemeId {
  const dark = typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY)?.matches
  const settings = useStore.getState().settings
  return dark
    ? normalizeSystemTheme(settings?.systemDarkTheme, 'dark')
    : normalizeSystemTheme(settings?.systemLightTheme, 'light')
}

/**
 * What 'system' would give right now — the pair's half for the CURRENT OS
 * preference, whatever theme happens to be pinned.
 *
 * Separate from {@link useThemeId} because that is the question the controls
 * ask: the System row in the View menu annotates itself with this, and the
 * person reading it is deciding whether to un-pin. Answering with the applied
 * theme would tell them what they already have.
 */
export function useSystemThemeId(): ThemeId {
  return useSystemPair()[useSystemTheme()]
}

/**
 * The theme id actually applied to the DOM.
 *
 * 'system' tracks the OS preference live and resolves to the user's chosen
 * theme for it, so toggling the OS theme re-themes the app without a reload;
 * any other value is a pinned theme and simply wins. Layered over
 * useSystemTheme so there is exactly one matchMedia subscription concept in the
 * app, and no second place for its listener cleanup to be wrong.
 */
export function useThemeId(): ThemeId {
  const mode = useThemeMode()
  const systemThemeId = useSystemThemeId()
  return mode === 'system' ? systemThemeId : mode
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
