import { useRef, type JSX } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Collapse/expand for the cockpit's side panels: one grip, on the panel's
 * inner border, in both states.
 *
 * At rest it is a short pill lying on the border line, the mark a split view
 * carries to say its edge can be moved. Under the pointer (or keyboard focus)
 * it opens into a small button with a chevron pointing the way the panel will
 * go: toward the window edge to tuck it away, toward the centre to bring it
 * back. Nothing is drawn over the panel's own content, which is what the old
 * pull-tab did.
 *
 * `edge` is the panel's inner edge, where its resize handle lives: 'right' for
 * the left rail, 'left' for the right panel.
 */

/** What the pointer has to travel before a press on the grip is a drag and not a click. */
const DRAG_SLOP_PX = 3

/** The pill, and the chevron it opens to show. The button around it is `group/grip`. */
function Grip({ chevron: Chevron }: { chevron: typeof ChevronLeft }): JSX.Element {
  return (
    <span
      aria-hidden
      className="pointer-events-none flex h-8 w-1 flex-none items-center justify-center overflow-hidden rounded-full bg-line-strong text-transparent transition-[width,height,background-color,color,box-shadow] duration-150 ease-out group-hover/grip:h-10 group-hover/grip:w-3 group-hover/grip:bg-elev group-hover/grip:text-text-2 group-hover/grip:ring-1 group-hover/grip:ring-line-strong group-focus-visible/grip:h-10 group-focus-visible/grip:w-3 group-focus-visible/grip:bg-elev group-focus-visible/grip:text-text-2 group-focus-visible/grip:ring-2 group-focus-visible/grip:ring-accent/60 motion-reduce:transition-none"
    >
      <Chevron size={11} strokeWidth={2} className="flex-none" />
    </span>
  )
}

/**
 * The strip a collapsed panel leaves behind. All of it re-opens the panel, so
 * the target is the full height of the window even though the mark is small.
 */
export function CollapsedPane({
  edge,
  label,
  onExpand
}: {
  edge: 'left' | 'right'
  label: string
  onExpand: () => void
}): JSX.Element {
  return (
    <aside className={`flex w-4 flex-none bg-rail ${edge === 'right' ? 'border-r' : 'border-l'} border-line`}>
      <button
        type="button"
        aria-label={`Expand ${label}`}
        title={`Expand ${label}`}
        onClick={onExpand}
        className="group/grip flex flex-1 cursor-pointer items-center justify-center outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
      >
        <Grip chevron={edge === 'right' ? ChevronRight : ChevronLeft} />
      </button>
    </aside>
  )
}

/**
 * The grip on an open panel's inner border. A click collapses the panel. It
 * looks like something to drag, so it is: given `onResizeStart` (the resize
 * handle's own mouse-down), a press that moves resizes the panel instead, and
 * only a press that stays put collapses it. The host must be `relative`.
 */
export function PaneCollapseTab({
  edge,
  label,
  onCollapse,
  onResizeStart
}: {
  edge: 'left' | 'right'
  label: string
  onCollapse: () => void
  onResizeStart?: (e: React.MouseEvent) => void
}): JSX.Element {
  const pressedAt = useRef<number | null>(null)
  return (
    <button
      type="button"
      aria-label={`Collapse ${label}`}
      title={`Collapse ${label}${onResizeStart ? ' · drag to resize' : ''}`}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        pressedAt.current = e.clientX
        onResizeStart?.(e)
      }}
      onClick={(e) => {
        // `detail` is 0 for a keyboard activation, which has no press to measure.
        const dragged =
          e.detail !== 0 && pressedAt.current !== null && Math.abs(e.clientX - pressedAt.current) > DRAG_SLOP_PX
        pressedAt.current = null
        if (!dragged) onCollapse()
      }}
      // Centred on the border line, so half of it is over the panel and half
      // over the pane beside it, and none of it covers a scrollbar or a row.
      className={`group/grip absolute top-1/2 z-20 flex h-14 w-4 -translate-y-1/2 cursor-pointer items-center justify-center outline-none ${
        edge === 'right' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'
      }`}
    >
      <Grip chevron={edge === 'right' ? ChevronLeft : ChevronRight} />
    </button>
  )
}
