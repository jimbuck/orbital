import type { DragEvent } from 'react'
import type { Project, ProjectFolder, RailItem } from '@shared/types'

/**
 * The rail's arrangement: which rows it lists in which order, and what a drag
 * across it would do. Both are plain functions of the store's data so the
 * components stay thin and the rules can be tested without a DOM.
 */

/* ---- Rows ---------------------------------------------------------------- */

/** One row at the rail's top level: a folder with the projects inside it, or a loose project. */
export type RailRow =
  | { kind: 'folder'; id: string; folder: ProjectFolder; projects: Project[] }
  | { kind: 'project'; id: string; project: Project }

/**
 * The rail's top-level rows, in order.
 *
 * `rail` is the order main keeps; a folder's `projectIds` is the order inside
 * it. Both name ids, so an id that no longer names anything is skipped rather
 * than rendered, and anything `rail` does not mention (it should mention
 * everything) is still listed, at the end, rather than lost.
 */
export function railRows(projects: Project[], folders: ProjectFolder[], rail: RailItem[]): RailRow[] {
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const folderById = new Map(folders.map((f) => [f.id, f]))
  const filed = new Set(folders.flatMap((f) => f.projectIds))
  const rows: RailRow[] = []
  const listed = new Set<string>()

  const addFolder = (folder: ProjectFolder): void => {
    listed.add(folder.id)
    const inside = folder.projectIds.map((pid) => projectById.get(pid)).filter((p): p is Project => !!p)
    rows.push({ kind: 'folder', id: folder.id, folder, projects: inside })
  }
  const addProject = (project: Project): void => {
    listed.add(project.id)
    rows.push({ kind: 'project', id: project.id, project })
  }

  for (const item of rail) {
    if (listed.has(item.id)) continue
    if (item.kind === 'folder') {
      const folder = folderById.get(item.id)
      if (folder) addFolder(folder)
    } else {
      const project = projectById.get(item.id)
      if (project && !filed.has(project.id)) addProject(project)
    }
  }
  for (const folder of folders) if (!listed.has(folder.id)) addFolder(folder)
  for (const project of projects) if (!listed.has(project.id) && !filed.has(project.id)) addProject(project)
  return rows
}

/* ---- Drag and drop ------------------------------------------------------- */

/** What is being dragged across the rail. */
export type RailDrag = { kind: 'project'; id: string } | { kind: 'folder'; id: string }

/**
 * What the pointer is over, as far as a drop cares. Both can be set at once: a
 * project inside a folder is over that project and over that folder.
 */
export interface RailOver {
  /** The project under the pointer, and whether the pointer is below the middle of its header. */
  project: { id: string; lowerHalf: boolean } | null
  /**
   * The folder under the pointer. `lowerHalf` is measured on its header the
   * same way. `edge` is set while the pointer is in the top or bottom quarter
   * of that header, which is where a project is slipped in beside the folder
   * instead of into it.
   */
  folder: { id: string; lowerHalf: boolean; edge: 'top' | 'bottom' | null } | null
}

/** Where a drag would land if it were dropped now. */
export type DropTarget =
  /** File the dragged project in this folder, after the projects already there. */
  | { kind: 'into'; folderId: string }
  /**
   * Insert before the row at `index` of a list: a folder's projects, or the
   * top level when `folderId` is null. `index` equal to the list's length is
   * the end.
   */
  | { kind: 'slot'; folderId: string | null; index: number }

const RAIL_DND = 'application/x-orbital-rail'

/**
 * The drag in flight, or null. Held here rather than read back from the event
 * because a drag's data is unreadable until the drop, and the rail has to know
 * what is being dragged while it is still hovering to decide whether a drop
 * would do anything. It also means a drag that started in another window (a
 * second workspace) is simply not a rail drag here, since its ids belong to a
 * different workspace.
 */
let current: RailDrag | null = null

export function beginRailDrag(e: DragEvent, drag: RailDrag): void {
  current = drag
  // A private type, not text/plain: dropped on a terminal or an editor this
  // must not paste anything.
  e.dataTransfer.setData(RAIL_DND, drag.id)
  e.dataTransfer.effectAllowed = 'move'
}

