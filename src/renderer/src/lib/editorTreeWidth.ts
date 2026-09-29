/** Bounds for the Editor tab's resizable file-tree pane. */
export const TREE_DEFAULT_WIDTH = 224
export const TREE_MIN_WIDTH = 140
export const TREE_MAX_FRACTION = 0.6

/**
 * Largest tree width for a tab `containerWidth` px wide (never below the minimum).
 * Uncapped until the tab has been measured, so a saved width survives the first render.
 */
export function treeMaxWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return Number.POSITIVE_INFINITY
  return Math.max(TREE_MIN_WIDTH, Math.floor(containerWidth * TREE_MAX_FRACTION))
}

/** Clamp a (possibly stale) saved width into the current bounds. */
export function clampTreeWidth(width: number, containerWidth: number): number {
  return Math.min(treeMaxWidth(containerWidth), Math.max(TREE_MIN_WIDTH, width))
}
