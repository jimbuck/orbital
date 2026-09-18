import { describe, expect, it } from 'vitest'
import type { LayoutNode } from '@shared/types'
import { paneIds, resolveOpenTarget } from './paneTarget'

const pane = (paneId: string): LayoutNode => ({ type: 'pane', paneId })

const split = (
  id: string,
  dir: 'row' | 'column',
  a: LayoutNode,
  b: LayoutNode,
  ratio = 0.5
): LayoutNode => ({ type: 'split', id, dir, ratio, a, b })

/** One pane — the layout every Worktree starts with. */
const solo = pane('p1')

/** Two panes side by side: p1 | p2. */
const sideBySide = split('s1', 'row', pane('p1'), pane('p2'))

/** Two panes stacked: p1 over p2. */
const stacked = split('s1', 'column', pane('p1'), pane('p2'))

/**
 * p1 on the left; the right half split into p2 (top) over p3 (bottom).
 *
 *   +----+----+
 *   |    | p2 |
 *   | p1 +----+
 *   |    | p3 |
 *   +----+----+
 */
const nested = split('s1', 'row', pane('p1'), split('s2', 'column', pane('p2'), pane('p3')))

describe('paneIds', () => {
  it('lists every pane left to right', () => {
    expect(paneIds(nested)).toEqual(['p1', 'p2', 'p3'])
  })

  it('is empty for a missing layout', () => {
    expect(paneIds(null)).toEqual([])
  })
})

describe('resolveOpenTarget — active', () => {
  it('uses the pane the user last worked in', () => {
    expect(resolveOpenTarget(sideBySide, 'p2', 'active')).toEqual({ kind: 'pane', paneId: 'p2' })
  })

  it('falls back to the first pane when nothing has been recorded', () => {
    expect(resolveOpenTarget(sideBySide, null, 'active')).toEqual({ kind: 'pane', paneId: 'p1' })
  })

  it('falls back to the first pane when the recorded one has since closed', () => {
    expect(resolveOpenTarget(sideBySide, 'gone', 'active')).toEqual({ kind: 'pane', paneId: 'p1' })
  })
})

describe('resolveOpenTarget — a single pane splits to make the target', () => {
  it.each([
    ['right', 'row', 'after'],
    ['left', 'row', 'before'],
    ['bottom', 'column', 'after'],
    ['top', 'column', 'before']
  ] as const)('%s splits the only pane', (action, dir, where) => {
    expect(resolveOpenTarget(solo, 'p1', action)).toEqual({ kind: 'split', paneId: 'p1', dir, where })
  })

  it('does not split for the active-pane setting', () => {
    expect(resolveOpenTarget(solo, 'p1', 'active')).toEqual({ kind: 'pane', paneId: 'p1' })
  })
})

describe('resolveOpenTarget — an existing pane on that side is used', () => {
  it('finds the pane to the right', () => {
    expect(resolveOpenTarget(sideBySide, 'p1', 'right')).toEqual({ kind: 'pane', paneId: 'p2' })
  })

  it('finds the pane to the left', () => {
    expect(resolveOpenTarget(sideBySide, 'p2', 'left')).toEqual({ kind: 'pane', paneId: 'p1' })
  })

  it('finds the pane below', () => {
    expect(resolveOpenTarget(stacked, 'p1', 'bottom')).toEqual({ kind: 'pane', paneId: 'p2' })
  })

  it('finds the pane above', () => {
    expect(resolveOpenTarget(stacked, 'p2', 'top')).toEqual({ kind: 'pane', paneId: 'p1' })
  })

  it('picks the pane whose edge touches the active one, not the far corner', () => {
    // Right of p1 is the top-right pane (p2), which is the one it abuts —
    // descending to the bottom of that column would jump the wrong way.
    expect(resolveOpenTarget(nested, 'p1', 'right')).toEqual({ kind: 'pane', paneId: 'p2' })
  })

  it('crosses an intervening split of the other axis to reach the neighbour', () => {
    // From p3 (bottom right), the nearest enclosing ROW split is s1, so left is
    // p1 even though p3's own parent is a column split.
    expect(resolveOpenTarget(nested, 'p3', 'left')).toEqual({ kind: 'pane', paneId: 'p1' })
  })
})

describe('resolveOpenTarget — an already-split Worktree is never split again', () => {
  it('falls back to the active pane when nothing is on that side', () => {
    // p2 is the right-hand pane; there is nothing further right. Splitting here
    // would shred the layout into a new column on every open.
    expect(resolveOpenTarget(sideBySide, 'p2', 'right')).toEqual({ kind: 'pane', paneId: 'p2' })
  })

  it('falls back for a direction the layout has no split on at all', () => {
    expect(resolveOpenTarget(sideBySide, 'p1', 'bottom')).toEqual({ kind: 'pane', paneId: 'p1' })
  })
})

describe('resolveOpenTarget — a pane the caller wants kept clear', () => {
  it('sends the tab to another pane rather than on top of the avoided one', () => {
    // A Search tab in the right-hand pane opening one of its own hits: right of
    // p2 is nothing, so the plain rule would land back on p2 and hide the list.
    expect(resolveOpenTarget(sideBySide, 'p2', 'right', 'p2')).toEqual({ kind: 'pane', paneId: 'p1' })
  })

  it('leaves a target that was never the avoided pane alone', () => {
    expect(resolveOpenTarget(sideBySide, 'p1', 'right', 'p1')).toEqual({ kind: 'pane', paneId: 'p2' })
  })

  it('splits when the avoided pane is the only one there is', () => {
    expect(resolveOpenTarget(solo, 'p1', 'right', 'p1')).toEqual({
      kind: 'split',
      paneId: 'p1',
      dir: 'row',
      where: 'after'
    })
  })

  it('splits across for the active-pane setting, which names no direction', () => {
    expect(resolveOpenTarget(solo, 'p1', 'active', 'p1')).toEqual({
      kind: 'split',
      paneId: 'p1',
      dir: 'row',
      where: 'after'
    })
  })

  it('still honours the avoid rule under the active-pane setting', () => {
    expect(resolveOpenTarget(sideBySide, 'p2', 'active', 'p2')).toEqual({ kind: 'pane', paneId: 'p1' })
  })

  it('avoids the pane even when the direction pointed straight at it', () => {
    // p1 is left of p2; asking for "left" from p2 would land on p1, which is
    // exactly where the caller says not to go.
    expect(resolveOpenTarget(sideBySide, 'p2', 'left', 'p1')).toEqual({ kind: 'pane', paneId: 'p2' })
  })
})

describe('resolveOpenTarget — no layout', () => {
  it('returns null so the caller can let main pick the first pane', () => {
    expect(resolveOpenTarget(null, null, 'right')).toBeNull()
  })
})
