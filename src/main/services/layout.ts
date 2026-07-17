/**
 * Pure helpers for the Worktree pane layout — a binary tree of splits and pane
 * leaves (see LayoutNode in the shared contract). All functions are immutable:
 * they return a new tree rather than mutating in place.
 */
import { randomUUID } from 'node:crypto'
import type { LayoutNode, SplitDirection, SplitWhere, DropEdge } from '@shared/types'

export function leaf(paneId: string): LayoutNode {
  return { type: 'pane', paneId }
}

/** Every pane id referenced by the tree, in left-to-right order. */
export function paneIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.paneId] : [...paneIds(node.a), ...paneIds(node.b)]
}

/** Replace the leaf for `paneId` with a split of (existing, new) ordered by `where`. */
export function splitAt(
  node: LayoutNode,
  paneId: string,
  dir: SplitDirection,
  where: SplitWhere,
  newPaneId: string
): LayoutNode {
  if (node.type === 'pane') {
    if (node.paneId !== paneId) return node
    const existing = leaf(paneId)
    const fresh = leaf(newPaneId)
    const [a, b] = where === 'before' ? [fresh, existing] : [existing, fresh]
    return { type: 'split', id: randomUUID(), dir, ratio: 0.5, a, b }
  }
  return {
    ...node,
    a: splitAt(node.a, paneId, dir, where, newPaneId),
    b: splitAt(node.b, paneId, dir, where, newPaneId)
  }
}

/** Remove the leaf for `paneId`, collapsing its parent split to the sibling. */
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === 'pane') return node.paneId === paneId ? null : node
  const a = removePane(node.a, paneId)
  const b = removePane(node.b, paneId)
  if (a === null) return b
  if (b === null) return a
  return { ...node, a, b }
}

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  const clamped = Math.min(0.9, Math.max(0.1, ratio))
  if (node.type === 'pane') return node
  if (node.id === splitId) return { ...node, ratio: clamped }
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) }
}

/** A left-deep row split over the given pane ids (used to seed/repair layouts). */
export function defaultLayout(ids: string[]): LayoutNode {
  if (ids.length === 0) return leaf(randomUUID())
  let node: LayoutNode = leaf(ids[0])
  for (let i = 1; i < ids.length; i++) {
    node = { type: 'split', id: randomUUID(), dir: 'row', ratio: 0.5, a: node, b: leaf(ids[i]) }
  }
  return node
}

/** Drop-edge → the split direction and which side the new pane lands on. */
export function edgeToSplit(edge: Exclude<DropEdge, 'center'>): { dir: SplitDirection; where: SplitWhere } {
  switch (edge) {
    case 'left':
      return { dir: 'row', where: 'before' }
    case 'right':
      return { dir: 'row', where: 'after' }
    case 'top':
      return { dir: 'column', where: 'before' }
    case 'bottom':
      return { dir: 'column', where: 'after' }
  }
}

/** Validate a parsed layout references exactly `validPaneIds` (else it needs rebuilding). */
export function layoutCovers(node: LayoutNode | null, validPaneIds: string[]): boolean {
  if (!node) return false
  const ids = paneIds(node)
  if (ids.length !== validPaneIds.length) return false
  const set = new Set(validPaneIds)
  return ids.every((id) => set.has(id)) && new Set(ids).size === ids.length
}
