import { describe, expect, it } from 'vitest'
import { TREE_MIN_WIDTH, clampTreeWidth, treeMaxWidth } from './editorTreeWidth'

describe('editorTreeWidth', () => {
  it('caps at 60% of the container', () => {
    expect(treeMaxWidth(1000)).toBe(600)
  })
  it('never drops below the minimum on tiny containers', () => {
    expect(treeMaxWidth(100)).toBe(TREE_MIN_WIDTH)
  })
  it('is uncapped before the container is measured', () => {
    expect(treeMaxWidth(0)).toBe(Number.POSITIVE_INFINITY)
    expect(treeMaxWidth(NaN)).toBe(Number.POSITIVE_INFINITY)
  })
  it('clamps widths into range', () => {
    expect(clampTreeWidth(50, 1000)).toBe(TREE_MIN_WIDTH)
    expect(clampTreeWidth(900, 1000)).toBe(600)
    expect(clampTreeWidth(300, 1000)).toBe(300)
    expect(clampTreeWidth(500, 0)).toBe(500)
  })
})
