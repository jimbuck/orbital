import { useState, type JSX } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleOff,
  FolderDown,
  FolderInput,
  FolderPlus,
  ListPlus,
  Pencil,
  Trash2
} from 'lucide-react'
import type { Project } from '@shared/types'
import { useStore } from '@renderer/store'
import { fireAndForget } from '@renderer/lib/bridge'
import { ContextMenu, MenuConfirm, MenuItem, type MenuPos } from './menu'
import { FolderStep, GatherStep, useRailRows } from './menuSteps'
import { leafRows, placeOf, type FolderRow, type ProjectRow, type RepoRow } from './folders'
import { newRailFolder } from './railActions'

type Row = FolderRow<ProjectRow> | FolderRow<RepoRow>
type Step = 'items' | 'gather' | 'move' | 'confirmDelete'

/** Every folder inside `row`, at any depth. */
function foldersInside(row: Row): Row[] {
  return row.items.flatMap((item) => (item.kind === 'folder' ? [item as Row, ...foldersInside(item as Row)] : []))
}

/**
 * A rail folder's right-click menu, for either kind of folder.
 *
 * Everything in it is rail arrangement: naming the folder, adding to it (a
 * repo new to Orbital, rows already in the rail, a folder), moving it (into
 * another folder, or to either end of the list it is in), opening or closing
 * what it holds, and deleting it, which only ungroups. Clear Status is the one
 * item that reaches past the arrangement, and it does what the same item on a
 * repo row does, for every worktree under the folder.
 *
 * Items that could do nothing are left out rather than greyed: Move to Top on
 * the first row, Expand All where nothing inside opens or closes.
 */
export default function FolderMenu({
  row,
  project,
  pos,
  onClose
}: {
  row: Row
  /** The project whose repos this folder arranges; absent for a folder of projects. */
  project?: Project
  pos: MenuPos
  onClose: () => void
}): JSX.Element {
  const { folder } = row
  const [step, setStep] = useState<Step>('items')
  const rows = useRailRows()
  const setRenamingFolder = useStore((s) => s.setRenamingFolder)
  const setExpanded = useStore((s) => s.setExpanded)
  const openModal = useStore((s) => s.openModal)

  const leaves = leafRows<ProjectRow | RepoRow>(row.items)
  const holds = row.items.length > 0
  const place = placeOf(rows, 'folder', folder.id)
  const first = !place || place.index === 0
  const last = !place || place.index === place.ids.length - 1

  // What opens and closes under this folder: the folders in it, and (in a
  // folder of projects) the projects drawn as groups. A repo's own worktrees
  // are that row's business.
  const inner = foldersInside(row)
  const groups = leaves.filter((leaf): leaf is Extract<ProjectRow, { kind: 'group' }> => leaf.kind === 'group')
  const allOpen = !folder.collapsed && inner.every((f) => !f.folder.collapsed) && groups.every((g) => g.open)
  const setAllOpen = (open: boolean): void => {
    for (const f of [row, ...inner]) {
      if (f.folder.collapsed === open) fireAndForget(window.orbital.setRailFolderCollapsed(f.id, !open))
    }
    for (const g of groups) setExpanded(g.id, open)
    onClose()
  }

  // The worktrees under the folder that have something to clear.
  const held = new Set(leaves.map((leaf) => leaf.id))
  const busy = useStore((s) =>
    s.worktrees.some(
      (w) => w.status !== 'idle' && (project ? !!w.repoId && held.has(w.repoId) : held.has(w.projectId))
    )
  )
  const clearStatus = (): void => {
    for (const w of useStore.getState().worktrees) {
      const mine = project ? !!w.repoId && held.has(w.repoId) : held.has(w.projectId)
      if (mine && w.status !== 'idle') fireAndForget(window.orbital.clearWorktreeStatus(w.id))
    }
    onClose()
  }

  /** Put the folder before `beforeId` in the list it is already in, or last. */
  const moveTo = (beforeId: string | null): void => {
    if (place) fireAndForget(window.orbital.placeRailFolder(folder.id, place.folderId, beforeId))
    onClose()
  }
  const remove = (): void => {
    fireAndForget(window.orbital.removeRailFolder(folder.id))
    onClose()
  }

  const showOpenClose = inner.length > 0 || groups.length > 0

  return (
    <ContextMenu pos={pos} width={210} onClose={onClose}>
      {step === 'items' && (
        <>
          <MenuItem
            icon={<Pencil size={13} strokeWidth={1.5} />}
            label="Rename"
            onClick={() => {
              setRenamingFolder(folder.id)
              onClose()
            }}
          />
          <MenuItem
            icon={<ListPlus size={13} strokeWidth={1.5} />}
            label="Add Repo…"
            onClick={() => {
              // The same dialog as everywhere else; main files what it adds here.
              openModal('addRepo', { projectId: project?.id, folderId: folder.id })
              onClose()
            }}
          />
          <MenuItem
            icon={<FolderDown size={13} strokeWidth={1.5} />}
            label="Move Here…"
            hint={project ? 'repos' : 'repos, projects'}
            onClick={() => setStep('gather')}
          />
          <MenuItem
            icon={<FolderPlus size={13} strokeWidth={1.5} />}
            label="New Folder Inside"
            onClick={() => {
              // Main opens this folder, so the new one is on screen to be named.
              newRailFolder({ parentId: folder.id })
              onClose()
            }}
          />
          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={<FolderInput size={13} strokeWidth={1.5} />}
            label="Move to Folder"
            onClick={() => setStep('move')}
          />
          {!first && (
            <MenuItem
              icon={<ArrowUpToLine size={13} strokeWidth={1.5} />}
              label="Move to Top"
              onClick={() => moveTo(place?.ids[0] ?? null)}
            />
          )}
          {!last && (
            <MenuItem
              icon={<ArrowDownToLine size={13} strokeWidth={1.5} />}
              label="Move to Bottom"
              onClick={() => moveTo(null)}
            />
          )}
          {(showOpenClose || busy) && <div className="my-1 h-px bg-soft" />}
          {showOpenClose && (
            <MenuItem
              icon={
                allOpen ? <ChevronsDownUp size={13} strokeWidth={1.5} /> : <ChevronsUpDown size={13} strokeWidth={1.5} />
              }
              label={allOpen ? 'Collapse All' : 'Expand All'}
              onClick={() => setAllOpen(!allOpen)}
            />
          )}
          {busy && (
            <MenuItem icon={<CircleOff size={13} strokeWidth={1.5} />} label="Clear Status" onClick={clearStatus} />
          )}
          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={<Trash2 size={13} strokeWidth={1.5} />}
            label="Delete Folder"
            danger
            // An empty folder holds nothing to lose track of, so it just goes.
            onClick={() => (holds ? setStep('confirmDelete') : remove())}
          />
        </>
      )}

      {step === 'gather' && <GatherStep row={row} project={project} />}

      {step === 'move' && <FolderStep name={folder.name} item={{ kind: 'folder', id: folder.id }} onDone={onClose} />}

      {step === 'confirmDelete' && (
        <MenuConfirm
          message={`Delete the folder "${folder.name}"?`}
          hint="Everything in it stays in Orbital, where the folder was. Nothing on disk changes."
          confirmLabel="Delete Folder"
          danger={false}
          onConfirm={remove}
          onCancel={onClose}
        />
      )}
    </ContextMenu>
  )
}
