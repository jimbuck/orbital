import type { JSX } from 'react'

/**
 * Drag strip overlaid on a resizable side panel's inner edge. The panel's own
 * border provides the resting visual; the strip lights up on hover/drag.
 * Double-click restores the default width. The host panel must be `relative`.
 */
export default function PanelResizeHandle({
  edge,
  dragging,
  onMouseDown,
  onDoubleClick
}: {
  edge: 'left' | 'right'
  dragging: boolean
  onMouseDown: (e: React.MouseEvent) => void
  onDoubleClick: () => void
}): JSX.Element {
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation="vertical"
      className={`absolute inset-y-0 z-10 w-[5px] cursor-col-resize transition-colors hover:bg-accent/50 ${
        edge === 'right' ? 'right-[-2px]' : 'left-[-2px]'
      } ${dragging ? 'bg-accent/60' : ''}`}
    />
  )
}
