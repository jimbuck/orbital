import { useState, type JSX, type KeyboardEvent } from 'react'
import { Folder as FolderClosed, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStatus, type RailFolder } from '@shared/types'
import { useStore } from '@renderer/store'
import { worktreeStatusLabel } from '@renderer/lib/status'
import { fireAndForget } from '@renderer/lib/bridge'
import { GroupChevron, NeedsYouPill } from './Repo'
import ProjectItem from './ProjectItem'
import RenameField from './RenameField'
import { SlotMarker } from './SlotMarker'
import { ContextMenu, MenuConfirm, MenuItem, clampMenuPos, type MenuPos } from './menu'
import { beginRailDrag, type DropTarget, type ProjectRow } from './folders'
import { repoCount } from './railActions'

export { SlotMarker }

/**
 * A folder in the rail: a named, collapsible group of projects.
 *
 * It is an arrangement of the panel and nothing else. The projects inside are
 * the same rows the loose list renders, and nothing about them (paths,
 * worktrees, agent, settings) depends on which folder they sit in.
 *
 * The whole header toggles the folder, since there is nothing to select here
 * the way a repo header selects its root Worktree. Collapsed, the chevron
 * and the count badge stand in for the rows that are hidden, in the same status
 * vocabulary a repo's chevron uses for its hidden Worktrees. Right-click
 * renames or deletes it; deleting only ungroups. The header drags to move the
 * folder along the rail. The Rail owns every drop: it passes `dropInto` while
 * a dragged project would be filed here, `dropSlot` while one would be
 * inserted at a place among the projects already inside, and `dropTarget` for
 * the projects inside to find their own part of.
 */
export default function Folder({
  folder,
  projects,
  dropInto,
  dropSlot,
  dropTarget = null,
  renaming,
  onRenaming
}: {
  folder: RailFolder
  projects: ProjectRow[]
  /** A dragged project would land in this folder if dropped now. */
  dropInto: boolean
  /** The index among `projects` a dragged one would be inserted before (its length = last), or null. */
  dropSlot: number | null
  /** The Rail's current drop target, for the projects inside. */
  dropTarget?: DropTarget | null
  /** Controlled by the Rail, so a folder it has just created can open straight into its name. */
  renaming: boolean
  onRenaming: (renaming: boolean) => void
}): JSX.Element {
  // Every Worktree under the folder, project sessions and repo roots
  // included: collapsed, none of their own dots are on screen, so this is the
  // only place they report.
  const statuses = useStore(
    useShallow((s) => s.worktrees.filter((w) => folder.projectIds.includes(w.projectId)).map((w) => w.status))
  )
  const repoTotal = useStore((s) => s.repos.filter((r) => folder.projectIds.includes(r.projectId)).length)
  const holdsActive = useStore((s) => !!s.activeProjectId && folder.projectIds.includes(s.activeProjectId))
  const expanded = !folder.collapsed
  const status = aggregateStatus(statuses)
  const needsAttention = statuses.filter((s) => s === 'needs_attention').length

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [confirming, setConfirming] = useState(false)

  const closeMenu = (): void => {
    setMenu(null)
    setConfirming(false)
  }
  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setConfirming(false)
    setMenu(clampMenuPos(e, 210, 120))
  }

  const setCollapsed = (collapsed: boolean): void => {
    fireAndForget(window.orbital.setRailFolderCollapsed(folder.id, collapsed))
  }
  const toggle = (): void => setCollapsed(expanded)
  const commitRename = (draft: string): void => {
    const name = draft.trim()
    onRenaming(false)
    if (name && name !== folder.name) fireAndForget(window.orbital.renameRailFolder(folder.id, name))
  }
  const remove = (): void => {
    fireAndForget(window.orbital.removeRailFolder(folder.id))
    closeMenu()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (renaming || e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const open = e.key === 'ArrowRight'
      if (open !== expanded) setCollapsed(!open)
    }
  }

  const Icon = expanded ? FolderOpen : FolderClosed
  const count = repoCount(repoTotal)
  const holds = projects.length > 0 || repoTotal > 0

  return (
    // The data attribute is how the Rail tells which folder a drag is over. The
    // gap below is padding, not margin, so it belongs to this folder and a drag
    // crossing from one folder to the next never passes over "no folder".
    <div data-folder-id={folder.id} className="pb-1">
      <div className={`rounded-[8px] ${dropInto ? 'bg-accent/10 ring-1 ring-inset ring-accent/50' : ''}`}>
        <div
          // How the Rail finds the row to measure a drag against.
          data-folder-header
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => !renaming && toggle()}
          onKeyDown={onKey}
          onContextMenu={openMenu}
          draggable={!renaming}
          onDragStart={(e) => beginRailDrag(e, { kind: 'folder', id: folder.id })}
          className="flex cursor-pointer items-center gap-2 rounded-[8px] px-[9px] py-[6px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <span
            title={status === 'idle' ? undefined : `Worktrees ${worktreeStatusLabel(status)}`}
            className="flex flex-none items-center"
          >
            <GroupChevron expanded={expanded} status={status} />
          </span>
          <span className="flex w-[11px] flex-none items-center justify-center text-faint">
            <Icon size={13} strokeWidth={1.5} className="flex-none" />
          </span>

          <div className="min-w-0 flex-1">
            {renaming ? (
              <RenameField
                initial={folder.name}
                label="Folder name"
                className="text-[12px] font-semibold"
                onCommit={commitRename}
                onCancel={() => onRenaming(false)}
              />
            ) : (
              <div
                className={`truncate text-[12px] font-semibold ${
                  holdsActive && !expanded ? 'text-text' : 'text-text-3'
                }`}
              >
                {folder.name}
                {/* The chevron's tint is a colour, and colour alone is not a status. */}
                {status !== 'idle' && <span className="sr-only"> — worktrees {worktreeStatusLabel(status)}</span>}
              </div>
            )}
          </div>

          {!renaming && !expanded && needsAttention > 0 && <NeedsYouPill count={needsAttention} />}
          {!renaming && (
            <span title={count} className="flex-none font-mono text-[10px] text-faint">
              {repoTotal}
            </span>
          )}
        </div>

        {expanded && (
          <div className="ml-[15px] border-l border-line-2 pl-[5px] pt-[2px]">
            {projects.length > 0 ? (
              <>
                {projects.map((row, i) => (
                  <div key={row.id}>
                    {dropSlot === i && <SlotMarker />}
                    <ProjectItem row={row} dropTarget={dropTarget} />
                  </div>
                ))}
                {dropSlot === projects.length && <SlotMarker />}
              </>
            ) : (
              <div className="px-[9px] pb-[7px] pt-[5px] text-[11px] text-faint">
                Empty. Drag a repo or project here.
              </div>
            )}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu pos={menu} width={210} onClose={closeMenu}>
          {!confirming ? (
            <>
              <MenuItem
                icon={<Pencil size={13} strokeWidth={1.5} />}
                label="Rename"
                onClick={() => {
                  onRenaming(true)
                  closeMenu()
                }}
              />
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<Trash2 size={13} strokeWidth={1.5} />}
                label="Delete Folder"
                danger
                // An empty folder holds nothing to lose track of, so it just goes.
                onClick={() => (holds ? setConfirming(true) : remove())}
              />
            </>
          ) : (
            <MenuConfirm
              message={`Delete the folder "${folder.name}"?`}
              hint="Everything in it stays in Orbital, at the top level. Nothing on disk changes."
              confirmLabel="Delete Folder"
              danger={false}
              onConfirm={remove}
              onCancel={closeMenu}
            />
          )}
        </ContextMenu>
      )}
    </div>
  )
}
