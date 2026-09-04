import { normalizeAccentColor } from '@shared/types'
import { useStore } from '../store'
import type { ResolvedTheme } from './theme'

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

/** The built-in accent per theme — what "Default" means, and what the swatch for it shows. */
export const DEFAULT_ACCENT: Record<ResolvedTheme, string> = { dark: '#4f8cff', light: '#2f6fe0' }

/** The page background per theme, which accent-as-text has to read against. */
const PAGE_BG: Record<ResolvedTheme, string> = { dark: '#0a0d12', light: '#f4f6fa' }

/** The two inks a filled accent button can carry; whichever contrasts better wins. */
const INK_DARK = '#06122e'
const INK_LIGHT = '#ffffff'

/** Minimum contrast for the accent used as text on the page background (WCAG AA). */
const TEXT_CONTRAST = 4.5

/* ---- Colour arithmetic (sRGB, small on purpose) --------------------------- */

type Rgb = [number, number, number]

function parse(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function format([r, g, b]: Rgb): string {
  const c = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** `amount` of the way from `a` to `b` (0 = a, 1 = b). */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio, 1..21. */
export function contrast(hexA: string, hexB: string): number {
  const la = luminance(parse(hexA))
  const lb = luminance(parse(hexB))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

/**
 * Nudge `rgb` toward white (dark theme) or black (light theme) in small steps
 * until it clears `ratio` against `bg`. A colour that already clears it is
 * returned untouched, so a well-chosen colour keeps its exact hue.
 */
function ensureContrast(rgb: Rgb, bg: string, ratio: number, theme: ResolvedTheme): Rgb {
  const toward = theme === 'dark' ? WHITE : BLACK
  let out = rgb
  for (let i = 0; i < 60 && contrast(format(out), bg) < ratio; i++) out = mix(out, toward, 0.04)
  return out
}

/* ---- Tokens ----------------------------------------------------------------- */

/** The custom properties a chosen accent overrides. */
export type AccentTokens = Record<'--color-accent' | '--color-accent-hover' | '--color-on-accent' | '--color-blue', string>

/**
 * Derive the four accent tokens for `hex` under `theme`.
 *
 *  - `--color-accent`: the colour, lightened (dark) or deepened (light) only as
 *    far as needed to read as text on the page background.
 *  - `--color-accent-hover`: dark lightens on hover, light darkens — the same
 *    direction the built-in tokens take, so hover never reads as fading out.
 *  - `--color-on-accent`: navy or white ink on an accent fill, whichever
 *    contrasts more.
 *  - `--color-blue`: the tinted-text companion (chips, selected labels). A pale
 *    tint of the accent on dark; a slightly deeper accent on light, mirroring
 *    how the built-in blue relates to the built-in accent in each theme.
 */
export function accentTokens(hex: string, theme: ResolvedTheme): AccentTokens {
  const base = ensureContrast(parse(hex), PAGE_BG[theme], TEXT_CONTRAST, theme)
  const accent = format(base)
  const hover = format(theme === 'dark' ? mix(base, WHITE, 0.15) : mix(base, BLACK, 0.2))
  const ink = contrast(accent, INK_LIGHT) >= contrast(accent, INK_DARK) ? INK_LIGHT : INK_DARK
  const blue = format(theme === 'dark' ? mix(base, WHITE, 0.4) : mix(base, BLACK, 0.1))
  return { '--color-accent': accent, '--color-accent-hover': hover, '--color-on-accent': ink, '--color-blue': blue }
}

const TOKEN_NAMES = ['--color-accent', '--color-accent-hover', '--color-on-accent', '--color-blue'] as const

/**
 * Set (or, for null, clear) the accent overrides on `root`. Clearing removes
 * the inline properties so the stylesheet's own per-theme values show through —
 * "Default" is the absence of an override, not a fifth copy of the blue.
 */
export function applyAccentColor(root: HTMLElement, hex: string | null, theme: ResolvedTheme): void {
  const color = normalizeAccentColor(hex)
  if (!color) {
    for (const name of TOKEN_NAMES) root.style.removeProperty(name)
    return
  }
  const tokens = accentTokens(color, theme)
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
