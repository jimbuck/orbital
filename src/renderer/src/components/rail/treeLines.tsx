import type { JSX, ReactNode } from 'react'
import type { Worktree } from '@shared/types'
import WorktreeRow from './WorktreeRow'

/*
 * The two kinds of line the rail draws under a row, which are how a worktree
 * is told from a repo at a glance:
 *
 * - A worktree is a branch of the repo above it. A trunk drops out of that
 *   repo's status dot and curves into each worktree's own dot, so the two are
 *   joined end to end.
 * - A repo or folder inside a project or folder is only a child of it. Its
 *   list is indented behind a plain rule under the parent's chevron, which
 *   touches neither the parent nor the rows.
 *
 * The geometry is tied to the header rows in Repo and ProjectGroup: 9px of
 * padding, a 14px chevron, an 8px gap, then an 11px cell holding the dot. That
 * puts the dot's centre 36.5px in, so the trunk runs at 36px.
 */

const LINE = 'pointer-events-none absolute border-line-strong'

/** The list of a project's or folder's children: indented, behind a rule that stops short of the parent. */
export const CHILD_LIST = 'ml-[15px] mt-[3px] border-l border-line-2 pl-[5px]'

/**
 * The cell a header row keeps its status dot in. It is as tall as the row so
 * that a `BranchStub` inside it can reach the row's bottom edge.
 */
export const DOT_CELL = 'relative flex w-[11px] flex-none items-center justify-center self-stretch'

/**
 * The start of the trunk: from just under a header's status dot to the bottom
 * of the header, where `WorktreeBranches` picks it up. It goes inside the
 * header's `DOT_CELL`; the 8px it overshoots by is the header's `py-2`.
 */
export function BranchStub(): JSX.Element {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -bottom-2 left-[5px] top-[calc(50%+9px)] w-px bg-line-strong"
    />
  )
}

/**
 * A repo's linked worktrees, drawn as branches off the header above (which
 * must hold a `BranchStub`). `children` follow the last branch, unconnected.
 */
export function WorktreeBranches({
  worktrees,
  label,
  children
}: {
  worktrees: Worktree[]
  /** What the list is, for a screen reader: the lines say it only to the eye. */
  label: string
  children?: ReactNode
}): JSX.Element {
  return (
    // No top margin of its own: the 2px above the first row is the same gap
    // every row's trunk reaches back across.
    <div role="group" aria-label={label} className="mb-[6px] ml-[36px] flex flex-col gap-[2px] pl-[7px] pt-[2px]">
      {worktrees.map((worktree, i) => (
        <div key={worktree.id} className="relative">
          <WorktreeRow worktree={worktree} />
          {/* The trunk: on past this row to the next, or only as far as the curve when this is the last. */}
          <span
            aria-hidden
            className={`${LINE} -left-[7px] -top-[2px] border-l ${
              i < worktrees.length - 1 ? 'bottom-0' : 'h-[calc(50%-6px)]'
            }`}
          />
          {/* The curve out of the trunk, ending just short of the row's dot. */}
          <span
            aria-hidden
            className={`${LINE} -left-[7px] top-[calc(50%-8px)] h-2 w-[14px] rounded-bl-[8px] border-b border-l`}
          />
        </div>
      ))}
      {children}
    </div>
  )
}
