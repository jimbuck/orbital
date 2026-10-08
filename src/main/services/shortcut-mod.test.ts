import { describe, expect, it } from 'vitest'
import { primaryModHeld } from './shortcut-mod'

describe('primaryModHeld', () => {
  it('is Ctrl off macOS', () => {
    expect(primaryModHeld({ control: true, meta: false }, 'win32')).toBe(true)
    expect(primaryModHeld({ control: true, meta: false }, 'linux')).toBe(true)
    expect(primaryModHeld({ control: false, meta: true }, 'linux')).toBe(false)
  })

  it('is Cmd on macOS, leaving Ctrl to the terminal', () => {
    expect(primaryModHeld({ control: false, meta: true }, 'darwin')).toBe(true)
    expect(primaryModHeld({ control: true, meta: false }, 'darwin')).toBe(false)
  })

  it('rejects Ctrl and Cmd held together', () => {
    expect(primaryModHeld({ control: true, meta: true }, 'win32')).toBe(false)
    expect(primaryModHeld({ control: true, meta: true }, 'darwin')).toBe(false)
  })
})
