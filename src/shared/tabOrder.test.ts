import { describe, it, expect } from 'vitest'
import { dropSlot, placeTab, isNoopDrop } from './tabOrder'

describe('dropSlot', () => {
  const mids = [50, 150, 250]
  it('picks the slot by tab midpoints', () => {
    expect(dropSlot(mids, 0)).toBe(0)
    expect(dropSlot(mids, 49)).toBe(0)
    expect(dropSlot(mids, 51)).toBe(1)
    expect(dropSlot(mids, 200)).toBe(2)
    expect(dropSlot(mids, 251)).toBe(3)
    expect(dropSlot(mids, 9999)).toBe(3)
  })
  it('handles an empty strip', () => expect(dropSlot([], 10)).toBe(0))
})

describe('placeTab', () => {
  const ids = ['a', 'b', 'c']
  it('moves the second tab ahead of the first', () => expect(placeTab(ids, 'b', 0)).toEqual(['b', 'a', 'c']))
  it('moves a tab to the end', () => expect(placeTab(ids, 'a', 3)).toEqual(['b', 'c', 'a']))
  it('accounts for its own removal when moving right', () => expect(placeTab(ids, 'a', 2)).toEqual(['b', 'a', 'c']))
  it('leaves order alone for adjacent slots', () => {
    expect(placeTab(ids, 'b', 1)).toEqual(ids)
    expect(placeTab(ids, 'b', 2)).toEqual(ids)
  })
  it('inserts a tab from another pane', () => expect(placeTab(ids, 'x', 1)).toEqual(['a', 'x', 'b', 'c']))
  it('clamps out-of-range slots', () => {
    expect(placeTab(ids, 'x', 99)).toEqual(['a', 'b', 'c', 'x'])
    expect(placeTab(ids, 'x', -4)).toEqual(['x', 'a', 'b', 'c'])
  })
})

describe('isNoopDrop', () => {
  const ids = ['a', 'b', 'c']
  it('flags drops beside the tab itself', () => {
    expect(isNoopDrop(ids, 'b', 1)).toBe(true)
    expect(isNoopDrop(ids, 'b', 2)).toBe(true)
    expect(isNoopDrop(ids, 'c', 3)).toBe(true)
    expect(isNoopDrop(ids, 'a', 0)).toBe(true)
  })
  it('passes real moves and foreign tabs', () => {
    expect(isNoopDrop(ids, 'b', 0)).toBe(false)
    expect(isNoopDrop(ids, 'x', 3)).toBe(false)
  })
})
