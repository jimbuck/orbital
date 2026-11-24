import { useMemo, useState, type DragEvent, type JSX } from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { useStore } from '@renderer/store'
import { usePanelWidth } from '@renderer/lib/usePanelWidth'
import PanelResizeHandle from '../PanelResizeHandle'
import { CollapsedPane, PaneCollapseTab } from '../PaneCollapse'
import Folder from './Folder'
import ProjectItem from './ProjectItem'
import { SlotMarker } from './SlotMarker'
import RailFooter from './RailFooter'
import { ContextMenu, MenuConfirm, type MenuPos } from './menu'
import {
  currentRailDrag,
  dropAction,
  dropTargetFor,
  endRailDrag,
  railRows,
  sameDropTarget,
  type DropTarget,
  type OverZone,
  type RailAction,
  type RailOver
} from './folders'
import { dissolveConfirm, newRailFolder, runRailAction, type DissolveConfirm } from './railActions'

const HEADER_BUTTON =
  'flex size-6 flex-none items-center justify-center rounded-[7px] border border-line-2 text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60'

/**
 * What the pointer of a drag is over: the innermost member repo, project and
 * folder around it, each with where on its header row the pointer sits. The
 * header (the first row of the block) is what is measured, not the whole
 * block, so an open project's rows and an open folder's rows all count as
 * its body. A header is split in three (top quarter, middle half, bottom
 * quarter): the edges are where a row is slipped in beside the block, the
 * middle is where it goes into it.
 */
function railOverAt(e: DragEvent): RailOver {
  const target = e.target as HTMLElement
  const y = e.clientY
  const below = (header: Element | null | undefined): boolean => {
    const box = header?.getBoundingClientRect()
    return !!box && y > box.top + box.height / 2
  }
  const zoneOn = (header: Element | null | undefined): OverZone => {
    if (!header?.contains(target)) return 'body'
    const box = header.getBoundingClientRect()
    const band = box.height / 4
    return y < box.top + band ? 'top' : y > box.bottom - band ? 'bottom' : 'middle'
  }

  const repoEl = target.closest<HTMLElement>('[data-repo-id]')
  const projectEl = target.closest<HTMLElement>('[data-project-id]')
  const projectHeader = projectEl?.firstElementChild
  const zone = zoneOn(projectHeader)
  // Folders nest, and a folder's own header is the first one inside it.
  const folderEl = target.closest<HTMLElement>('[data-folder-id]')
  const folderHeader = folderEl?.querySelector('[data-folder-header]')

  return {
    repo: repoEl ? { id: repoEl.dataset.repoId ?? '', lowerHalf: below(repoEl.firstElementChild) } : null,
    project: projectEl
      ? {
          id: projectEl.dataset.projectId ?? '',
          lowerHalf: zone === 'body' || below(projectHeader),
          zone
        }
      : null,
    folder: folderEl ? { id: folderEl.dataset.folderId ?? '', zone: zoneOn(folderHeader) } : null
  }
}

/**
 * The left rail: the repo switcher, with add-repo and new-folder affordances
 * up top and a terminal tally in the footer.
 *
 * What the rail arranges is projects: a one-repo project with no home is drawn
 * as its repo's row, anything else as a group (see ProjectGroup). Dragging a
 * repo onto another project's row adds it there, and dragging it out of a
 * group gives it a project of its own. Projects can be filed in folders, a
 * group's repos in folders of its own, and folders in folders. The rail's
 * order is the user's: a folder sits anywhere among the rows beside it, and
 * every list is ordered by hand. The rail is also the one drop zone for its
 * own drags. What a drop
 * would do is decided by `dropTargetFor` and `dropAction`; this component turns
 * the pointer into their inputs and paints the answer.
 */
export default function Rail(): JSX.Element {
  const repos = useStore((s) => s.repos)
  const projects = useStore((s) => s.projects)
  const folders = useStore((s) => s.railFolders)
  const rail = useStore((s) => s.railItems)
  const projectItems = useStore((s) => s.railProjectItems)
  const expanded = useStore((s) => s.expanded)
  const railMessage = useStore((s) => s.railMessage)
  const openModal = useStore((s) => s.openModal)
  const { width, collapsed, dragging, startResize, resetWidth, toggleCollapsed } = usePanelWidth({
    storageKey: 'orbital.railWidth',
    defaultWidth: 266,
    min: 200,
    max: 440,
    handleEdge: 'right'
  })
  const rows = useMemo(
    () => railRows(projects, repos, folders, rail, expanded, projectItems),
    [projects, repos, folders, rail, expanded, projectItems]
  )
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // A drop waiting on its confirm: it would close a folder session that has
  // terminals open. Asked at the drop point, like a menu.
  const [pendingDrop, setPendingDrop] = useState<{
    action: RailAction
    pos: MenuPos
    confirm: DissolveConfirm
  } | null>(null)

  if (collapsed) return <CollapsedPane edge="right" label="projects panel" onExpand={toggleCollapsed} />

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
    const action = dropAction(drag, rows, target)
    if (!action) return
    const confirm = dissolveConfirm(action)
    if (confirm) {
      setPendingDrop({
        action,
        confirm,
        pos: {
          x: Math.max(0, Math.min(e.clientX, window.innerWidth - 262)),
          y: Math.max(0, Math.min(e.clientY, window.innerHeight - 160))
        }
      })
      return
    }
    runRailAction(action)
  }

  // The top-level slot a drop would open. A folder or a group finds its own in `dropTarget`.
  const topSlot = dropTarget?.kind === 'slot' && dropTarget.folderId === null ? dropTarget.index : -1

  return (
    <aside style={{ width }} className="relative flex flex-none flex-col border-r border-line bg-rail">
      <div className="flex items-center justify-between border-b border-soft px-[14px] pb-3 pt-[14px]">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.9px] text-faint">Projects</div>
          <div className="mt-[3px] text-[11px] text-dim">
            {projects.length} project{projects.length === 1 ? '' : 's'} · get work done from orbit
          </div>
        </div>
        <div className="flex flex-none items-center gap-[6px]">
          <button
            type="button"
            aria-label="New folder"
            title="New folder"
            onClick={() => newRailFolder()}
            className={HEADER_BUTTON}
          >
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
              <Folder row={row} dropTarget={dropTarget} />
            ) : (
              <ProjectItem row={row} dropTarget={dropTarget} />
            )}
          </div>
        ))}
        {topSlot === rows.length && <SlotMarker />}
      </div>

      {/* What a drop or a rail menu just did, for a screen reader. */}
      <div aria-live="polite" className="sr-only">
        {railMessage}
      </div>

      {pendingDrop && (
        <ContextMenu pos={pendingDrop.pos} width={250} onClose={() => setPendingDrop(null)}>
          <MenuConfirm
            message={pendingDrop.confirm.message}
            hint={pendingDrop.confirm.hint}
            confirmLabel={pendingDrop.confirm.confirmLabel}
            danger={false}
            onConfirm={() => {
              runRailAction(pendingDrop.action)
              setPendingDrop(null)
            }}
            onCancel={() => setPendingDrop(null)}
          />
        </ContextMenu>
      )}

      <RailFooter />
      <PanelResizeHandle edge="right" dragging={dragging} onMouseDown={startResize} onDoubleClick={resetWidth} />
      <PaneCollapseTab
        edge="right"
        label="projects panel"
        onCollapse={toggleCollapsed}
        onResizeStart={startResize}
      />
    </aside>
  )
}
