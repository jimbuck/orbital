import type { DragEvent } from 'react'
import {
  aggregateStatus,
  type Project,
  type Repo,
  type RailFolder,
  type RailItem,
  type TerminalStatus,
  type Worktree
} from '@shared/types'
import { isWindows } from '@renderer/lib/platform'

/**
 * The rail's arrangement: which rows it lists in which order, and what a drag
 * across it would do. Both are plain functions of the store's data so the
 * components stay thin and the rules can be tested without a DOM.
 *
 * The rail nests Folder → Project → Repo → Worktree. A project with one repo
 * and no home repo is FLAT: drawn as that repo's row, exactly as a repo was
 * drawn before projects existed. Anything else is a GROUP: a header (the
 * project's own session) with the home repo's linked worktrees and then the
 * member repos under it.
 */

/* ---- Rows ---------------------------------------------------------------- */

/** A project as the rail lists it. `id` is the PROJECT id for both kinds. */
export type ProjectRow =
  /** One repo, no home: rendered as a plain repo row. */
  | { kind: 'flat'; id: string; project: Project; repo: Repo }
  /**
   * A header with children. `members` excludes `home`, in the project's own
   * order. `open` is `expanded[id] ?? true`: grouping never hides repos that
   * were on screen a moment ago.
   */
  | { kind: 'group'; id: string; project: Project; home: Repo | null; members: Repo[]; open: boolean }

/** One row at the rail's top level: a folder with the projects inside it, or a loose project. */
export type RailRow = { kind: 'folder'; id: string; folder: RailFolder; projects: ProjectRow[] } | ProjectRow

/** Flat iff no home and exactly one repo. A project with no repos at all is a group (its empty state). */
export function isFlat(project: Pick<Project, 'homeRepoId'>, repoCount: number): boolean {
  return project.homeRepoId === null && repoCount === 1
}

/**
 * The rail's top-level rows, in order.
 *
 * `rail` is the order main keeps; a folder's `projectIds` is the order inside
 * it. Both name ids, so an id that no longer names anything is skipped rather
 * than rendered, a filed project listed at the top level too is skipped there,
 * and anything `rail` does not mention (it should mention everything) is
 * still listed, at the end, folders first, rather than lost.
 *
 * A project's repos are its `repoIds` in order, then any repo naming the
 * project that `repoIds` forgot. A repo with no project to resolve is not
 * drawn. The same Project, Repo and RailFolder objects come back out.
 */
