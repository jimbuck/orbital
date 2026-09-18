import { BLACK, WHITE, blend, contrast, ensureContrast, rgba } from './color'

/**
 * The theme registry.
 *
 * Orbital's look is ~40 CSS custom properties (see app.css). Hand-writing all
 * forty for every theme would be forty chances per theme to leave a surface
 * unreadable, and no way to tell whether two themes agree about what "panel" is
 * one step lighter than. So a theme is declared as the handful of colours it is
 * actually *about* — the page, the working surface, the text, the accent and
 * five status hues — and {@link themeTokens} derives the rest with the same
 * arithmetic the hand-tuned built-ins follow: surfaces step away from the page,
 * the text ladder fades toward it, status hues are contrast-rescued against the
 * surface they sit on.
 *
 * The two built-ins stay in app.css and are NOT derived. Their token values are
 * hand-tuned and shipped; re-deriving them would move the existing app's colours
 * by a hair for no reason. They appear here because the terminal palette, the
 * syntax theme and the accent picker's "Default" swatch all need to know a
 * theme's seed colours, built-in or not.
 */

export type ThemeAppearance = 'light' | 'dark'

export interface ThemeSpec {
  /** Stored in settings. 'dark' and 'light' are the pre-theme-registry values. */
  id: ThemeId
  name: string
  appearance: ThemeAppearance
  /** True for the two themes whose tokens live in app.css (see above). */
  builtin?: boolean
  /** The page behind everything — the rail and title bar are a step off this. */
  bg: string
  /** The working surface: panes, panels, menus. Usually the editor background. */
  surface: string
  /** Primary text on `surface`. The rest of the text ladder fades toward `bg`. */
  text: string
  /** Buttons, focus rings, the active tab, links. */
  accent: string
  red: string
  green: string
  amber: string
  purple: string
  cyan: string
  /** Bundled shiki theme used for code in the editor, diffs and markdown fences. */
  code: string
}

/**
 * Every theme, in the order the pickers show them. Ordered Orbital first, then
 * editor-inspired, then the community classics — within each appearance, since
 * dark-vs-light is what someone is actually choosing between.
 *
 * Seed colours are taken from each theme's own published palette (the editor
 * background, its foreground, its ANSI/diagnostic hues) rather than eyeballed,
 * so "Nord" reads as Nord rather than as Orbital wearing a blue coat.
 */