export function endRailDrag(): void {
  current = null
}

export function currentRailDrag(): RailDrag | null {
  return current
}

/** The ids of one list a slot can point into: a folder's projects, or the top level. */
function listIds(rows: RailRow[], folderId: string | null): string[] | null {
  if (folderId === null) return rows.map((r) => r.id)
  const row = rows.find((r) => r.kind === 'folder' && r.id === folderId)
  return row?.kind === 'folder' ? row.projects.map((p) => p.id) : null
}

/** The folder a project is filed in, or null for a loose one. */
function folderOf(rows: RailRow[], projectId: string): string | null {
  const row = rows.find((r) => r.kind === 'folder' && r.projects.some((p) => p.id === projectId))
  return row ? row.id : null
}

/**
 * A slot in a list, or null when dropping `dragId` there would leave it where
 * it is: the slots on either side of a row both put it straight back.
 */
function slot(rows: RailRow[], dragId: string, folderId: string | null, index: number): DropTarget | null {
  const from = listIds(rows, folderId)?.indexOf(dragId) ?? -1
  if (from !== -1 && (index === from || index === from + 1)) return null
  return { kind: 'slot', folderId, index }
}

/**
 * What dropping `drag` would do with the pointer over `over`. Null means the
 * drop would change nothing, so the rail shows no target and refuses it.
 *
 * A project goes beside whichever project it is over (above it from the upper
 * half of its header, below it otherwise), in that project's own list, so the
 * same gesture reorders inside a folder, reorders the top level, and moves a
 * project between the two. Over a folder's header it goes into the folder,
 * except at the header's top edge (before the folder) and, when the folder
 * shows no projects of its own to drop beside, its bottom edge (after it).
 * Over empty rail it goes last.
 *
 * A folder only ever moves along the top level: beside the row it is over,
 * with a folder's projects counting as that folder.
 */
export function dropTargetFor(drag: RailDrag, rows: RailRow[], over: RailOver): DropTarget | null {
  const top = rows.map((r) => r.id)

  if (drag.kind === 'folder') {
    if (!top.includes(drag.id)) return null
    const onRow = over.folder ?? over.project
    if (!onRow) return slot(rows, drag.id, null, top.length)
    const i = top.indexOf(onRow.id)
    if (i === -1 || onRow.id === drag.id) return null
    return slot(rows, drag.id, null, onRow.lowerHalf ? i + 1 : i)
  }

  if (over.project) {
    if (over.project.id === drag.id) return null
    const folderId = folderOf(rows, over.project.id)
    const i = listIds(rows, folderId)?.indexOf(over.project.id) ?? -1
    if (i === -1) return null
    return slot(rows, drag.id, folderId, over.project.lowerHalf ? i + 1 : i)
  }

  if (over.folder) {
    const row = rows.find((r) => r.kind === 'folder' && r.id === over.folder?.id)
    if (row?.kind !== 'folder') return null
    const i = top.indexOf(row.id)
    if (over.folder.edge === 'top') return slot(rows, drag.id, null, i)
    // An open folder with projects in it has its own rows just below the
    // header, and those are where "first in the folder" is dropped. Without
    // them the bottom edge is free to mean "after the folder".
    const showsProjects = !row.folder.collapsed && row.projects.length > 0
    if (over.folder.edge === 'bottom' && !showsProjects) return slot(rows, drag.id, null, i + 1)
    return folderOf(rows, drag.id) === row.id ? null : { kind: 'into', folderId: row.id }
  }

  return slot(rows, drag.id, null, top.length)
}

/**
 * The id a drop on `target` is placed before, in the terms main takes: the row
 * currently at the slot, or null for the end of the list (which is also where
 * a project dropped into a folder goes).
 */
export function beforeIdAt(rows: RailRow[], target: DropTarget): string | null {
  if (target.kind === 'into') return null
  return listIds(rows, target.folderId)?.[target.index] ?? null
}

export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'into') return b.kind === 'into' && a.folderId === b.folderId
  return b.kind === 'slot' && a.folderId === b.folderId && a.index === b.index
}
