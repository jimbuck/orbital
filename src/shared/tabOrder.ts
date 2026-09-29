/**
 * Drag-and-drop math for a pane's tab strip. A "slot" is an insertion point in
 * the strip as it looks before the drag: 0 is ahead of the first tab, `n` is
 * after the last one.
 */

/** The slot nearest `x`: ahead of the first tab whose midpoint lies right of it. */
export function dropSlot(midpoints: number[], x: number): number {
  const i = midpoints.findIndex((m) => x < m)
  return i === -1 ? midpoints.length : i
}

/** `ids` with `tabId` moved to `slot` (a slot in the pre-move list). Appends a tab not in the list. */
export function placeTab(ids: string[], tabId: string, slot: number): string[] {
  const from = ids.indexOf(tabId)
  const rest = ids.filter((id) => id !== tabId)
  const at = Math.max(0, Math.min(rest.length, from !== -1 && from < slot ? slot - 1 : slot))
  rest.splice(at, 0, tabId)
  return rest
}

/** True when dropping `tabId` at `slot` would leave the strip as it is. */
export function isNoopDrop(ids: string[], tabId: string, slot: number): boolean {
  const next = placeTab(ids, tabId, slot)
  return next.length === ids.length && next.every((id, i) => id === ids[i])
}