const SPECS = [
  {
    id: 'dark',
    name: 'Orbital Dark',
    appearance: 'dark',
    builtin: true,
    bg: '#0a0d12',
    surface: '#0d1118',
    text: '#e6ebf2',
    accent: '#4f8cff',
    red: '#ff6b6b',
    green: '#3ddc97',
    amber: '#e8b54a',
    purple: '#c4a7f0',
    cyan: '#6fe6b3',
    code: 'github-dark-default'
  },
  {
    id: 'light',
    name: 'Orbital Light',
    appearance: 'light',
    builtin: true,
    bg: '#f4f6fa',
    surface: '#ffffff',
    text: '#17202e',
    accent: '#2f6fe0',
    red: '#dc2626',
    green: '#12915a',
    amber: '#b7791f',
    purple: '#7c3aed',
    cyan: '#0e7490',
    code: 'github-light-default'
  },

  /* ---- Editor-inspired ---------------------------------------------------- */
  {
    id: 'vscode-dark',
    name: 'VS Code Dark+',
    appearance: 'dark',
    bg: '#181818',
    surface: '#1f1f1f',
    text: '#d4d4d4',
    accent: '#3794ff',
    red: '#f14c4c',
    green: '#89d185',
    amber: '#cca700',
    purple: '#c586c0',
    cyan: '#4ec9b0',
    code: 'dark-plus'
  },
  {
    id: 'vscode-light',
    name: 'VS Code Light+',
    appearance: 'light',
    bg: '#f3f3f3',
    surface: '#ffffff',
    text: '#1f1f1f',
    accent: '#005fb8',
    red: '#e51400',
    green: '#388a34',
    amber: '#bf8803',
    purple: '#af00db',
    cyan: '#0598bc',
    code: 'light-plus'
  },
  {
    id: 'darcula',
    name: 'Darcula',
    appearance: 'dark',
    bg: '#3c3f41',
    surface: '#2b2b2b',
    text: '#a9b7c6',
    accent: '#589df6',
    red: '#ff6b68',
    green: '#6a8759',
    amber: '#ffc66d',
    purple: '#9876aa',
    cyan: '#6897bb',
    code: 'dark-plus'
  },
  {
    id: 'intellij-light',
    name: 'IntelliJ Light',
    appearance: 'light',
    bg: '#f2f2f2',
    surface: '#ffffff',
    text: '#1c1c1c',
    accent: '#3574f0',
    red: '#c7222d',
    green: '#067d17',
    amber: '#b28b00',
    purple: '#871094',
    cyan: '#067d7d',
    code: 'light-plus'
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    appearance: 'dark',
    bg: '#21252b',
    surface: '#282c34',
    text: '#abb2bf',
    accent: '#61afef',
    red: '#e06c75',
    green: '#98c379',
    amber: '#e5c07b',
    purple: '#c678dd',
    cyan: '#56b6c2',
    code: 'one-dark-pro'
  },
  {
    id: 'one-light',
    name: 'One Light',
    appearance: 'light',
    bg: '#eaeaeb',
    surface: '#fafafa',
    text: '#383a42',
    accent: '#4078f2',
    red: '#e45649',
    green: '#50a14f',
    amber: '#c18401',
    purple: '#a626a4',
    cyan: '#0184bc',
    code: 'one-light'
  },

  /* ---- Community classics -------------------------------------------------- */
  {
    id: 'dracula',
    name: 'Dracula',
    appearance: 'dark',
    bg: '#21222c',
    surface: '#282a36',
    text: '#f8f8f2',
    accent: '#bd93f9',
    red: '#ff5555',
    green: '#50fa7b',
    amber: '#f1fa8c',
    purple: '#ff79c6',
    cyan: '#8be9fd',
    code: 'dracula'
  },
  {
    id: 'nord',
    name: 'Nord',
    appearance: 'dark',
    bg: '#2e3440',
    surface: '#3b4252',
    text: '#eceff4',
    accent: '#88c0d0',
    red: '#bf616a',
    green: '#a3be8c',
    amber: '#ebcb8b',
    purple: '#b48ead',
    cyan: '#8fbcbb',
    code: 'nord'
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    appearance: 'dark',
    bg: '#16161e',
    surface: '#1a1b26',
    text: '#c0caf5',
    accent: '#7aa2f7',
    red: '#f7768e',
    green: '#9ece6a',
    amber: '#e0af68',
    purple: '#bb9af7',
    cyan: '#7dcfff',
    code: 'tokyo-night'
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    appearance: 'dark',
    bg: '#181825',
    surface: '#1e1e2e',
    text: '#cdd6f4',
    accent: '#89b4fa',
    red: '#f38ba8',
    green: '#a6e3a1',
    amber: '#f9e2af',
    purple: '#cba6f7',
    cyan: '#94e2d5',
    code: 'catppuccin-mocha'
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    appearance: 'dark',
    bg: '#010409',
    surface: '#0d1117',
    text: '#e6edf3',
    accent: '#4493f8',
    red: '#f85149',
    green: '#3fb950',
    amber: '#d29922',
    purple: '#ab7df8',
    cyan: '#39c5cf',
    code: 'github-dark-default'
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    appearance: 'dark',
    bg: '#1d2021',
    surface: '#282828',
    text: '#ebdbb2',
    accent: '#83a598',
    red: '#fb4934',
    green: '#b8bb26',
    amber: '#fabd2f',
    purple: '#d3869b',
    cyan: '#8ec07c',
    code: 'gruvbox-dark-medium'
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    appearance: 'dark',
    bg: '#002b36',
    surface: '#073642',
    text: '#93a1a1',
    accent: '#268bd2',
    red: '#dc322f',
    green: '#859900',
    amber: '#b58900',
    purple: '#d33682',
    cyan: '#2aa198',
    code: 'solarized-dark'
  },
  {
    id: 'monokai',
    name: 'Monokai',
    appearance: 'dark',
    bg: '#1e1f1c',
    surface: '#272822',
    text: '#f8f8f2',
    accent: '#66d9ef',
    red: '#f92672',
    green: '#a6e22e',
    amber: '#e6db74',
    purple: '#ae81ff',
    cyan: '#a1efe4',
    code: 'monokai'
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    appearance: 'light',
    bg: '#e6e9ef',
    surface: '#eff1f5',
    text: '#4c4f69',
    accent: '#1e66f5',
    red: '#d20f39',
    green: '#40a02b',
    amber: '#df8e1d',
    purple: '#8839ef',
    cyan: '#179299',
    code: 'catppuccin-latte'
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    appearance: 'light',
    bg: '#f6f8fa',
    surface: '#ffffff',
    text: '#1f2328',
    accent: '#0969da',
    red: '#cf222e',
    green: '#1a7f37',
    amber: '#9a6700',
    purple: '#8250df',
    cyan: '#1b7c83',
    code: 'github-light-default'
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    appearance: 'light',
    bg: '#f2e5bc',
    surface: '#fbf1c7',
    text: '#3c3836',
    accent: '#076678',
    red: '#9d0006',
    green: '#79740e',
    amber: '#b57614',
    purple: '#8f3f71',
    cyan: '#427b58',
    code: 'gruvbox-light-medium'
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    appearance: 'light',
    bg: '#eee8d5',
    surface: '#fdf6e3',
    text: '#586e75',
    accent: '#268bd2',
    red: '#dc322f',
    green: '#859900',
    amber: '#b58900',
    purple: '#d33682',
    cyan: '#2aa198',
    code: 'solarized-light'
  }
] as const

