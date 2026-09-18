import type { LayoutNode, OpenAction, SplitDirection, SplitWhere } from '@shared/types'

/**
 * Where a tab opened from outside the pane area should go, given the Worktree's
 * layout tree and the Default Open Action setting.
 *
 * The setting names a pane by position relative to the one the user last worked
 * in — "Right Pane", "Bottom Pane". Two cases follow from that:
 *
 *  - A pane is already on that side: use it.
 *  - Nothing is there, and the Worktree has a SINGLE pane: split it toward that
 *    side. This is what makes the setting mean anything at all — most Worktrees
 *    start with one pane, and if "Right Pane" quietly fell back to it there, the
 *    default would be indistinguishable from "Active Pane" until the user split
 *    by hand. The split happens once; every later open finds the pane it made.
 *  - Nothing is there, and the Worktree is already split: use the active pane.
 *    The alternative is a new pane on every open — work in the right-hand pane
 *    for a while, keep opening files from the palette, and the Worktree shreds
 *    itself into columns. Once a layout exists, the user's arrangement wins.
 *
 * Everything here is pure, so the placement rule can be tested without a
 * layout on screen; the caller performs the split and creates the tab.
 */

export type OpenTarget =
  | { kind: 'pane'; paneId: string }
  | { kind: 'split'; paneId: string; dir: SplitDirection; where: SplitWhere }

/** Which axis a direction travels along, and which child of a split it faces. */
const DIRECTIONS: Record<
  Exclude<OpenAction, 'active'>,
  { dir: SplitDirection; where: SplitWhere; from: 'a' | 'b'; into: 'a' | 'b' }
> = {
  right: { dir: 'row', where: 'after', from: 'a', into: 'b' },
  left: { dir: 'row', where: 'before', from: 'b', into: 'a' },
  bottom: { dir: 'column', where: 'after', from: 'a', into: 'b' },
  top: { dir: 'column', where: 'before', from: 'b', into: 'a' }
}

/** Every pane id the tree references, left to right, top to bottom. */
export function paneIds(node: LayoutNode | null): string[] {
  if (!node) return []
  return node.type === 'pane' ? [node.paneId] : [...paneIds(node.a), ...paneIds(node.b)]
}

/**
 * The chain of splits from the root down to `paneId`, each recorded with the
 * side the path descended into. Empty when the pane is not in the tree.
 */
function pathTo(
  node: LayoutNode,
  paneId: string
): { node: Extract<LayoutNode, { type: 'split' }>; side: 'a' | 'b' }[] | null {
  if (node.type === 'pane') return node.paneId === paneId ? [] : null
  const inA = pathTo(node.a, paneId)
  if (inA) return [{ node, side: 'a' }, ...inA]
  const inB = pathTo(node.b, paneId)
  if (inB) return [{ node, side: 'b' }, ...inB]
  return null
}

/**
 * The leaf of `node` nearest the boundary we arrived at — the top-left-most
 * pane when entering from the left or top, the bottom-right-most when entering
 * from the right or bottom. It is the pane whose edge touches the one we came
 * from, which is what "the pane to the right" means when that side is itself
 * split into several.
 */
function edgeLeaf(node: LayoutNode, side: 'a' | 'b'): string {
  let cur = node
  while (cur.type === 'split') cur = side === 'a' ? cur.a : cur.b
  return cur.paneId
}

/**
 * Resolve the pane a new tab should open in. Returns null when the layout has
 * no panes at all, which the caller passes on as "let main pick the first pane".
 */
export function resolveOpenTarget(
  layout: LayoutNode | null,
  activePaneId: string | null,
  action: OpenAction,
  /**
   * A pane the result must not land in — the Search tab's own pane. Its results
   * are a list you work THROUGH, so opening a hit on top of them hides the next
   * one and costs a click to get back. Honoured only when somewhere else exists
   * or can be made; it never blocks the open.
   */
  avoidPaneId?: string
): OpenTarget | null {
  const ids = paneIds(layout)
  if (!layout || ids.length === 0) return null

  // A pane id that is no longer in the tree (the pane was closed) is treated as
  // "nothing recorded", exactly as the store's activePaneId selector does.
  const active = activePaneId && ids.includes(activePaneId) ? activePaneId : ids[0]

  /** Apply the avoid rule to a resolved pane. */
  const settle = (paneId: string): OpenTarget => {
    if (paneId !== avoidPaneId) return { kind: 'pane', paneId }
    const other = ids.find((id) => id !== avoidPaneId)
    if (other) return { kind: 'pane', paneId: other }
    // The avoided pane is the only one there is, so make a second. The
    // direction comes from the setting, defaulting to a split across for
    // "Active Pane", which names no direction of its own.
    const dir = action === 'active' ? DIRECTIONS.right : DIRECTIONS[action]
    return { kind: 'split', paneId, dir: dir.dir, where: dir.where }
  }

  if (action === 'active') return settle(active)

  const want = DIRECTIONS[action]
  const path = pathTo(layout, active)
  if (path) {
    // Walk OUT from the pane: the nearest enclosing split along the right axis
    // that has something on the far side owns the neighbour. Starting at the
    // root instead would jump across the whole window on a nested layout.
    for (let i = path.length - 1; i >= 0; i--) {
      const { node, side } = path[i]
      if (node.dir === want.dir && side === want.from) {
        return settle(edgeLeaf(want.into === 'b' ? node.b : node.a, want.from))
      }
    }
  }
  return ids.length === 1
    ? { kind: 'split', paneId: active, dir: want.dir, where: want.where }
    : settle(active)
}
