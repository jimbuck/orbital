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
 * The rail nests Folder → Project → Folder → Repo → Worktree, and a folder of
 * either kind can hold more folders of its kind. A project with one repo and
 * no home repo is FLAT: drawn as that repo's row, exactly as a repo was drawn
 * before projects existed. Anything else is a GROUP: a header (the project's
 * own session) with the home repo's linked worktrees and then the member
 * repos under it, loose or in the project's own folders.
 */

/* ---- Rows ---------------------------------------------------------------- */

/** A folder as the rail lists it, with the rows inside it: `T`s and more folders. */
export interface FolderRow<T> {
  kind: 'folder'
  id: string
  folder: RailFolder
  items: Array<T | FolderRow<T>>
}

/** One of a group's repos, as a row under its header. `id` is the repo's. */
export interface RepoRow {
  kind: 'repo'
  id: string
  repo: Repo
}

/** One row of a group's list: a member repo, or a folder of them. */
export type MemberRow = RepoRow | FolderRow<RepoRow>

/** A project as the rail lists it. `id` is the PROJECT id for both kinds. */
export type ProjectRow =
  /** One repo, no home: rendered as a plain repo row. */
  | { kind: 'flat'; id: string; project: Project; repo: Repo }
  /**
   * A header with children. `members` is every repo but `home`, in the order
   * the rail reads top to bottom; `items` is the same repos as the rail
   * arranges them, with the project's folders. `open` is
   * `expanded[id] ?? true`: grouping never hides repos that were on screen a
   * moment ago.
   */
  | {
      kind: 'group'
      id: string
      project: Project
      home: Repo | null
      members: Repo[]
      items: MemberRow[]
      open: boolean
    }

/** One row of the rail's own lists: a project, or a folder of them. */
export type RailRow = ProjectRow | FolderRow<ProjectRow>

/** Flat iff no home and exactly one repo. A project with no repos at all is a group (its empty state). */
export function isFlat(project: Pick<Project, 'homeRepoId'>, repoCount: number): boolean {
  return project.homeRepoId === null && repoCount === 1
}

/**
 * One kind of list, drawn as rows: `top` in order, each folder with what is
 * filed in it, and so on down.
 *
 * Everything names ids, so the rules for ids that have gone stale are here:
 * one that names nothing (or a row of the other kind) is skipped, a row is
 * listed once (in a folder rather than at the top, when both name it), and
 * whatever nothing mentions is still listed, at the end, folders first.
 * `leaves` is the rows other than folders, by id, in the order to fall back on.
 */
function arrange<T extends { id: string }>(
  top: RailItem[],
  folders: RailFolder[],
  leafKind: 'project' | 'repo',
  leaves: Map<string, T>
): Array<T | FolderRow<T>> {
  const folderById = new Map(folders.map((f) => [f.id, f]))
  const filed = new Set(folders.flatMap((f) => f.items.map((item) => item.id)))
  const listed = new Set<string>()

  const folderRow = (folder: RailFolder): FolderRow<T> => {
    // Before its rows are read, so a folder that names itself further down
    // is not listed again.
    listed.add(folder.id)
    return { kind: 'folder', id: folder.id, folder, items: rowsOf(folder.items, false) }
  }
  const rowsOf = (items: RailItem[], atTop: boolean): Array<T | FolderRow<T>> => {
    const out: Array<T | FolderRow<T>> = []
    for (const item of items) {
      if (listed.has(item.id) || (atTop && filed.has(item.id))) continue
      if (item.kind === 'folder') {
        const folder = folderById.get(item.id)
        if (folder) out.push(folderRow(folder))
      } else if (item.kind === leafKind) {
        const leaf = leaves.get(item.id)
        if (!leaf) continue
        listed.add(item.id)
        out.push(leaf)
      }
    }
    return out
  }

  const rows = rowsOf(top, true)
  // A folder filed in one the walk never reached is left for that one to list.
  for (const folder of folders) if (!listed.has(folder.id) && !filed.has(folder.id)) rows.push(folderRow(folder))
  for (const folder of folders) if (!listed.has(folder.id)) rows.push(folderRow(folder))
  for (const [id, leaf] of leaves) if (!listed.has(id)) rows.push(leaf)
  return rows
}