/**
 * Every theme id the app knows, as a union — so a typo cannot reach settings.
 * Derived from the literal ids above, which is why {@link SPECS} is declared
 * without a type annotation: annotating it would widen `id` to `string` and
 * this union with it. The structural check happens one line down, on THEMES.
 */
export type ThemeId = (typeof SPECS)[number]['id']

/** The registry proper — {@link SPECS}, checked against {@link ThemeSpec}. */
export const THEMES: readonly ThemeSpec[] = SPECS

/** The default theme, and what an unrecognized stored value falls back to. */
export const DEFAULT_THEME_ID: ThemeId = 'dark'

const BY_ID = new Map<string, ThemeSpec>(THEMES.map((t) => [t.id, t]))

/** The spec for `id`, or the default theme when this build has never heard of it. */
export function themeById(id: string | undefined | null): ThemeSpec {
  return (id != null && BY_ID.get(id)) || BY_ID.get(DEFAULT_THEME_ID)!
}

/** Whether `value` names a theme this build ships. */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && BY_ID.has(value)
}

/** The built-in theme for an appearance — what 'system' resolves to. */
export function builtinTheme(appearance: ThemeAppearance): ThemeId {
  return appearance === 'light' ? 'light' : 'dark'
}

/* ---- Accent tokens --------------------------------------------------------- */

/** The two inks a filled accent button can carry; whichever contrasts better wins. */
const INK_DARK = '#06122e'
const INK_LIGHT = '#ffffff'

/** Minimum contrast for the accent used as text on the page background (WCAG AA). */
const TEXT_CONTRAST = 4.5

/** The custom properties an accent — a theme's own, or the workspace override — sets. */
export type AccentTokens = Record<
  '--color-accent' | '--color-accent-hover' | '--color-on-accent' | '--color-blue',
  string
>

/**
 * Derive the four accent tokens for `hex` on a `pageBg` of the given appearance.
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
export function accentTokens(hex: string, appearance: ThemeAppearance, pageBg: string): AccentTokens {
  const dark = appearance === 'dark'
  const accent = ensureContrast(hex, pageBg, TEXT_CONTRAST, dark ? WHITE : BLACK)
  const hover = dark ? blend(accent, WHITE, 0.15) : blend(accent, BLACK, 0.2)
  const ink = contrast(accent, INK_LIGHT) >= contrast(accent, INK_DARK) ? INK_LIGHT : INK_DARK
  const blue = dark ? blend(accent, WHITE, 0.4) : blend(accent, BLACK, 0.1)
  return { '--color-accent': accent, '--color-accent-hover': hover, '--color-on-accent': ink, '--color-blue': blue }
}

/* ---- Theme tokens ---------------------------------------------------------- */

