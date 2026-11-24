import { useMemo, useState, type JSX, type KeyboardEvent } from 'react'
import { Folder as FolderClosed, FolderOpen, FolderPlus, ListPlus, Pencil, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStatus, type Project } from '@shared/types'
import { useStore } from '@renderer/store'
import { worktreeStatusLabel } from '@renderer/lib/status'
import { fireAndForget } from '@renderer/lib/bridge'
import Repo, { GroupChevron, NeedsYouPill } from './Repo'
import ProjectItem from './ProjectItem'
import RenameField from './RenameField'
import { SlotMarker } from './SlotMarker'
import { CHILD_LIST } from './treeLines'
import { ContextMenu, MenuConfirm, MenuItem, clampMenuPos, type MenuPos } from './menu'
import { beginRailDrag, leafRows, type DropTarget, type FolderRow, type ProjectRow, type RepoRow } from './folders'
import { newRailFolder, repoCount } from './railActions'

export { SlotMarker }

/**
 * A folder in the rail: a named, collapsible group of rows.
 *
 * There are two kinds, drawn the same way. A folder of projects sits in the
 * rail's own list and holds projects; a folder of repos sits under a
 * project's header (`project` is that project) and holds its member repos.
 * Either holds more folders of its own kind.
 *
 * It is an arrangement of the panel and nothing else. The rows inside are the
 * same rows the list outside renders, and nothing about them (paths,
 * worktrees, agent, settings) depends on which folder they sit in.
 *
 * The whole header toggles the folder, since there is nothing to select here
 * the way a repo header selects its root Worktree. Collapsed, the chevron
 * and the count badge stand in for the rows that are hidden, in the same status
 * vocabulary a repo's chevron uses for its hidden Worktrees. Right-click
 * renames it, adds a repo to it, makes a folder inside it, or deletes it;
 * deleting only ungroups.
 * The header drags to move the folder. The Rail owns every drop: `dropTarget`
 * is its current one, which this folder reads its own part of (a row would be
 * filed here, or inserted at a place among the rows already inside) and hands
 * on to the rows inside.
 */
export default function Folder({
  row,
  project,
  dropTarget = null
}: {
  row: FolderRow<ProjectRow> | FolderRow<RepoRow>
  /** The project whose repos this folder arranges; absent for a folder of projects. */
  project?: Project
  /** The Rail's current drop target. */
  dropTarget?: DropTarget | null
}): JSX.Element {
  const { folder } = row
  // What the folder holds at any depth: project ids for a folder of projects,
  // repo ids for a folder of repos.
  const held = useMemo(() => {
    const leaves = leafRows<ProjectRow | RepoRow>(row.items)
    const repoTotal = leaves.reduce(
      (n, leaf) => n + (leaf.kind === 'group' ? leaf.members.length + (leaf.home ? 1 : 0) : 1),
      0
    )
    return { ids: new Set(leaves.map((leaf) => leaf.id)), repoTotal }
  }, [row])
  // Every Worktree under the folder, project sessions and repo roots
  // included: collapsed, none of their own dots are on screen, so this is the
  // only place they report.
  const statuses = useStore(
    useShallow((s) =>
      s.worktrees
        .filter((w) => (project ? !!w.repoId && held.ids.has(w.repoId) : held.ids.has(w.projectId)))
        .map((w) => w.status)
    )
  )
  const holdsActive = useStore((s) => {
    const active = project ? s.activeRepoId : s.activeProjectId
    return !!active && held.ids.has(active)
  })
  const renaming = useStore((s) => s.renamingFolderId === folder.id)
  const setRenamingFolder = useStore((s) => s.setRenamingFolder)
  const openModal = useStore((s) => s.openModal)
  const expanded = !folder.collapsed
  const status = aggregateStatus(statuses)
  const needsAttention = statuses.filter((s) => s === 'needs_attention').length
  const dropInto = dropTarget?.kind === 'into' && dropTarget.folderId === folder.id
  const dropSlot = dropTarget?.kind === 'slot' && dropTarget.folderId === folder.id ? dropTarget.index : null

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
    setMenu(clampMenuPos(e, 210, 180))
  }

  const setCollapsed = (collapsed: boolean): void => {
    fireAndForget(window.orbital.setRailFolderCollapsed(folder.id, collapsed))
  }
  const toggle = (): void => setCollapsed(expanded)
  const commitRename = (draft: string): void => {
    const name = draft.trim()
    setRenamingFolder(null)
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
  const count = repoCount(held.repoTotal)
  const holds = row.items.length > 0

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
                onCancel={() => setRenamingFolder(null)}
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
              {held.repoTotal}
            </span>
          )}
        </div>

        {expanded && (
          <div className={CHILD_LIST}>
            {holds ? (
              <>
                {row.items.map((item, i) => (
                  <div key={item.id}>
                    {dropSlot === i && <SlotMarker />}
                    {item.kind === 'folder' ? (
                      <Folder row={item} project={project} dropTarget={dropTarget} />
                    ) : item.kind === 'repo' ? (
                      <Repo repo={item.repo} project={project} variant="member" />
                    ) : (
                      <ProjectItem row={item} dropTarget={dropTarget} />
                    )}
                  </div>
                ))}
                {dropSlot === row.items.length && <SlotMarker />}
              </>
            ) : (
              <div className="px-[9px] pb-[7px] pt-[5px] text-[11px] text-faint">
                {project
                  ? 'Empty. Drag a repo here, or right-click to add one.'
                  : 'Empty. Drag a repo or project here, or right-click to add a repo.'}
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
                  setRenamingFolder(folder.id)
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<ListPlus size={13} strokeWidth={1.5} />}
                label="Add Repo…"
                onClick={() => {
                  // The same dialog as everywhere else; main files what it adds here.
                  openModal('addRepo', { projectId: project?.id, folderId: folder.id })
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<FolderPlus size={13} strokeWidth={1.5} />}
                label="New Folder Inside"
                onClick={() => {
                  // Main opens this folder, so the new one is on screen to be named.
                  newRailFolder({ parentId: folder.id })
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
              hint="Everything in it stays in Orbital, where the folder was. Nothing on disk changes."
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