/** The rows of a list that are not folders, read top to bottom through its folders. */
export function leafRows<T extends { kind: string }>(items: Array<T | FolderRow<T>>): T[] {
  return items.flatMap((item) => (item.kind === 'folder' ? leafRows((item as FolderRow<T>).items) : [item as T]))
}

/**
 * The rail's rows, in order.
 *
 * `rail` is the order main keeps for the top level, a folder's `items` the
 * order inside it, and `projectItems[id]` the top of a project's own list
 * when it has folders. All of them name ids; see {@link arrange} for what
 * happens to one that has gone stale.
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
  expanded: Record<string, boolean>,
  projectItems: Record<string, RailItem[]> = {}
): RailRow[] {
  const repoById = new Map(repos.map((r) => [r.id, r]))
  const foldersByProject = new Map<string | null, RailFolder[]>()
  for (const folder of folders) {
    const key = folder.projectId ?? null
    const list = foldersByProject.get(key)
    if (list) list.push(folder)
    else foldersByProject.set(key, [folder])
  }

  const rowFor = (project: Project): ProjectRow => {
    const own = project.repoIds.map((rid) => repoById.get(rid)).filter((r): r is Repo => !!r)
    const seen = new Set(own.map((r) => r.id))
    for (const r of repos) if (r.projectId === project.id && !seen.has(r.id)) own.push(r)
    if (isFlat(project, own.length)) return { kind: 'flat', id: project.id, project, repo: own[0] }
    const home = (project.homeRepoId && own.find((r) => r.id === project.homeRepoId)) || null
    // The home is the header, never a row: wherever the arrangement files it, it is not drawn there.
    const rest = own.filter((r) => r !== home)
    const items = arrange<RepoRow>(
      projectItems[project.id] ?? [],
      foldersByProject.get(project.id) ?? [],
      'repo',
      new Map(rest.map((repo) => [repo.id, { kind: 'repo', id: repo.id, repo }]))
    )
    return {
      kind: 'group',
      id: project.id,
      project,
      home,
      members: leafRows(items).map((row) => row.repo),
      items,
      open: expanded[project.id] ?? true
    }
  }

  return arrange<ProjectRow>(
    rail,
    foldersByProject.get(null) ?? [],
    'project',
    new Map(projects.map((project) => [project.id, rowFor(project)]))
  )
}

/* ---- Finding rows --------------------------------------------------------- */

/** The key of a list the rail orders: the top level, a folder's rows, or the top of a project's repos. */
const RAIL = 'rail'
const inFolder = (folderId: string): string => `f:${folderId}`
const inProject = (projectId: string): string => `p:${projectId}`
const folderOfKey = (key: string): string | null => (key.startsWith('f:') ? key.slice(2) : null)

/** Where a row sits: which list, and how far down it. */
interface Place {
  list: string
  index: number
}

interface FolderEntry {
  row: FolderRow<ProjectRow> | FolderRow<RepoRow>
  /** The project whose repos it arranges, or null for a folder of projects. */
  projectId: string | null
  /** How many folders it is inside. */
  depth: number
  place: Place
}

interface RailIndex {
  /** Each list's row ids, by key. */
  lists: Map<string, string[]>
  folders: Map<string, FolderEntry>
  projects: Map<string, { row: ProjectRow; place: Place }>
  /** Member rows only: a flat row is placed as its project, and a home is a header. */
  repos: Map<string, { projectId: string; place: Place }>
  /** Every repo the rail draws, to the project row it is drawn in: as the flat row, the home, or a member. */
  owner: Map<string, ProjectRow>
}

const indexes = new WeakMap<RailRow[], RailIndex>()