/** Minimum contrast a status hue must clear against the surface it labels. */
const STATUS_CONTRAST = 4

/**
 * The text ladder: how far each rung fades from the primary text toward the
 * page background, and the contrast it may not fall below on the surface it
 * sits on.
 *
 * The floor matters because the fade is a fraction, not a target: a theme whose
 * foreground is a low-contrast grey by design (Catppuccin Latte, Solarized)
 * starts the ladder much closer to the background than Orbital's does, and a
 * flat 25% of the way there lands its secondary text under 4:1. The rescue only
 * bites on those themes; everywhere else the rungs come out of the blend
 * untouched. `faint` has no floor — it is hairlines and placeholders, and
 * forcing it up to readable would flatten it into `dim`.
 */
const TEXT_LADDER: readonly { name: string; amount: number; min: number }[] = [
  { name: '--color-text-2', amount: 0.12, min: 6 },
  { name: '--color-text-3', amount: 0.25, min: 4.5 },
  { name: '--color-muted', amount: 0.42, min: 3 },
  { name: '--color-dim', amount: 0.5, min: 2.8 },
  { name: '--color-faint', amount: 0.62, min: 0 }
]

/** Line/fill alphas, which are white on a dark theme and black on a light one. */
const LINE_ALPHA = {
  dark: { '--color-line': 0.06, '--color-line-2': 0.08, '--color-soft': 0.05, '--color-line-strong': 0.12, '--color-hover': 0.04 },
  light: { '--color-line': 0.08, '--color-line-2': 0.1, '--color-soft': 0.06, '--color-line-strong': 0.14, '--color-hover': 0.045 }
}

/**
 * Elevation, per appearance rather than per theme. A dark UI needs a deep,
 * near-black shadow to lift a menu off the surface behind it; on white that same
 * alpha reads as soot, so the light pair trades depth for a shorter, cooler
 * throw. Nothing about which dark theme it is changes that.
 */
const SHADOWS = {
  dark: { '--shadow-menu': '0 14px 36px rgb(0 0 0 / 0.55)', '--shadow-modal': '0 24px 70px rgb(0 0 0 / 0.6)' },
  light: { '--shadow-menu': '0 10px 26px rgb(15 23 42 / 0.16)', '--shadow-modal': '0 20px 56px rgb(15 23 42 / 0.22)' }
}

/** Every custom property a theme sets, as `{ '--color-bg': '#…', … }`. */
export type ThemeTokens = Record<string, string>

/**
 * The full token set for a theme, derived from its seed colours.
 *
 * The derivation mirrors what the built-in pair does by hand:
 *
 *  - **Surfaces** step off the page. On dark everything climbs toward white —
 *    the rail and bar barely, the panels and menus more, so a floating surface
 *    reads as nearer. On light the rail and bar step *down* from the page while
 *    the panes stay at the surface colour, which is what makes a light UI read
 *    as paper on a desk rather than a dark one with the lights on.
 *  - **Text** starts at the theme's foreground and fades toward the page
 *    background, so the same five rungs mean the same five things everywhere.
 *  - **Status hues** are contrast-rescued against the surface they label; a
 *    theme whose green is a muted olive (Gruvbox, Solarized) stays olive, it
 *    just stops being unreadable as a word.
 */
export function themeTokens(spec: ThemeSpec): ThemeTokens {
  const cached = TOKEN_CACHE.get(spec.id)
  if (cached) return cached
  const tokens = deriveTokens(spec)
  TOKEN_CACHE.set(spec.id, tokens)
  return tokens
}

/**
 * Memo for {@link themeTokens}. The specs are frozen module data and the
 * derivation is pure, so one result per theme is all there will ever be — and
 * the theme picker asks for twenty of them on every render.
 */
const TOKEN_CACHE = new Map<string, ThemeTokens>()

