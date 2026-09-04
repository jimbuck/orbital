import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAccentColor } from '@shared/types'
import { useStore } from '@renderer/store'
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentTokens,
  applyAccentColor,
  contrast,
  previewAccentColor,
  setAccentColor
} from './accent'

describe('normalizeAccentColor', () => {
  it('accepts #rrggbb in any case, with or without the hash, trimmed', () => {
    expect(normalizeAccentColor('#8B7CF6')).toBe('#8b7cf6')
    expect(normalizeAccentColor('8b7cf6')).toBe('#8b7cf6')
    expect(normalizeAccentColor('  #8b7cf6 ')).toBe('#8b7cf6')
  })

  it('rejects everything that is not exactly six hex digits', () => {
    for (const bad of ['#fff', '#8b7cf6ff', 'violet', '', '#12345g', 42, null, undefined]) {
      expect(normalizeAccentColor(bad)).toBeNull()
    }
  })
})

describe('accentTokens', () => {
  const themes = ['dark', 'light'] as const

  it('keeps every preset readable as text on both page backgrounds', () => {
    // The whole reason the tokens are derived rather than used verbatim: a
    // colour picked against a dark pane has to survive the light theme too.
    for (const preset of ACCENT_PRESETS) {
      expect(contrast(accentTokens(preset.hex, 'dark')['--color-accent'], '#0a0d12')).toBeGreaterThanOrEqual(4.5)
      expect(contrast(accentTokens(preset.hex, 'light')['--color-accent'], '#f4f6fa')).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('rescues an unreadable custom colour in each theme without touching a readable one', () => {
    // Near-black on dark, near-white on light: both get pulled toward legible.
    expect(contrast(accentTokens('#101820', 'dark')['--color-accent'], '#0a0d12')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(accentTokens('#f0f4ff', 'light')['--color-accent'], '#f4f6fa')).toBeGreaterThanOrEqual(4.5)
    // The built-in dark blue already reads on dark, so it comes back exactly.
    expect(accentTokens(DEFAULT_ACCENT.dark, 'dark')['--color-accent']).toBe(DEFAULT_ACCENT.dark)
  })

  it('picks the ink that contrasts more with the accent fill', () => {
    // A pale accent takes the navy ink, a deep one takes white.
    expect(accentTokens('#e8c98a', 'dark')['--color-on-accent']).toBe('#06122e')
    expect(accentTokens('#1d4fb8', 'light')['--color-on-accent']).toBe('#ffffff')
    for (const theme of themes) {
      for (const preset of ACCENT_PRESETS) {
        const t = accentTokens(preset.hex, theme)
        expect(contrast(t['--color-accent'], t['--color-on-accent'])).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('hovers lighter on dark and darker on light, like the built-in tokens', () => {
    const dark = accentTokens('#8b7cf6', 'dark')
    const light = accentTokens('#8b7cf6', 'light')
    expect(contrast(dark['--color-accent-hover'], '#000000')).toBeGreaterThan(contrast(dark['--color-accent'], '#000000'))
    expect(contrast(light['--color-accent-hover'], '#ffffff')).toBeGreaterThan(contrast(light['--color-accent'], '#ffffff'))
  })

  it('always returns six-digit hex for every token', () => {
    for (const theme of themes) {
      for (const value of Object.values(accentTokens('#3ddc97', theme))) expect(value).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('applyAccentColor', () => {
  it('sets the four tokens inline for a colour and removes them for null', () => {
    const root = document.createElement('div')
    applyAccentColor(root, '#8b7cf6', 'dark')
    expect(root.style.getPropertyValue('--color-accent')).toBe('#8b7cf6')
    expect(root.style.getPropertyValue('--color-accent-hover')).not.toBe('')
    expect(root.style.getPropertyValue('--color-on-accent')).not.toBe('')
    expect(root.style.getPropertyValue('--color-blue')).not.toBe('')

    applyAccentColor(root, null, 'dark')
    for (const name of ['--color-accent', '--color-accent-hover', '--color-on-accent', '--color-blue']) {
      expect(root.style.getPropertyValue(name)).toBe('')
    }
  })

  it('treats a value that is not a colour as null', () => {
    const root = document.createElement('div')
    applyAccentColor(root, '#8b7cf6', 'dark')
    applyAccentColor(root, 'purple', 'dark')
    expect(root.style.getPropertyValue('--color-accent')).toBe('')
  })
})

describe('store writes', () => {
  const setSettings = vi.fn(async (patch: unknown) => patch)

  beforeEach(() => {
    setSettings.mockClear()
    vi.stubGlobal('orbital', { setSettings })
    useStore.setState({
      settings: { accentColor: null, theme: 'dark' }
    } as unknown as Parameters<typeof useStore.setState>[0])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('previewAccentColor updates the store and writes nothing', () => {
    previewAccentColor('#8B7CF6')
    expect(useStore.getState().settings?.accentColor).toBe('#8b7cf6')
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('setAccentColor writes the normalised colour alone', () => {
    setAccentColor('8b7cf6')
    expect(useStore.getState().settings?.accentColor).toBe('#8b7cf6')
    expect(setSettings).toHaveBeenCalledWith({ accentColor: '#8b7cf6' })
  })

  it('setAccentColor still writes after a preview of the same colour, so a drag ends persisted', () => {
    previewAccentColor('#8b7cf6')
    setAccentColor('#8b7cf6')
    expect(setSettings).toHaveBeenCalledWith({ accentColor: '#8b7cf6' })
  })

  it('does nothing before settings have loaded', () => {
    useStore.setState({ settings: null } as unknown as Parameters<typeof useStore.setState>[0])
    previewAccentColor('#8b7cf6')
    setAccentColor('#8b7cf6')
    expect(setSettings).not.toHaveBeenCalled()
  })
})
