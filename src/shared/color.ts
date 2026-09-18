/**
 * Small sRGB colour arithmetic.
 *
 * Shared by the accent derivation (lib/accent.ts) and the theme registry
 * (shared/themes.ts) so a colour is lightened, darkened and contrast-checked the
 * same way wherever it happens — the themes are built out of exactly the moves
 * the hand-tuned accent already made, which is why they can be declared as a
 * handful of seed colours instead of forty tokens each.
 *
 * Deliberately tiny and dependency-free: everything here is sRGB hex in, sRGB
 * hex out, no colour-space library, no perceptual model. Good enough for
 * nudging a palette into legibility, and it keeps this out of the bundle's way.
 */

export type Rgb = [number, number, number]

export const WHITE = '#ffffff'
export const BLACK = '#000000'

/** `#rrggbb` (or `#rgb`) to channel values. */
export function parseHex(hex: string): Rgb {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Channel values back to `#rrggbb`, clamped and rounded. */
export function formatHex([r, g, b]: Rgb): string {
  const c = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** `amount` of the way from `a` to `b` (0 = a, 1 = b). */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]
}

/** {@link mix} for hex strings — the form nearly every caller wants. */
export function blend(a: string, b: string, amount: number): string {
  return formatHex(mix(parseHex(a), parseHex(b), amount))
}

/** `#rrggbb` as a `rgb(r g b / a)` string, for the tokens that bake in alpha. */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex)
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${alpha})`
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two hex colours, 1..21. */
export function contrast(hexA: string, hexB: string): number {
  const la = luminance(parseHex(hexA))
  const lb = luminance(parseHex(hexB))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Nudge `hex` toward `toward` (white on a dark background, black on a light
 * one) in small steps until it clears `ratio` against `bg`. A colour that
 * already clears it is returned untouched, so a well-chosen colour keeps its
 * exact hue — this is a rescue, not a normalisation.
 *
 * The step count is bounded rather than solved for: sixty 4% steps reach the
 * target from anywhere, and a colour that somehow cannot get there returns the
 * closest it managed instead of looping.
 */
export function ensureContrast(hex: string, bg: string, ratio: number, toward: string): string {
  const target = parseHex(toward)
  let out = parseHex(hex)
  for (let i = 0; i < 60 && contrast(formatHex(out), bg) < ratio; i++) out = mix(out, target, 0.04)
  return formatHex(out)
}
