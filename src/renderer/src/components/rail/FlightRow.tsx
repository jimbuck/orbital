import type { JSX } from 'react'
import type { Flight } from '@shared/types'
import { useStore } from '@renderer/store'
import { StatusDot, flightStatusLabel, flightStatusTextClass } from '@renderer/lib/status'

/**
 * A single Flight entry inside an expanded workspace. Selecting it makes the
 * Flight active; the leading dot + optional "needs you" label carry its status.
 */
export default function FlightRow({ flight }: { flight: Flight }): JSX.Element {
  const setActiveFlight = useStore((s) => s.setActiveFlight)
  const isActive = useStore((s) => s.activeFlightId === flight.id)
  const isDone = flight.status === 'done'

  return (
    <button
      type="button"
      onClick={() => setActiveFlight(flight.id)}
      className={`flex w-full items-center gap-[9px] rounded-[7px] px-[9px] py-[7px] text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
        isActive ? 'bg-panel-2' : 'hover:bg-hover'
      } ${isDone ? 'opacity-60' : ''}`}
    >
      <span className="flex w-[11px] flex-none items-center justify-center">
        <StatusDot status={flight.status} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-[6px]">
          <span
            className={`truncate text-[12.5px] ${isActive ? 'font-bold' : 'font-semibold'} ${
              isActive ? 'text-text' : isDone ? 'text-text-3' : 'text-text-2'
            }`}
          >
            {flight.name}
          </span>
          {flight.kind === 'root' && (
            <span className="flex-none rounded-[4px] border border-line-2 px-1 text-[9px] leading-[13px] text-faint">
              root
            </span>
          )}
        </span>
        <span className="mt-[2px] block truncate font-mono text-[10px] text-faint">{flight.branch}</span>
      </span>

      {flight.status === 'needs_attention' && (
        <span
          className={`flex-none whitespace-nowrap text-[9.5px] font-bold ${flightStatusTextClass(flight.status)}`}
        >
          {flightStatusLabel(flight.status)}
        </span>
      )}
    </button>
  )
}
