import type { JSX } from 'react'

/** Where a dragged row would be inserted. Zero-height, so showing it never shifts the rows it sits between. */
export function SlotMarker(): JSX.Element {
  return (
    <div className="pointer-events-none relative h-0">
      <div className="absolute inset-x-[6px] -top-[3px] h-[2px] rounded-full bg-accent" />
    </div>
  )
}
