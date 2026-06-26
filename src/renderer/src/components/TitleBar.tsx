import type { JSX } from 'react'
import { Minus, Square, X, ChevronRight } from 'lucide-react'
import { useStore, activeWorkspace, activeFlight } from '@renderer/store'

/**
 * Native (frameless) window titlebar. The whole bar is a drag region; the
 * breadcrumb on the left orients the user, while the alert banner + window
 * controls on the right opt out of dragging via `no-drag`.
 */
export default function TitleBar(): JSX.Element {
  const wsName = useStore((s) => activeWorkspace(s)?.name ?? 'orbital')
  const flightName = useStore((s) => activeFlight(s)?.name)
  const alertCount = useStore((s) => s.alertCount)

  return (
    <header className="drag-region flex h-[34px] flex-none items-center justify-between border-b border-line bg-bar pl-[14px]">
      {/* Brand + breadcrumb */}
      <div className="flex min-w-0 items-center gap-[10px]">
        {/* Orbit logo mark: a faint accent ring with a glowing core. */}
        <div className="relative size-[15px] flex-none">
          <div className="absolute inset-0 rounded-full border-[1.2px] border-accent/55" />
          <div className="absolute left-1/2 top-1/2 -ml-[2.5px] -mt-[2.5px] size-[5px] rounded-full bg-accent shadow-[0_0_7px_rgba(79,140,255,0.9)]" />
        </div>
        <span className="text-[12px] font-semibold tracking-[0.2px]">Orbital</span>
        <span className="text-[11px] text-faint">—</span>
        <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-dim">
          <span>{wsName}</span>
          {flightName && (
            <>
              <ChevronRight size={12} strokeWidth={1.5} className="flex-none text-faint" />
              <span className="truncate text-text-3">{flightName}</span>
            </>
          )}
        </span>
      </div>

      {/* Alert banner + window controls */}
      <div className="no-drag flex items-center gap-1">
        {alertCount > 0 && (
          <div className="mr-2 flex items-center gap-[7px] rounded-[7px] border border-amber/25 bg-amber/12 py-[3px] pl-2 pr-[9px]">
            <span className="relative size-[7px] flex-none">
              <span className="absolute inset-0 rounded-full bg-amber animate-pulse-dot" />
            </span>
            <span className="whitespace-nowrap text-[11px] font-semibold text-amber-2">
              {alertCount} {alertCount === 1 ? 'agent needs' : 'agents need'} you
            </span>
          </div>
        )}
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => window.orbital.windowMinimize()}
          className="flex h-[34px] w-[46px] items-center justify-center text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Minus size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={() => window.orbital.windowMaximize()}
          className="flex h-[34px] w-[46px] items-center justify-center text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Square size={13} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => window.orbital.windowClose()}
          className="flex h-[34px] w-[46px] items-center justify-center text-muted outline-none hover:bg-[#c4314b] hover:text-white focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  )
}
