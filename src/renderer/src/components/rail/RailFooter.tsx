import type { JSX } from 'react'
import { Settings } from 'lucide-react'
import { isPtyTabType } from '@shared/types'
import { useStore } from '@renderer/store'

/**
 * Rail footer: a live count of open PTY-backed tabs (terminals + agents) across
 * every Worktree, plus a shortcut into Settings.
 */
export default function RailFooter(): JSX.Element {
  const worktrees = useStore((s) => s.worktrees)
  const openModal = useStore((s) => s.openModal)

  const terminalCount = worktrees.reduce(
    (total, worktree) =>
      total +
      worktree.panes.reduce((sum, pane) => sum + pane.tabs.filter((tab) => isPtyTabType(tab.type)).length, 0),
    0
  )

  return (
    <div className="flex items-center justify-between border-t border-soft px-[14px] py-[11px]">
      <div className="flex items-center gap-2">
        <span className="size-2 flex-none rounded-full bg-green shadow-[0_0_8px_rgba(61,220,151,0.55)]" />
        <span className="whitespace-nowrap text-[11.5px] text-muted">
          {terminalCount} terminal{terminalCount === 1 ? '' : 's'} in worktrees
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
