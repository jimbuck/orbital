import { describe, expect, it } from 'vitest'
import type { Input } from 'electron'
import { ZOOM_MAX_LEVEL, ZOOM_MIN_LEVEL, stepZoomLevel, zoomActionForInput, zoomFactorForLevel } from './zoom'

function key(code: string, mods: Partial<Input> = {}): Input {
  return {
    type: 'keyDown',
    key: '',
    code,
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: true,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...mods
  } as Input
}

describe('zoom levels', () => {
  it('steps one Chromium level at a time and clamps to the supported range', () => {
    expect(stepZoomLevel(0, 'in')).toBe(1)
    expect(stepZoomLevel(0, 'out')).toBe(-1)
    expect(stepZoomLevel(ZOOM_MAX_LEVEL, 'in')).toBe(ZOOM_MAX_LEVEL)
    expect(stepZoomLevel(ZOOM_MIN_LEVEL, 'out')).toBe(ZOOM_MIN_LEVEL)
  })

  it('maps levels to the 20% progression Chrome uses', () => {
    expect(zoomFactorForLevel(0)).toBe(1)
    expect(zoomFactorForLevel(1)).toBeCloseTo(1.2)
    expect(zoomFactorForLevel(-1)).toBeCloseTo(1 / 1.2)
  })
})

describe('zoom shortcuts', () => {
  it('reads Ctrl +/=, Ctrl - and Ctrl 0, on the main row and the numpad', () => {
    expect(zoomActionForInput(key('Equal'))).toBe('in')
    expect(zoomActionForInput(key('Equal', { shift: true }))).toBe('in')
    expect(zoomActionForInput(key('NumpadAdd'))).toBe('in')
    expect(zoomActionForInput(key('Minus'))).toBe('out')
    expect(zoomActionForInput(key('NumpadSubtract'))).toBe('out')
    expect(zoomActionForInput(key('Digit0'))).toBe('reset')
    expect(zoomActionForInput(key('Numpad0'))).toBe('reset')
  })

  it('ignores everything else: no Ctrl, Alt/AltGr combos, key-up, other keys', () => {
    expect(zoomActionForInput(key('Equal', { control: false }))).toBeNull()
    expect(zoomActionForInput(key('Equal', { alt: true }))).toBeNull()
    expect(zoomActionForInput(key('Equal', { meta: true }))).toBeNull()
    expect(zoomActionForInput(key('Equal', { type: 'keyUp' }))).toBeNull()
    expect(zoomActionForInput(key('Minus', { shift: true }))).toBeNull()
    expect(zoomActionForInput(key('Digit0', { shift: true }))).toBeNull()
    expect(zoomActionForInput(key('KeyR', { shift: true }))).toBeNull()
  })
})
