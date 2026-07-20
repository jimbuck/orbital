import type { JSX } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Collapse/expand affordances for the cockpit's side panels. The chevron always
 * points the way the panel moves: toward the window edge to tuck it away, toward
 * the center to bring it back. `edge` is the panel's inner edge — where its
 * resize handle lives — 'right' for the left rail, 'left' for the right panel.
 */

/** Slim strip shown in place of a collapsed panel; the whole strip re-opens it. */
export function CollapsedPane({
  edge,
  label,
  onExpand
}: {
  edge: 'left' | 'right'
  label: string
  onExpand: () => void
}): JSX.Element {
  const Chevron = edge === 'right' ? ChevronRight : ChevronLeft
  return (
    <aside className={`flex w-8 flex-none flex-col bg-rail ${edge === 'right' ? 'border-r' : 'border-l'} border-line`}>
      <button
        type="button"
        aria-label={`Expand ${label}`}
        title={`Expand ${label}`}
        onClick={onExpand}
        className="flex flex-1 items-center justify-center text-faint outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <Chevron size={16} strokeWidth={1.5} />
      </button>
    </aside>
  )
}

/** Pull-tab clipped to a panel's inner edge that collapses it. Host must be `relative`. */
export function PaneCollapseTab({
  edge,
  label,
  onCollapse
}: {
  edge: 'left' | 'right'
  label: string
  onCollapse: () => void
}): JSX.Element {
  const Chevron = edge === 'right' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      aria-label={`Collapse ${label}`}
      title={`Collapse ${label}`}
      onClick={onCollapse}
      className={`absolute top-1/2 z-20 flex h-9 w-[14px] -translate-y-1/2 items-center justify-center bg-rail text-faint outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 ${
        edge === 'right' ? 'right-0 rounded-l-md' : 'left-0 rounded-r-md'
      }`}
    >
      <Chevron size={13} strokeWidth={1.5} />
    </button>
  )
}
