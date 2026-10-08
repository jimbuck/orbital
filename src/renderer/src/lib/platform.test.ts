import { describe, expect, it } from 'vitest'
import { primaryMod, shortcutLabel } from './platform'

describe('shortcutLabel', () => {
  it('leaves hints alone off macOS', () => {
    expect(shortcutLabel('Ctrl Shift P', false)).toBe('Ctrl Shift P')
  })

  it('uses Mac symbols on macOS', () => {
    expect(shortcutLabel('Ctrl Shift P', true)).toBe('⌘⇧P')
    expect(shortcutLabel('Ctrl+Alt+Enter', true)).toBe('⌘⌥Enter')
    expect(shortcutLabel('Ctrl +', true)).toBe('⌘+')
    expect(shortcutLabel('Ctrl+Shift+]', true)).toBe('⌘⇧]')
  })
})

describe('primaryMod', () => {
  it('is Ctrl off macOS and Cmd on it', () => {
    expect(primaryMod({ ctrlKey: true, metaKey: false }, false)).toBe(true)
    expect(primaryMod({ ctrlKey: true, metaKey: false }, true)).toBe(false)
    expect(primaryMod({ ctrlKey: false, metaKey: true }, true)).toBe(true)
  })
})
