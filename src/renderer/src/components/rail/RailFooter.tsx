import type { JSX } from 'react'
import { Settings } from 'lucide-react'
import { useStore } from '@renderer/store'

/**
 * Rail footer: a live count of open terminal tabs across every Flight, plus a
 * shortcut into Settings.
 */
export default function RailFooter(): JSX.Element {
  const flights = useStore((s) => s.flights)
  const openModal = useStore((s) => s.openModal)

  const terminalCount = flights.reduce(
    (total, flight) =>
      total +
      flight.panes.reduce((sum, pane) => sum + pane.tabs.filter((tab) => tab.type === 'terminal').length, 0),
    0
  )

  return (
    <div className="flex items-center justify-between border-t border-soft px-[14px] py-[11px]">
      <div className="flex items-center gap-2">
        <span className="size-2 flex-none rounded-full bg-green shadow-[0_0_8px_rgba(61,220,151,0.55)]" />
        <span className="whitespace-nowrap text-[11.5px] text-muted">
          {terminalCount} terminal{terminalCount === 1 ? '' : 's'} in flight
        </span>
      </div>
      <button
        type="button"
        aria-label="Settings"
        onClick={() => openModal('settings')}
        className="flex flex-none items-center rounded text-faint outline-none hover:text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <Settings size={15} strokeWidth={1.5} />
      </button>
    </div>
  )
}