export function railRows(
  projects: Project[],
  repos: Repo[],
  folders: RailFolder[],
  rail: RailItem[],
  expanded: Record<string, boolean>
): RailRow[] {
  const repoById = new Map(repos.map((r) => [r.id, r]))
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const folderById = new Map(folders.map((f) => [f.id, f]))
  const filed = new Set(folders.flatMap((f) => f.projectIds))
  const rows: RailRow[] = []
  const listed = new Set<string>()

  const rowFor = (project: Project): ProjectRow => {
    const own = project.repoIds.map((rid) => repoById.get(rid)).filter((r): r is Repo => !!r)
    const seen = new Set(own.map((r) => r.id))
    for (const r of repos) if (r.projectId === project.id && !seen.has(r.id)) own.push(r)
    if (isFlat(project, own.length)) return { kind: 'flat', id: project.id, project, repo: own[0] }
    const home = (project.homeRepoId && own.find((r) => r.id === project.homeRepoId)) || null
    return {
      kind: 'group',
      id: project.id,
      project,
      home,
      members: own.filter((r) => r !== home),
      open: expanded[project.id] ?? true
    }
  }
  const addFolder = (folder: RailFolder): void => {
    listed.add(folder.id)
    const inside = folder.projectIds
      .map((pid) => projectById.get(pid))
      .filter((p): p is Project => !!p)
      .map(rowFor)
    rows.push({ kind: 'folder', id: folder.id, folder, projects: inside })
  }
  const addProject = (project: Project): void => {
    listed.add(project.id)
    rows.push(rowFor(project))
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

/** Every project row, loose or filed, in rail order. */
export function projectRows(rows: RailRow[]): ProjectRow[] {
  return rows.flatMap((r) => (r.kind === 'folder' ? r.projects : [r]))
}

/* ---- Rollups and labels -------------------------------------------------- */

export interface ProjectRollup {
  /** The row's own session: home's root worktree, else the kind:'folder' worktree. Null while main has not made one. */
  session: Worktree | null
  /** Home repo's linked worktrees, in store order. Empty without a home. */
  homeLinked: Worktree[]
  /** aggregateStatus of every worktree in the project except `session`. Drives the chevron. */
  hidden: TerminalStatus
  /** needs_attention count among the same set. Drives the pill, collapsed only. */
  needsYou: number
}

export function projectRollup(project: Project, worktrees: Worktree[]): ProjectRollup {
  const mine = worktrees.filter((w) => w.projectId === project.id)
  const home = project.homeRepoId
  const session =
    (home ? mine.find((w) => w.repoId === home && w.kind === 'root') : mine.find((w) => w.kind === 'folder')) ?? null
  const homeLinked = home ? mine.filter((w) => w.repoId === home && w.kind === 'linked') : []
  const rest = mine.filter((w) => w !== session)
  return {
    session,
    homeLinked,
    hidden: aggregateStatus(rest.map((w) => w.status)),
    needsYou: rest.filter((w) => w.status === 'needs_attention').length
  }
}

/**
 * A repo's path as a member row shows it: `./api` when it is inside the
 * project's root, `.` when it is the root, else the absolute path. Either
 * separator matches, and case does not matter on Windows.
 */
export function repoPathLabel(repoPath: string, rootPath: string, caseInsensitive = isWindows): string {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const repo = norm(repoPath)
  const root = norm(rootPath)
  const same = (a: string, b: string): boolean => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (!root) return repoPath
  if (same(repo, root)) return '.'
  const head = repo.slice(0, root.length + 1)
  if (repo.length > root.length + 1 && same(head, `${root}/`)) return `./${repo.slice(root.length + 1)}`
  return repoPath
}

/* ---- Drag and drop ------------------------------------------------------- */

/** What is being dragged across the rail. */
export type RailDrag =
  | { kind: 'folder'; id: string }
  /** A group's header: moves the whole project. */
  | { kind: 'project'; id: string }
  /** A flat row or a member row, by REPO id. Which of the two it is comes from the rows. */
  | { kind: 'repo'; id: string }

/**
 * What the pointer is over, as far as a drop cares. Several can be set at
 * once: a member repo is over that repo, its project and maybe a folder.
 */
export interface RailOver {
  /** A member repo row (never a flat row). Halves measured on its header. */
  repo: { id: string; lowerHalf: boolean } | null
  /**
   * The project block under the pointer: a flat row or a group. Measured on
   * its header. `zone` is the header's top quarter, middle half or bottom
   * quarter, or 'body' when the pointer is below the header (worktrees,
   * member rows). `lowerHalf` is true for 'body'.
   */
  project: { id: string; lowerHalf: boolean; zone: 'top' | 'middle' | 'bottom' | 'body' } | null
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
  /** Add the dragged repo to this project, after its members. */
  | { kind: 'join'; projectId: string }
  /** Insert the dragged repo before members[index] of this group (length = last). */
  | { kind: 'repoSlot'; projectId: string; index: number }

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
  // The header's parent is a drop zone too; this drag is the header's alone.
  e.stopPropagation()
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
export function folderOf(rows: RailRow[], projectId: string): string | null {
  const row = rows.find((r) => r.kind === 'folder' && r.projects.some((p) => p.id === projectId))
  return row ? row.id : null
}

/** A project's row, wherever it is. */
export function projectRowById(rows: RailRow[], projectId: string): ProjectRow | undefined {
  return projectRows(rows).find((p) => p.id === projectId)
}

/** The project row a repo is drawn in: as the flat row, the home, or a member. */
export function projectRowOfRepo(rows: RailRow[], repoId: string): ProjectRow | undefined {
  return projectRows(rows).find((p) =>
    p.kind === 'flat' ? p.repo.id === repoId : p.home?.id === repoId || p.members.some((m) => m.id === repoId)
  )
}

/**
 * A slot in a list. With `stays` (the id of the row being placed), null when
 * dropping there would leave it where it is: the slots on either side of a
 * row both put it straight back.
 */
function slot(rows: RailRow[], stays: string | null, folderId: string | null, index: number): DropTarget | null {
  if (stays !== null) {
    const from = listIds(rows, folderId)?.indexOf(stays) ?? -1
    if (from !== -1 && (index === from || index === from + 1)) return null
  }
  return { kind: 'slot', folderId, index }
}

/** The slot just before (or after) project `projectId`, in its own list. */
function beside(rows: RailRow[], stays: string | null, projectId: string, after: boolean): DropTarget | null {
  const folderId = folderOf(rows, projectId)
  const i = listIds(rows, folderId)?.indexOf(projectId) ?? -1
  if (i === -1) return null
  return slot(rows, stays, folderId, after ? i + 1 : i)
}

/**
 * Today's folder-header rule for a row being placed among projects: the top
 * edge goes before the folder, the bottom edge after it when the folder shows
 * no rows of its own to drop beside, anything else into it. `into` is null
 * when `stays` is already in that folder.
 */
function overFolder(
  rows: RailRow[],
  stays: string | null,
  folder: NonNullable<RailOver['folder']>,
  intoAlways: boolean,
  placing: string
): DropTarget | null {
  const row = rows.find((r) => r.kind === 'folder' && r.id === folder.id)
  if (row?.kind !== 'folder') return null
  const i = rows.indexOf(row)
  if (folder.edge === 'top') return slot(rows, stays, null, i)
  // An open folder with projects in it has its own rows just below the
  // header, and those are where "first in the folder" is dropped. Without
  // them the bottom edge is free to mean "after the folder".
  const showsProjects = !row.folder.collapsed && row.projects.length > 0
  if (folder.edge === 'bottom' && !showsProjects) return slot(rows, stays, null, i + 1)
  if (!intoAlways && folderOf(rows, placing) === row.id) return null
  return { kind: 'into', folderId: row.id }
}

/**
 * What dropping `drag` would do with the pointer over `over`. Null means the
 * drop would change nothing, so the rail shows no target and refuses it.
 *
 * - A folder only ever moves along the top level: beside the row it is over,
 *   a folder's projects counting as that folder.
 * - A project (a group's header) goes beside whichever project it is over, in
 *   that project's own list, or into a folder from its header. Projects never
 *   nest and never merge by drag.
 * - A repo joins or reorders inside a project when dropped on a member row or
 *   the middle of a project's header; anywhere else it is placed like a
 *   project, which for a flat row moves its project and for a member row
 *   detaches it into a project of its own at that place.
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

  if (drag.kind === 'project') {
    if (!projectRowById(rows, drag.id)) return null
    if (over.project) {
      if (over.project.id === drag.id) return null
      return beside(rows, drag.id, over.project.id, over.project.lowerHalf)
    }
    if (over.folder) return overFolder(rows, drag.id, over.folder, false, drag.id)
    return slot(rows, drag.id, null, top.length)
  }

  // A repo. S is its own project row.
  const source = projectRowOfRepo(rows, drag.id)
  if (!source) return null
  const flat = source.kind === 'flat'
  // A flat row is placed as its project, so a slot beside itself is a no-op.
  // A member placed anywhere detaches, so for it no slot is.
  const stays = flat ? source.id : null

  if (over.repo) {
    if (over.repo.id === drag.id) return null
    const group = projectRows(rows).find(
      (p): p is Extract<ProjectRow, { kind: 'group' }> =>
        p.kind === 'group' && p.members.some((m) => m.id === over.repo?.id)
    )
    if (group) {
      const i = group.members.findIndex((m) => m.id === over.repo?.id)
      const index = over.repo.lowerHalf ? i + 1 : i
      if (group.id === source.id) {
        const own = group.members.findIndex((m) => m.id === drag.id)
        if (index === own || index === own + 1) return null
      }
      return { kind: 'repoSlot', projectId: group.id, index }
    }
  }

  if (over.project) {
    const target = projectRowById(rows, over.project.id)
    if (!target) return null
    const zone = over.project.zone
    if (target.id === source.id) {
      if (flat) return null
      // A member dragged up out of its own project lands just above it.
      return zone === 'top' ? beside(rows, null, source.id, false) : null
    }
    if (zone === 'top') return beside(rows, stays, target.id, false)
    if (zone === 'middle') return { kind: 'join', projectId: target.id }
    if (zone === 'bottom') {
      const showsMembers = target.kind === 'group' && target.open && target.members.length > 0
      return showsMembers ? { kind: 'join', projectId: target.id } : beside(rows, stays, target.id, true)
    }
    // Body: inside a group is inside the project; under a flat row it is
    // over that repo's worktrees, which is "after it".
    return target.kind === 'group' ? { kind: 'join', projectId: target.id } : beside(rows, stays, target.id, true)
  }

  if (over.folder) return overFolder(rows, stays, over.folder, !flat, source.id)
  return slot(rows, stays, null, top.length)
}

/**
 * The id a drop on `target` is placed before, in the terms main takes: the row
 * currently at the slot (or, for a repo slot, the member there), or null for
 * the end of the list (which is also where a project dropped into a folder,
 * or a repo joining a project, goes).
 */
export function beforeIdAt(rows: RailRow[], target: DropTarget): string | null {
  if (target.kind === 'into' || target.kind === 'join') return null
  if (target.kind === 'repoSlot') {
    const row = projectRowById(rows, target.projectId)
    return row?.kind === 'group' ? (row.members[target.index]?.id ?? null) : null
  }
  return listIds(rows, target.folderId)?.[target.index] ?? null
}

export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b
  switch (a.kind) {
    case 'into':
      return b.kind === 'into' && a.folderId === b.folderId
    case 'slot':
      return b.kind === 'slot' && a.folderId === b.folderId && a.index === b.index
    case 'join':
      return b.kind === 'join' && a.projectId === b.projectId
    case 'repoSlot':
      return b.kind === 'repoSlot' && a.projectId === b.projectId && a.index === b.index
  }
}

/* ---- What a drop does ---------------------------------------------------- */

export type RailAction =
  | { op: 'placeRailFolder'; folderId: string; beforeId: string | null }
  | { op: 'placeProject'; projectId: string; folderId: string | null; beforeId: string | null }
  | { op: 'detachRepo'; repoId: string; folderId: string | null; beforeId: string | null; dissolves: string | null }
  | {
      op: 'addRepoToProject'
      projectId: string
      repoId: string
      beforeRepoId: string | null
      /** The target was flat: it becomes a group, and the rail opens its new header in rename. */
      forms: boolean
      /** The source group is left with one repo and no home, so its folder session closes. Its project id, else null. */
      dissolves: string | null
    }

/**
 * Whether taking `repoId` out of `source` leaves it a plain repo row: a group
 * with no home and two repos is down to one. Its project id, else null.
 */
export function dissolvesOnLeave(source: ProjectRow | undefined): string | null {
  return source?.kind === 'group' && source.home === null && source.members.length === 2 ? source.id : null
}

/** The main call a drop of `drag` on `target` comes down to, or null for one that means nothing. */
export function dropAction(drag: RailDrag, rows: RailRow[], target: DropTarget): RailAction | null {
  const beforeId = beforeIdAt(rows, target)
  if (drag.kind === 'folder') {
    return target.kind === 'slot' ? { op: 'placeRailFolder', folderId: drag.id, beforeId } : null
  }
  if (drag.kind === 'project') {
    if (target.kind !== 'into' && target.kind !== 'slot') return null
    return { op: 'placeProject', projectId: drag.id, folderId: target.folderId, beforeId }
  }

  const source = projectRowOfRepo(rows, drag.id)
  if (!source) return null
  if (target.kind === 'into' || target.kind === 'slot') {
    if (source.kind === 'flat') return { op: 'placeProject', projectId: source.id, folderId: target.folderId, beforeId }
    return {
      op: 'detachRepo',
      repoId: drag.id,
      folderId: target.folderId,
      beforeId,
      dissolves: dissolvesOnLeave(source)
    }
  }
  const into = projectRowById(rows, target.projectId)
  if (!into) return null
  return {
    op: 'addRepoToProject',
    projectId: into.id,
    repoId: drag.id,
    beforeRepoId: beforeId,
    forms: into.kind === 'flat',
    dissolves: into.id === source.id ? null : dissolvesOnLeave(source)
  }
}
