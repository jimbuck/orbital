import { describe, expect, it } from 'vitest'
import { columnAfter, DEFAULT_TAB_SIZE, expandedWidth, indentOf, parseTabSize } from './columns'

describe('parseTabSize', () => {
  it('reads a column count and falls back for anything it cannot use', () => {
    expect(parseTabSize('4')).toBe(4)
    expect(parseTabSize('8')).toBe(8)
    // A length ("32px") is not a column count.
    expect(parseTabSize('32px')).toBe(DEFAULT_TAB_SIZE)
    expect(parseTabSize(undefined)).toBe(DEFAULT_TAB_SIZE)
    expect(parseTabSize('0')).toBe(DEFAULT_TAB_SIZE)
  })
})

describe('columns', () => {
  it('advances a tab to the next stop, not by a fixed width', () => {
    expect(columnAfter(0, '\t', 4)).toBe(4)
    expect(columnAfter(3, '\t', 4)).toBe(4)
    expect(columnAfter(4, '\t', 4)).toBe(8)
    expect(columnAfter(5, 'x', 4)).toBe(6)
  })

  it('measures a line the way it is drawn', () => {
    expect(expandedWidth('', 4)).toBe(0)
    expect(expandedWidth('abc', 4)).toBe(3)
    expect(expandedWidth('\tabc', 4)).toBe(7)
    expect(expandedWidth('ab\tc', 4)).toBe(5)
    expect(expandedWidth('ab\tc', 8)).toBe(9)
  })

  it('reads the indent of a line, and tells a blank one apart', () => {
    expect(indentOf('x', 4)).toBe(0)
    expect(indentOf('    x', 4)).toBe(4)
    expect(indentOf('\tx', 4)).toBe(4)
    expect(indentOf('  \tx', 4)).toBe(4)
    expect(indentOf('', 4)).toBe(-1)
    expect(indentOf('  \t ', 4)).toBe(-1)
  })
})
