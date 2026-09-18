import { normalizeAccentColor } from '@shared/types'
import { accentTokens as deriveAccentTokens, themeById, type AccentTokens } from '@shared/themes'
import { contrast } from '@shared/color'
import { useStore } from '../store'
import type { ResolvedTheme } from './theme'

export { contrast }

/**
 * Per-workspace accent colour.
 *
 * Every accent-tinted surface in the app — primary buttons, focus rings, the
 * active tab, the title-bar orb, `text-blue` labels — is a Tailwind utility
 * compiled to `var(--color-accent)` (or one of its three companions). So the
 * whole app re-tints by redefining four custom properties on `<html>`, and a
 * workspace that picks its own colour is told apart from the next window at a
 * glance, before any title is read.
 *
 * The colour the user picks is ONE hex. The four tokens the CSS actually needs
 * are derived from it, per resolved theme, because a colour that reads on a
 * near-black pane rarely reads on white: the light theme's built-in accent is
 * a deeper blue than the dark theme's for exactly that reason. The derivation
 * is the same arithmetic the hand-tuned defaults followed, applied
 * automatically so a custom colour cannot produce unreadable UI.
 */

/** A preset offered in Settings. `hex` is the dark-theme reading; see {@link accentTokens}. */
export interface AccentPreset {
  name: string
  hex: string
}

/**
 * The palette offered beside "Default". Chosen to be distinct from each other
 * and from the built-in blue at swatch size, since telling windows apart is the
 * point — and to stay pleasant after the light-theme deepening.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { name: 'Violet', hex: '#8b7cf6' },
  { name: 'Magenta', hex: '#d96ee0' },
  { name: 'Rose', hex: '#f06a8a' },
  { name: 'Orange', hex: '#f0904a' },
  { name: 'Amber', hex: '#e8b54a' },
  { name: 'Green', hex: '#3ddc97' },
  { name: 'Teal', hex: '#2fc4c4' },
  { name: 'Sky', hex: '#38bdf8' }
]

/** The Orbital themes' own accents — the built-in blue each one means by "Default". */
export const DEFAULT_ACCENT: Record<ResolvedTheme, string> = {
  dark: themeById('dark').accent,
  light: themeById('light').accent
}

/**
 * The page background an accent has to read against when the caller names no
 * theme. A registry theme passes its own `bg` instead (see ThemeManager in
 * App.tsx): a colour that clears 4.5:1 on Orbital's near-black says nothing
 * about how it fares on Solarized Light.
 */
const PAGE_BG: Record<ResolvedTheme, string> = { dark: themeById('dark').bg, light: themeById('light').bg }

/* ---- Tokens ----------------------------------------------------------------- */

export type { AccentTokens }

/**
 * Derive the four accent tokens for `hex` under `theme`. The arithmetic lives
 * in shared/themes.ts, where the themes themselves use it for their own
 * accents; this wrapper only supplies the built-in page background so the
 * common call stays two arguments.
 */
export function accentTokens(hex: string, theme: ResolvedTheme, pageBg: string = PAGE_BG[theme]): AccentTokens {
  return deriveAccentTokens(hex, theme, pageBg)
}

const TOKEN_NAMES = ['--color-accent', '--color-accent-hover', '--color-on-accent', '--color-blue'] as const

/**
 * Set (or, for null, clear) the accent overrides on `root`. Clearing removes
 * the inline properties so the stylesheet's own per-theme values show through —
 * "Default" is the absence of an override, not a fifth copy of the blue.
 */
export function applyAccentColor(
  root: HTMLElement,
  hex: string | null,
  theme: ResolvedTheme,
  pageBg?: string
): void {
  const color = normalizeAccentColor(hex)
  if (!color) {
    for (const name of TOKEN_NAMES) root.style.removeProperty(name)
    return
  }
  const tokens = accentTokens(color, theme, pageBg)
  for (const name of TOKEN_NAMES) root.style.setProperty(name, tokens[name])
}

/* ---- Store ----------------------------------------------------------------- */

/** The persisted accent for this workspace, or null for the built-in blue. */
export function useAccentColor(): string | null {
  return useStore((s) => s.settings?.accentColor) ?? null
}

/**
 * Re-tint the app without persisting — what a colour picker being dragged
 * does. Store-only, so the next state broadcast puts the persisted value back
 * unless {@link setAccentColor} follows.
 */
export function previewAccentColor(color: string | null): void {
  const settings = useStore.getState().settings
  if (!settings) return
  const next = normalizeAccentColor(color)
  if (settings.accentColor === next) return
  useStore.setState({ settings: { ...settings, accentColor: next } })
}

/**
 * Persist a new accent colour, applying it immediately and rolling back if the
 * write fails. Sends `accentColor` and nothing else, and mirrors setThemeMode
 * in lib/theme.ts in every respect — see there for why the optimistic apply,
 * the rollback, and its being conditional are each the right call. One
 * difference in kind: the accent is workspace-scoped, so unlike the theme it is
 * this window's alone and no other instance can move it under us.
 */
export function setAccentColor(color: string | null): void {
  const settings = useStore.getState().settings
  if (!settings) return
  const next = normalizeAccentColor(color)
  const previous = settings.accentColor
  if (previous !== next) useStore.setState({ settings: { ...settings, accentColor: next } })
  void window.orbital.setSettings({ accentColor: next }).catch((err: unknown) => {
    const current = useStore.getState().settings
    if (current && current.accentColor === next) {
      useStore.setState({ settings: { ...current, accentColor: previous } })
    }
    console.error("Couldn't save the accent colour — it has been reverted.", err)
  })
}
