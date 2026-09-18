import { describe, expect, it } from 'vitest'
import { contrast } from './color'
import {
  DEFAULT_THEME_ID,
  THEMES,
  accentTokens,
  builtinTheme,
  isThemeId,
  themeById,
  themeStyleSheet,
  themeTokens
} from './themes'

/**
 * The registry's whole promise is that eight seed colours per theme produce a
 * complete, readable token set — so these tests ARE the promise, checked
 * against every theme at once. A palette added later that leaves a surface
 * unreadable fails here rather than in someone's eyes.
 */

const COLOR = /^(#[0-9a-f]{6}|rgb\(\d+ \d+ \d+ \/ [\d.]+\))$/

describe('the registry', () => {
  it('has unique ids and keeps the two pre-registry values as the built-ins', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length)
    // Installs predating the registry stored 'dark' or 'light'; those ARE ids,
    // which is why no settings migration was ever needed.
    expect(THEMES.filter((t) => t.builtin).map((t) => t.id)).toEqual(['dark', 'light'])
  })

  it('offers both appearances, and resolves system to the built-in for each', () => {
    expect(THEMES.some((t) => t.appearance === 'dark')).toBe(true)
    expect(THEMES.some((t) => t.appearance === 'light')).toBe(true)
    expect(builtinTheme('dark')).toBe('dark')
    expect(builtinTheme('light')).toBe('light')
  })

  it('falls back to the default theme for an id it does not ship', () => {
    // A newer build's theme, or a hand-edited config: the app has to paint
    // something rather than come up with no tokens at all.
    expect(themeById('no-such-theme').id).toBe(DEFAULT_THEME_ID)
    expect(themeById(undefined).id).toBe(DEFAULT_THEME_ID)
    expect(isThemeId('dracula')).toBe(true)
    expect(isThemeId('no-such-theme')).toBe(false)
  })
})

describe('themeTokens', () => {
  it('returns a usable colour for every token of every theme', () => {
    for (const theme of THEMES) {
      for (const [name, value] of Object.entries(themeTokens(theme))) {
        if (name.startsWith('--shadow')) continue
        expect(value, `${theme.id} ${name}`).toMatch(COLOR)
      }
    }
  })

  it('keeps body text comfortably readable on the pane it sits on', () => {
    for (const theme of THEMES) {
      const t = themeTokens(theme)
      expect(contrast(t['--color-text'], t['--color-pane']), theme.id).toBeGreaterThanOrEqual(7)
      // The dimmer rungs are supporting text, not body copy, but they still
      // have to be read — this is the line below which a theme is unusable.
      expect(contrast(t['--color-text-3'], t['--color-pane']), theme.id).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t['--color-muted'], t['--color-pane']), theme.id).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps every status hue legible as a word, not just as a dot', () => {
    for (const theme of THEMES) {
      const t = themeTokens(theme)
      for (const name of ['--color-red', '--color-green', '--color-amber', '--color-purple', '--color-cyan']) {
        expect(contrast(t[name], t['--color-pane']), `${theme.id} ${name}`).toBeGreaterThanOrEqual(4)
      }
    }
  })

  it('keeps the accent readable as text and its ink readable on the fill', () => {
    for (const theme of THEMES) {
      const t = themeTokens(theme)
      expect(contrast(t['--color-accent'], t['--color-bg']), theme.id).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t['--color-accent'], t['--color-on-accent']), theme.id).toBeGreaterThanOrEqual(3)
    }
  })

  it('hovers away from the page on dark and toward it on light, like the built-ins', () => {
    for (const theme of THEMES) {
      const t = themeTokens(theme)
      const lighter = contrast(t['--color-accent-hover'], '#000000') > contrast(t['--color-accent'], '#000000')
      expect(lighter, theme.id).toBe(theme.appearance === 'dark')
    }
  })

  it('separates the surfaces it stacks, so a menu is not invisible on its pane', () => {
    for (const theme of THEMES) {
      const t = themeTokens(theme)
      expect(t['--color-elev'], theme.id).not.toBe(t['--color-bg'])
      expect(t['--color-rail'], theme.id).not.toBe(t['--color-bg'])
    }
  })

  it('is memoized per theme, since the picker asks for all of them at once', () => {
    expect(themeTokens(themeById('dracula'))).toBe(themeTokens(themeById('dracula')))
  })
})

describe('accentTokens', () => {
  it('rescues an accent that would be unreadable on the page it lands on', () => {
    // Near-black on a dark page, near-white on a light one: both get pulled
    // toward legible, and a colour that already reads comes back untouched.
    expect(contrast(accentTokens('#101820', 'dark', '#0a0d12')['--color-accent'], '#0a0d12')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(accentTokens('#f0f4ff', 'light', '#f4f6fa')['--color-accent'], '#f4f6fa')).toBeGreaterThanOrEqual(
      4.5
    )
    expect(accentTokens('#4f8cff', 'dark', '#0a0d12')['--color-accent']).toBe('#4f8cff')
  })
})

describe('themeStyleSheet', () => {
  it('emits a rule for every derived theme and none for the built-ins', () => {
    const css = themeStyleSheet()
    for (const theme of THEMES) {
      // The built-ins' tokens are hand-tuned in app.css; a generated rule would
      // quietly override them with near-misses.
      expect(css.includes(`:root[data-theme='${theme.id}']`), theme.id).toBe(!theme.builtin)
    }
  })

  it('gives each rule a color-scheme, so native widgets follow the theme too', () => {
    const css = themeStyleSheet()
    const rules = THEMES.filter((t) => !t.builtin).length
    expect(css.split(":root[data-theme='").length - 1).toBe(rules)
    expect(css.match(/color-scheme:/g)).toHaveLength(rules)
  })
})
