import { describe, expect, it } from 'vitest'
import { FALLBACK_METRICS, textGeometry, type TextMetrics, type Viewport } from './textSurface'

// What Chromium really lays 12px at line-height 1.6 out at: each line box snaps
// to 1/64px, so the pitch is 19.1875px and not the 19.2px that `1.6em` gives.
const CHROMIUM: TextMetrics = { pitch: 19.1875, charWidth: 7.2, padTop: 12 }

describe('textGeometry rows', () => {
  it('puts a row at the top padding plus whole measured line pitches', () => {
    const g = textGeometry(CHROMIUM, 10)
    expect(g.rowTop(0)).toBe(12)
    expect(g.rowTop(8)).toBe(12 + 8 * 19.1875)
    expect(g.rowBox(8)).toEqual({ position: 'absolute', top: '165.5px', height: '19.1875px' })
  })

  it('stays on the text far down a file, where em arithmetic drifts a whole line', () => {
    const row = 1600
    const onTheText = textGeometry(CHROMIUM, 2000).rowTop(row)
    expect(onTheText).toBe(30712)
    // The same row placed with the nominal 19.2px lands 20px lower: past the
    // next line. This is the bug the measured pitch exists for.
    const nominal = textGeometry({ ...CHROMIUM, pitch: 19.2 }, 2000).rowTop(row)
    expect(nominal - onTheText).toBeCloseTo(20, 5)
    expect(nominal - onTheText).toBeGreaterThan(CHROMIUM.pitch)
  })

  it('follows a different top padding rather than assuming one', () => {
    expect(textGeometry({ ...CHROMIUM, padTop: 20 }, 10).rowTop(2)).toBe(20 + 2 * 19.1875)
  })
})

describe('textGeometry columns', () => {
  it('places a cell past the gutter in ch, the unit the glyphs advance in', () => {
    const g = textGeometry(CHROMIUM, 10)
    // Two gutter digits (the minimum), then five columns in.
    expect(g.cellBox(3, 5, 4)).toEqual({
      position: 'absolute',
      top: `${12 + 3 * 19.1875}px`,
      height: '19.1875px',
      left: 'calc(7ch + 32px)',
      width: '4ch'
    })
  })

  it('leaves the width off a box that only marks a position', () => {
    expect(textGeometry(CHROMIUM, 10).cellBox(0, 0)).not.toHaveProperty('width')
  })

  it('widens the gutter with the digit count and moves the text by the same amount', () => {
    const short = textGeometry(CHROMIUM, 99)
    const long = textGeometry(CHROMIUM, 12345)
    expect(short.gutterBox.width).toBe('calc(2ch + 20px)')
    expect(short.textBox.paddingLeft).toBe('calc(2ch + 32px)')
    expect(long.gutterBox.width).toBe('calc(5ch + 20px)')
    expect(long.textBox.paddingLeft).toBe('calc(5ch + 32px)')
    expect(long.cellBox(0, 0).left).toBe(long.textBox.paddingLeft)
  })

  it('fits the fold strip exactly between the gutter and the first column', () => {
    const g = textGeometry(CHROMIUM, 500)
    expect(g.foldStripBox.left).toBe(g.gutterBox.width) // starts where the gutter ends
    expect(g.gutterBox.width).toBe('calc(3ch + 20px)')
    expect(g.foldStripBox.width).toBe('12px') // 20px + 12px = the text's 32px inset
    expect(g.textBox.paddingLeft).toBe('calc(3ch + 32px)')
  })

  it('gives everything that holds text the same vertical padding', () => {
    const g = textGeometry(CHROMIUM, 10)
    expect(g.gutterBox.paddingTop).toBe(g.textBox.paddingTop)
    expect(g.gutterBox.paddingBottom).toBe(g.textBox.paddingBottom)
  })
})

describe('textGeometry scrolling', () => {
  const view = (over: Partial<Viewport> = {}): Viewport => ({
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight: 400,
    clientWidth: 600,
    ...over
  })
  const g = textGeometry(CHROMIUM, 5000)

  it('centres a row in the viewport', () => {
    expect(g.scrollTopToCentre(100, 400)).toBe(g.rowTop(100) - 200 + 19.1875 / 2)
  })

  it('never scrolls above the top for a row near the start', () => {
    expect(g.scrollTopToCentre(2, 400)).toBe(0)
  })

  it('leaves the viewport alone when the span is already on screen', () => {
    const v = view({ scrollTop: 1000, scrollLeft: 0 })
    const row = Math.ceil((1000 - 12) / 19.1875) + 3
    expect(g.scrollToShow({ row, column: 2, width: 5 }, v)).toEqual({ scrollTop: 1000, scrollLeft: 0 })
  })

  it('centres a row that is below or above the viewport', () => {
    expect(g.scrollToShow({ row: 300, column: 0, width: 1 }, view()).scrollTop).toBe(g.scrollTopToCentre(300, 400))
    expect(g.scrollToShow({ row: 1, column: 0, width: 1 }, view({ scrollTop: 900 })).scrollTop).toBe(0)
  })

  it('counts a row cut off by the bottom edge as off screen', () => {
    // Its top is inside the viewport but its bottom is not.
    const v = view({ scrollTop: g.rowTop(20) + 5 - 400 })
    expect(g.scrollToShow({ row: 20, column: 0, width: 1 }, v).scrollTop).toBe(g.scrollTopToCentre(20, 400))
  })

  it('scrolls sideways to a span past the right edge, leaving a third of the width before it', () => {
    // Four gutter digits and the 32px inset, then 200 columns of 7.2px.
    const left = 4 * 7.2 + 32 + 200 * 7.2
    expect(g.scrollToShow({ row: 0, column: 200, width: 6 }, view()).scrollLeft).toBe(left - 600 / 3)
  })

  it('scrolls back to a span left behind by a horizontal scroll', () => {
    expect(g.scrollToShow({ row: 0, column: 0, width: 3 }, view({ scrollLeft: 900 })).scrollLeft).toBe(0)
  })

  it('does not guess at a horizontal position when the glyph width is unknown', () => {
    const blind = textGeometry(FALLBACK_METRICS, 5000)
    expect(blind.scrollToShow({ row: 0, column: 900, width: 6 }, view({ scrollLeft: 17 })).scrollLeft).toBe(17)
  })
})
