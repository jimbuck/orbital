import { useMemo, useState, type DragEvent, type JSX } from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { useStore } from '@renderer/store'
import { usePanelWidth } from '@renderer/lib/usePanelWidth'
import { fireAndForget } from '@renderer/lib/bridge'
import PanelResizeHandle from '../PanelResizeHandle'
import { CollapsedPane, PaneCollapseTab } from '../PaneCollapse'
import Folder, { SlotMarker } from './Folder'
import Repo from './Repo'
import RailFooter from './RailFooter'
import {
  beforeIdAt,
  currentRailDrag,
  dropTargetFor,
  endRailDrag,
  railRows,
  sameDropTarget,
  type DropTarget,
  type RailOver
} from './folders'

const HEADER_BUTTON =
  'flex size-6 flex-none items-center justify-center rounded-[7px] border border-line-2 text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60'

/**
 * What the pointer of a drag is over: the project and the folder it is inside
 * of, each with where on its header row the pointer sits. The header (the first
 * row of the block) is what is measured, not the whole block, so an open
 * project's Worktrees and an open folder's projects all count as "below".
 */
function railOverAt(e: DragEvent): RailOver {
  const target = e.target as HTMLElement
  const y = e.clientY
  const below = (header: Element | null | undefined): boolean => {
    const box = header?.getBoundingClientRect()
    return !!box && y > box.top + box.height / 2
  }

  const projectEl = target.closest<HTMLElement>('[data-project-id]')
  const folderEl = target.closest<HTMLElement>('[data-folder-id]')
  const folderHeader = folderEl?.querySelector('[data-folder-header]')
  const box = folderHeader?.getBoundingClientRect()
  let edge: 'top' | 'bottom' | null = null
  if (box) {
    const band = box.height / 4
    if (y < box.top + band) edge = 'top'
    else if (y > box.bottom - band && y <= box.bottom) edge = 'bottom'
  }

  return {
    project: projectEl
      ? { id: projectEl.dataset.projectId ?? '', lowerHalf: below(projectEl.firstElementChild) }
      : null,
    folder: folderEl ? { id: folderEl.dataset.folderId ?? '', lowerHalf: below(folderHeader), edge } : null
  }
}

/**
 * The left rail: the repo switcher. Lists every repo as a collapsible
 * group of Worktrees, with add-repo and new-folder affordances up top and a
 * terminal tally in the footer.
 *
 * What the rail arranges is projects: each one is drawn through its repo (one
 * per project, for now). Projects can be filed in folders, and the rail's
 * order is the user's: a folder sits anywhere among the loose projects, and
 * projects are ordered by hand both at the top level and inside a folder.
 * All of that only arranges
 * this panel. The rail is also the one drop zone for its own drags. What a
 * drop would do is decided by `dropTargetFor`; this component turns the
 * pointer into its inputs and paints the answer.
 */
export default function Rail(): JSX.Element {
  const repos = useStore((s) => s.repos)
  const projects = useStore((s) => s.projects)
  const folders = useStore((s) => s.railFolders)
  const rail = useStore((s) => s.railItems)
  const openModal = useStore((s) => s.openModal)
  const { width, collapsed, dragging, startResize, resetWidth, toggleCollapsed } = usePanelWidth({
    storageKey: 'orbital.railWidth',
    defaultWidth: 266,
    min: 200,
    max: 440,
    handleEdge: 'right'
  })
  const rows = useMemo(() => railRows(projects, repos, folders, rail), [projects, repos, folders, rail])
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // The folder whose name is being edited. Held here, not in the folder, so
  // that one created from the header button opens straight into its name.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)

  if (collapsed) return <CollapsedPane edge="right" label="repos panel" onExpand={toggleCollapsed} />

  const newFolder = (): void => {
    fireAndForget(window.orbital.createRailFolder('New Folder').then((folder) => setRenamingFolderId(folder.id)))
  }

  const targetAt = (e: DragEvent): DropTarget | null => {
    const drag = currentRailDrag()
    return drag ? dropTargetFor(drag, rows, railOverAt(e)) : null
  }
  const onDragOver = (e: DragEvent): void => {
    const target = targetAt(e)
    // dragover fires continuously; only a change of target is worth a render.
    setDropTarget((prev) => (sameDropTarget(prev, target) ? prev : target))
    // Not cancelling the event is what tells the OS this is not a drop point.
    if (!target) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const onDragLeave = (e: DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null)
  }
  const onDragEnd = (): void => {
    setDropTarget(null)
    endRailDrag()
  }
  const onDrop = (e: DragEvent): void => {
    const drag = currentRailDrag()
    const target = targetAt(e)
    onDragEnd()
    if (!drag || !target) return
    e.preventDefault()
    const beforeId = beforeIdAt(rows, target)
    if (drag.kind === 'folder') {
      fireAndForget(window.orbital.placeRailFolder(drag.id, beforeId))
    } else {
      fireAndForget(window.orbital.placeProject(drag.id, target.folderId, beforeId))
    }
  }

  // The top-level slot a drop would open, and the slot inside one folder.
  const topSlot = dropTarget?.kind === 'slot' && dropTarget.folderId === null ? dropTarget.index : -1
  const slotIn = (folderId: string): number | null =>
    dropTarget?.kind === 'slot' && dropTarget.folderId === folderId ? dropTarget.index : null

  return (
    <aside style={{ width }} className="relative flex flex-none flex-col border-r border-line bg-rail">
      <div className="flex items-center justify-between border-b border-soft px-[14px] pb-3 pt-[14px]">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.9px] text-faint">Repos</div>
          <div className="mt-[3px] text-[11px] text-dim">
            {repos.length} repo{repos.length === 1 ? '' : 's'} · get work done from orbit
          </div>
        </div>
        <div className="flex flex-none items-center gap-[6px]">
          <button type="button" aria-label="New folder" title="New folder" onClick={newFolder} className={HEADER_BUTTON}>
            <FolderPlus size={14} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            aria-label="Add repo"
            title="Add repo"
            onClick={() => openModal('addRepo')}
            className={HEADER_BUTTON}
          >
            <Plus size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* The bottom padding is drop space: below the last row is how a row is
          sent to the end, so there has to be some "below" even in a full rail. */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDragEnd={onDragEnd}
        onDrop={onDrop}
        className="flex-1 overflow-y-auto px-[9px] pb-6 pt-[10px]"
      >
        {rows.map((row, i) => (
          <div key={row.id}>
            {topSlot === i && <SlotMarker />}
            {row.kind === 'folder' ? (
              <Folder
                folder={row.folder}
                projects={row.projects}
                dropInto={dropTarget?.kind === 'into' && dropTarget.folderId === row.id}
                dropSlot={slotIn(row.id)}
                renaming={renamingFolderId === row.id}
                onRenaming={(renaming) => setRenamingFolderId(renaming ? row.id : null)}
              />
            ) : (
              <Repo repo={row.repo} />
            )}
          </div>
        ))}
        {topSlot === rows.length && <SlotMarker />}
      </div>

      <RailFooter />
      <PanelResizeHandle edge="right" dragging={dragging} onMouseDown={startResize} onDoubleClick={resetWidth} />
      <PaneCollapseTab edge="right" label="repos panel" onCollapse={toggleCollapsed} />
    </aside>
  )
}