/** Everything in `rows` by id. Built once per rows array, which the Rail memoizes. */
function indexOf(rows: RailRow[]): RailIndex {
  const cached = indexes.get(rows)
  if (cached) return cached
  const ix: RailIndex = { lists: new Map(), folders: new Map(), projects: new Map(), repos: new Map(), owner: new Map() }

  const members = (items: MemberRow[], list: string, projectId: string, depth: number): void => {
    ix.lists.set(
      list,
      items.map((item) => item.id)
    )
    items.forEach((item, index) => {
      if (item.kind === 'folder') {
        ix.folders.set(item.id, { row: item, projectId, depth, place: { list, index } })
        members(item.items, inFolder(item.id), projectId, depth + 1)
      } else {
        ix.repos.set(item.id, { projectId, place: { list, index } })
      }
    })
  }
  const walk = (items: RailRow[], list: string, depth: number): void => {
    ix.lists.set(
      list,
      items.map((item) => item.id)
    )
    items.forEach((row, index) => {
      if (row.kind === 'folder') {
        ix.folders.set(row.id, { row, projectId: null, depth, place: { list, index } })
        walk(row.items, inFolder(row.id), depth + 1)
        return
      }
      ix.projects.set(row.id, { row, place: { list, index } })
      if (row.kind === 'flat') {
        ix.owner.set(row.repo.id, row)
        return
      }
      if (row.home) ix.owner.set(row.home.id, row)
      for (const repo of row.members) ix.owner.set(repo.id, row)
      members(row.items, inProject(row.id), row.id, 0)
    })
  }
  walk(rows, RAIL, 0)
  indexes.set(rows, ix)
  return ix
}

/** Whether folder `folderId` is `ancestorId` or somewhere inside it. */
function isUnder(ix: RailIndex, folderId: string, ancestorId: string): boolean {
  let at: string | null = folderId
  // Bounded by the folder count, though rows never loop: arrange lists each folder once.
  for (let steps = 0; at !== null && steps <= ix.folders.size; steps++) {
    if (at === ancestorId) return true
    const entry = ix.folders.get(at)
    at = entry ? folderOfKey(entry.place.list) : null
  }
  return false
}

/** Every project row, loose or filed, in rail order. */
export function projectRows(rows: RailRow[]): ProjectRow[] {
  return [...indexOf(rows).projects.values()].map((p) => p.row)
}

/** The folder a project is filed in, or null for one at the top level. */
export function folderOf(rows: RailRow[], projectId: string): string | null {
  const entry = indexOf(rows).projects.get(projectId)
  return entry ? folderOfKey(entry.place.list) : null
}

/** A project's row, wherever it is. */
export function projectRowById(rows: RailRow[], projectId: string): ProjectRow | undefined {
  return indexOf(rows).projects.get(projectId)?.row
}

/** The project row a repo is drawn in: as the flat row, the home, or a member. */
export function projectRowOfRepo(rows: RailRow[], repoId: string): ProjectRow | undefined {
  return indexOf(rows).owner.get(repoId)
}

/** A row's place, in the terms main takes: the folder it is in, and the rows of the list it shares. */
export interface RowPlace {
  /** The folder it is directly in, or null at the top of the rail or of its project's repos. */
  folderId: string | null
  /** That list's row ids, in order, and where the row is among them. */
  ids: string[]
  index: number
}

/** Where a folder, a project's row or a member repo's row sits. Null for a row the rail does not draw. */
export function placeOf(rows: RailRow[], kind: 'folder' | 'project' | 'repo', id: string): RowPlace | null {
  const ix = indexOf(rows)
  const place = (kind === 'folder' ? ix.folders : kind === 'project' ? ix.projects : ix.repos).get(id)?.place
  if (!place) return null
  return { folderId: folderOfKey(place.list), ids: ix.lists.get(place.list) ?? [], index: place.index }
}

/**
 * The folders of one kind, in the order the rail lists them, each with how
 * deep it is nested: a project's own (`projectId`), or the folders of
 * projects (null).
 */