function deriveTokens(spec: ThemeSpec): ThemeTokens {
  const dark = spec.appearance === 'dark'
  const toward = dark ? WHITE : BLACK
  const { bg, surface } = spec

  // A theme's published foreground is chosen against its editor background; the
  // rescue only bites when that lands short of comfortable body-text contrast.
  const text = ensureContrast(spec.text, surface, 7, toward)
  const status = (hex: string): string => ensureContrast(hex, surface, STATUS_CONTRAST, toward)
  const companion = (hex: string): string => (dark ? blend(hex, WHITE, 0.2) : blend(hex, BLACK, 0.2))

  const red = status(spec.red)
  const green = status(spec.green)
  const amber = status(spec.amber)
  const purple = status(spec.purple)
  const cyan = status(spec.cyan)
  const accent = accentTokens(spec.accent, spec.appearance, bg)

  const tokens: ThemeTokens = {
    /* surfaces */
    '--color-bg': bg,
    '--color-rail': dark ? blend(bg, WHITE, 0.018) : blend(bg, BLACK, 0.03),
    '--color-bar': dark ? blend(bg, WHITE, 0.01) : blend(bg, BLACK, 0.05),
    '--color-pane': surface,
    '--color-panel': dark ? blend(surface, WHITE, 0.03) : surface,
    '--color-panel-2': dark ? blend(surface, WHITE, 0.055) : blend(surface, BLACK, 0.035),
    '--color-elev': dark ? blend(surface, WHITE, 0.075) : surface,

    /* text */
    '--color-text': text,

    /* accent & status */
    ...accent,
    '--color-amber': amber,
    '--color-amber-2': companion(amber),
    '--color-green': green,
    '--color-green-2': companion(green),
    '--color-red': red,
    '--color-red-2': companion(red),
    '--color-purple': purple,
    '--color-purple-2': companion(purple),
    // Nothing in the chrome is cyan; the terminal's ANSI palette is, and it
    // should come from the theme rather than from a hard-coded mint green.
    '--color-cyan': cyan,
    // The "working" spinner blue follows the THEME's accent, never the
    // workspace accent override — a green or red workspace accent would make a
    // running agent read as done or failed. See app.css.
    '--color-working': accent['--color-accent'],

    /* diff */
    '--color-diff-add': dark ? blend(green, WHITE, 0.35) : blend(green, BLACK, 0.12),
    '--color-diff-del': dark ? blend(red, WHITE, 0.35) : blend(red, BLACK, 0.12),
    '--color-diff-hunk': dark
      ? blend(accent['--color-accent'], WHITE, 0.3)
      : blend(accent['--color-accent'], BLACK, 0.18),

    /* modal scrim — a near-black veil under a white modal is far heavier than
       it needs to be, so the light themes tint with their own ink instead. */
    '--color-scrim': dark ? rgba(blend(bg, BLACK, 0.5), 0.7) : rgba(blend(text, BLACK, 0.1), 0.4),

    /* non-@theme properties (see app.css for why these are not Tailwind tokens) */
    ...SHADOWS[spec.appearance],
    '--scrollbar-thumb': rgba(blend(text, bg, 0.45), 0.32),
    '--checker-a': dark ? blend(surface, WHITE, 0.05) : blend(surface, BLACK, 0.1),
    '--checker-b': dark ? blend(surface, WHITE, 0.015) : blend(surface, BLACK, 0.02)
  }

  for (const { name, amount, min } of TEXT_LADDER) {
    tokens[name] = ensureContrast(blend(text, bg, amount), surface, min, toward)
  }
  for (const [name, alpha] of Object.entries(LINE_ALPHA[spec.appearance])) {
    tokens[name] = rgba(dark ? WHITE : BLACK, alpha)
  }
  return tokens
}

/**
 * The stylesheet for every non-built-in theme, as one `:root[data-theme=…]`
 * block each.
 *
 * A stylesheet rather than inline properties on `<html>`, because the workspace
 * accent override IS inline: keeping the two on different levels of the cascade
 * means clearing the accent (back to "Default") simply reveals the theme's own
 * accent again, instead of deleting the property the theme just set. The
 * built-ins are skipped — app.css already carries their tokens, and the `:root`
 * defaults there are what paints the window before this ever runs.
 */
export function themeStyleSheet(): string {
  return THEMES.filter((t) => !t.builtin)
    .map((t) => {
      const body = Object.entries(themeTokens(t))
        .map(([name, value]) => `  ${name}: ${value};`)
        .join('\n')
      return `:root[data-theme='${t.id}'] {\n  color-scheme: ${t.appearance};\n${body}\n}`
    })
    .join('\n')
}
