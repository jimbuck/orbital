import { describe, expect, it } from 'vitest'
import { nextTileIndex } from './ThemePicker'

/**
 * The grid's keyboard contract in the abstract. Settings.test.tsx covers the
 * wiring — that an arrow press really persists the theme it lands on — so what
 * is left here is the arithmetic, including the wraps that are tedious to reach
 * through simulated events.
 */
describe('nextTileIndex', () => {
  const COUNT = 7 // two full rows of three, plus one

  it('steps one tile horizontally and a whole row vertically', () => {
    // Vertical arrows move by the column count because the options are drawn as
    // a grid: Down from the first tile must land under it, not beside it.
    expect(nextTileIndex('ArrowRight', 0, COUNT, 3)).toBe(1)
    expect(nextTileIndex('ArrowLeft', 4, COUNT, 3)).toBe(3)
    expect(nextTileIndex('ArrowDown', 0, COUNT, 3)).toBe(3)
    expect(nextTileIndex('ArrowUp', 4, COUNT, 3)).toBe(1)
  })

  it('wraps in both directions rather than dead-ending', () => {
    expect(nextTileIndex('ArrowRight', COUNT - 1, COUNT, 3)).toBe(0)
    expect(nextTileIndex('ArrowLeft', 0, COUNT, 3)).toBe(COUNT - 1)
    // A partial last row: Down from the bottom wraps around to the top, so the
    // key never simply does nothing.
    expect(nextTileIndex('ArrowDown', 5, COUNT, 3)).toBe(1)
    expect(nextTileIndex('ArrowUp', 1, COUNT, 3)).toBe(5)
  })

  it('jumps to the ends, and leaves keys it does not own alone', () => {
    expect(nextTileIndex('Home', 4, COUNT, 3)).toBe(0)
    expect(nextTileIndex('End', 0, COUNT, 3)).toBe(COUNT - 1)
    // Null means "not ours": the event keeps bubbling, so Tab still leaves the
    // group and typing still reaches whatever is listening.
    expect(nextTileIndex('Tab', 0, COUNT, 3)).toBeNull()
    expect(nextTileIndex('a', 0, COUNT, 3)).toBeNull()
    expect(nextTileIndex('ArrowRight', 0, 0, 3)).toBeNull()
  })
})