export function foldersIn(rows: RailRow[], projectId: string | null): Array<{ folder: RailFolder; depth: number }> {
  return [...indexOf(rows).folders.values()]
    .filter((f) => f.projectId === projectId)
    .map((f) => ({ folder: f.row.folder, depth: f.depth }))
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
  /** A folder of either kind, with everything in it. */
  | { kind: 'folder'; id: string }
  /** A group's header: moves the whole project. */
  | { kind: 'project'; id: string }
  /** A flat row or a member row, by REPO id. Which of the two it is comes from the rows. */
  | { kind: 'repo'; id: string }

/**
 * Where on a block the pointer is, measured on its header row: the header's
 * top quarter, middle half or bottom quarter, or `body` when the pointer is
 * inside the block but below its header (on or between the rows it holds).
 */
export type OverZone = 'top' | 'middle' | 'bottom' | 'body'

/**
 * What the pointer is over, as far as a drop cares: the innermost of each
 * kind of block. Several can be set at once, since blocks nest: a member repo
 * is over that repo, maybe one of its project's folders, its project, and
 * maybe a folder the project is filed in. `folder` is whichever folder is
 * innermost, of either kind; the rows say which kind it is.
 */
export interface RailOver {
  /** A member repo row (never a flat row). Halves measured on its header. */
  repo: { id: string; lowerHalf: boolean } | null
  /** The project block under the pointer: a flat row or a group. `lowerHalf` is true for 'body'. */
  project: { id: string; lowerHalf: boolean; zone: OverZone } | null
  /** The innermost folder under the pointer. */
  folder: { id: string; zone: OverZone } | null
}

/** Where a drag would land if it were dropped now. */
export type DropTarget =
  /** File the dragged row in this folder, after the rows already there. */
  | { kind: 'into'; folderId: string }
  /**
   * Insert before the row at `index` of a list: a folder's rows (either kind
   * of folder), or the rail's top level when `folderId` is null. `index`
   * equal to the list's length is the end.
   */
  | { kind: 'slot'; folderId: string | null; index: number }
  /** Add the dragged repo to this project, after the rows at the top of its list. */
  | { kind: 'join'; projectId: string }
  /** Insert before `items[index]` at the top of this group's list (length = last). */
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

/** The slot before row `index` of a list, as a target. */
function slotAt(list: string, index: number): DropTarget {
  if (list === RAIL) return { kind: 'slot', folderId: null, index }
  const folderId = folderOfKey(list)
  return folderId !== null ? { kind: 'slot', folderId, index } : { kind: 'repoSlot', projectId: list.slice(2), index }
}

/** The list a slot target points into. */
function listOfSlot(target: Extract<DropTarget, { kind: 'slot' | 'repoSlot' }>): string {
  if (target.kind === 'repoSlot') return inProject(target.projectId)
  return target.folderId === null ? RAIL : inFolder(target.folderId)
}

/**
 * A slot in a list. `stays` is where the row being placed already is, when it
 * is a row of this kind of list at all; the slots on either side of it both
 * put it straight back, so they are no target (null).
 */
function slot(stays: Place | null, list: string, index: number): DropTarget | null {
  if (stays && stays.list === list && (index === stays.index || index === stays.index + 1)) return null
  return slotAt(list, index)
}

/** The slot just before (or after) the row at `place`, in its own list. */
function beside(stays: Place | null, place: Place, after: boolean): DropTarget | null {
  return slot(stays, place.list, after ? place.index + 1 : place.index)
}

/** The slot after the last row of a list. */
function atEnd(ix: RailIndex, stays: Place | null, list: string): DropTarget | null {
  return slot(stays, list, ix.lists.get(list)?.length ?? 0)
}

/**
 * The rule for a row that may go into the folder it is over. The header's top
 * edge goes before the folder; its bottom edge goes after it when the folder
 * shows no rows of its own to drop beside; anywhere else goes into it, last.
 *
 * A row already directly in the folder is sent to the end of it from the
 * header, which is how a row gets below an open folder that is last in its
 * list. Over the folder's body (the gaps between its rows) such a row stays
 * where it is. `intoAlways` is for a row that is never "already there": a
 * member repo leaving its project.
 */
function overFolder(
  ix: RailIndex,
  stays: Place | null,
  zone: OverZone,
  folder: FolderEntry,
  intoAlways = false
): DropTarget | null {
  if (zone === 'top') return beside(stays, folder.place, false)
  const showsRows = !folder.row.folder.collapsed && folder.row.items.length > 0
  if (zone === 'bottom' && !showsRows) return beside(stays, folder.place, true)
  const list = inFolder(folder.row.id)
  if (!intoAlways && stays?.list === list) return zone === 'body' ? null : atEnd(ix, stays, list)
  return { kind: 'into', folderId: folder.row.id }
}

/**
 * A folder being dragged. It stays among its own kind: a folder of projects
 * moves through the rail's lists, a folder of repos through its own
 * project's, and neither goes inside itself.
 */
function folderTarget(ix: RailIndex, dragId: string, over: RailOver): DropTarget | null {
  const me = ix.folders.get(dragId)
  if (!me) return null
  const stays = me.place
  // A target inside the dragged folder would put it in itself.
  const outside = (target: DropTarget | null): DropTarget | null => {
    if (!target || target.kind === 'join') return target
    const into = target.kind === 'into' ? target.folderId : folderOfKey(listOfSlot(target))
    return into !== null && isUnder(ix, into, dragId) ? null : target
  }
  const overEntry = over.folder ? ix.folders.get(over.folder.id) : undefined

  if (me.projectId === null) {
    // Among projects: beside whichever project it is over, in that project's list.
    if (over.project) {
      const project = ix.projects.get(over.project.id)
      return project ? outside(beside(stays, project.place, over.project.lowerHalf)) : null
    }
    if (over.folder) {
      if (!overEntry || overEntry.projectId !== null || overEntry.row.id === dragId) return null
      return outside(overFolder(ix, stays, over.folder.zone, overEntry))
    }
    return atEnd(ix, stays, RAIL)
  }

  // Among one project's repos.
  if (over.repo) {
    const repo = ix.repos.get(over.repo.id)
    if (!repo || repo.projectId !== me.projectId) return null
    return outside(beside(stays, repo.place, over.repo.lowerHalf))
  }
  if (over.folder && overEntry && overEntry.projectId !== null) {
    if (overEntry.projectId !== me.projectId || overEntry.row.id === dragId) return null
    return outside(overFolder(ix, stays, over.folder.zone, overEntry))
  }
  if (over.project?.id !== me.projectId) return null
  // Its project's header sends it to the end of the project's own list.
  const top = inProject(me.projectId)
  if (over.project.zone === 'top' || (over.project.zone === 'body' && stays.list === top)) return null
  return atEnd(ix, stays, top)
}

/**
 * A project (a group's header) being dragged: beside whichever project it is
 * over, in that project's own list, or into a folder of projects from its
 * header. Projects never nest and never merge by drag, and a project's own
 * folders are part of that project as far as this drag cares.
 */
function projectTarget(ix: RailIndex, dragId: string, over: RailOver): DropTarget | null {
  const me = ix.projects.get(dragId)
  if (!me) return null
  if (over.project) {
    if (over.project.id === dragId) return null
    const project = ix.projects.get(over.project.id)
    return project ? beside(me.place, project.place, over.project.lowerHalf) : null
  }
  if (over.folder) {
    const folder = ix.folders.get(over.folder.id)
    return folder && folder.projectId === null ? overFolder(ix, me.place, over.folder.zone, folder) : null
  }
  return atEnd(ix, me.place, RAIL)
}

/**
 * A repo being dragged. Over a member row, one of a project's folders or the
 * middle of a project's header it is placed inside that project (joining it,
 * from outside). Anywhere else it is placed like a project, which for a flat
 * row moves its project and for a member row detaches it into a project of
 * its own at that place.
 */
function repoTarget(ix: RailIndex, dragId: string, over: RailOver): DropTarget | null {
  const source = ix.owner.get(dragId)
  if (!source) return null
  const flat = source.kind === 'flat'
  const member = ix.repos.get(dragId)
  // A home repo is its project's header, which drags as the project.
  if (!flat && !member) return null
  // Where the row being placed already is, by kind of list. In a project's
  // lists that is the member row. In the rail's it is a flat row's project; a
  // member placed there always detaches, so no slot leaves it where it is.
  const asMember = member?.place ?? null
  const asProject = flat ? (ix.projects.get(source.id)?.place ?? null) : null

  if (over.repo) {
    if (over.repo.id === dragId) return null
    const repo = ix.repos.get(over.repo.id)
    if (repo) return beside(asMember, repo.place, over.repo.lowerHalf)
  }

  const folder = over.folder ? ix.folders.get(over.folder.id) : undefined
  // One of a project's own folders is inside that project's block, so it is
  // nearer the pointer than the project is.
  if (over.folder && folder && folder.projectId !== null) return overFolder(ix, asMember, over.folder.zone, folder)

  if (over.project) {
    const target = ix.projects.get(over.project.id)
    if (!target) return null
    const zone = over.project.zone
    if (target.row.id === source.id) {
      if (!member) return null
      // Dragged up out of its own project, it lands just above it.
      if (zone === 'top') return beside(null, target.place, false)
      // The header sends it to the end of the project's own list (out of any
      // folder); between the rows of that list it stays where it is.
      const top = inProject(source.id)
      if (zone === 'body' && member.place.list === top) return null
      return atEnd(ix, member.place, top)
    }
    const join: DropTarget = { kind: 'join', projectId: target.row.id }
    if (zone === 'top') return beside(asProject, target.place, false)
    if (zone === 'middle') return join
    const group = target.row.kind === 'group' ? target.row : null
    if (zone === 'bottom') {
      const showsRows = !!group && group.open && group.items.length > 0
      return showsRows ? join : beside(asProject, target.place, true)
    }
    // Body: inside a group is inside the project; under a flat row it is
    // over that repo's worktrees, which is "after it".
    return group ? join : beside(asProject, target.place, true)
  }

  if (over.folder) return folder ? overFolder(ix, asProject, over.folder.zone, folder, !flat) : null
  return atEnd(ix, asProject, RAIL)
}

/**
 * What dropping `drag` would do with the pointer over `over`. Null means the
 * drop would change nothing (or is not allowed), so the rail shows no target
 * and refuses it. See {@link folderTarget}, {@link projectTarget} and
 * {@link repoTarget} for each kind of drag.
 */
export function dropTargetFor(drag: RailDrag, rows: RailRow[], over: RailOver): DropTarget | null {
  const ix = indexOf(rows)
  if (drag.kind === 'folder') return folderTarget(ix, drag.id, over)
  if (drag.kind === 'project') return projectTarget(ix, drag.id, over)
  return repoTarget(ix, drag.id, over)
}

/**
 * The id a drop on `target` is placed before, in the terms main takes: the row
 * currently at the slot, or null for the end of the list (which is also where
 * a row dropped into a folder, or a repo joining a project, goes).
 */
export function beforeIdAt(rows: RailRow[], target: DropTarget): string | null {
  if (target.kind === 'into' || target.kind === 'join') return null
  return indexOf(rows).lists.get(listOfSlot(target))?.[target.index] ?? null
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
  /** `parentId` null is the top of the folder's own list: the rail's, or its project's. */
  | { op: 'placeRailFolder'; folderId: string; parentId: string | null; beforeId: string | null }
  | { op: 'placeProject'; projectId: string; folderId: string | null; beforeId: string | null }
  | { op: 'detachRepo'; repoId: string; folderId: string | null; beforeId: string | null; dissolves: string | null }
  | {
      op: 'addRepoToProject'
      projectId: string
      repoId: string
      /** The project's folder it goes in, or null for the top of the project's list. */
      folderId: string | null
      /** The row of that list it goes before (a repo or a folder), or null for last. */
      beforeId: string | null
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
  const ix = indexOf(rows)
  const beforeId = beforeIdAt(rows, target)
  // The folder the row would be directly in, and whose lists the target is
  // in: a project's (its id), or the rail's own (null).
  const folderId = target.kind === 'into' || target.kind === 'slot' ? target.folderId : null
  const folder = folderId === null ? undefined : ix.folders.get(folderId)
  if (folderId !== null && !folder) return null
  const projectId =
    target.kind === 'join' || target.kind === 'repoSlot' ? target.projectId : (folder?.projectId ?? null)

  if (drag.kind === 'folder') {
    const me = ix.folders.get(drag.id)
    if (!me || target.kind === 'join' || me.projectId !== projectId) return null
    if (folderId !== null && isUnder(ix, folderId, drag.id)) return null
    return { op: 'placeRailFolder', folderId: drag.id, parentId: folderId, beforeId }
  }
  if (drag.kind === 'project') {
    return projectId === null ? { op: 'placeProject', projectId: drag.id, folderId, beforeId } : null
  }

  const source = ix.owner.get(drag.id)
  if (!source) return null
  if (projectId === null) {
    if (source.kind === 'flat') return { op: 'placeProject', projectId: source.id, folderId, beforeId }
    return { op: 'detachRepo', repoId: drag.id, folderId, beforeId, dissolves: dissolvesOnLeave(source) }
  }
  const into = ix.projects.get(projectId)?.row
  if (!into) return null
  return {
    op: 'addRepoToProject',
    projectId: into.id,
    repoId: drag.id,
    folderId,
    beforeId,
    forms: into.kind === 'flat',
    dissolves: into.id === source.id ? null : dissolvesOnLeave(source)
  }
}
