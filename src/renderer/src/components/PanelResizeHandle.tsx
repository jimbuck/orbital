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
  onDoubleClick,
  onNudge,
  value
}: {
  edge: 'left' | 'right'
  dragging: boolean
  onMouseDown: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  /** Enables keyboard resizing: called with a signed px delta (Left/Right arrows, Shift = larger step). */
  onNudge?: (delta: number) => void
  /** Current width, exposed as aria-valuenow when keyboard resizing is enabled. */
  value?: number
}): JSX.Element {
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation="vertical"
      {...(onNudge
        ? {
            tabIndex: 0,
            'aria-valuenow': value,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              const step = e.shiftKey ? 50 : 10
              onNudge(e.key === 'ArrowRight' ? step : -step)
            }
          }
        : {})}
      className={`absolute inset-y-0 z-10 w-[5px] cursor-col-resize transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none ${
        edge === 'right' ? 'right-[-2px]' : 'left-[-2px]'
      } ${dragging ? 'bg-accent/60' : ''}`}
    />
  )
}
