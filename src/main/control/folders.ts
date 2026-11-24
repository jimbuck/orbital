import type { ControlRequest, ControlResponse, Project, RailFolder, RailItem } from '@shared/types'
import { runtime, tables } from '../runtime'
import { railFolderPaths } from '../services/project-map'
import { scheduleProjectPointers } from '../services/project-pointers'

/**
 * The `orbital folder` commands: reading and arranging the rail's folders
 * from a terminal. They do what the rail's menus and drags do, through the
 * same repositories, so the rules are the same: a folder arranges the panel
 * and nothing else, it stays among its own kind, and it never goes inside
 * itself.
 *
 * A command works on one kind of list. By default that is the calling
 * terminal's project: the folders among its repos. `--rail` makes it the
 * rail's own: the folders that hold projects.
 */

/** One row of `folder list`, as the CLI prints it and `--json` returns it. */
export type FolderTreeRow =
  | { kind: 'folder'; id: string; name: string; path: string; collapsed: boolean; items: FolderTreeRow[] }
  | { kind: 'repo' | 'project'; id: string; name: string }

interface Scope {
  /** The project whose repos are arranged, or null for the rail's own lists. */
  project: Project | null
  /** The folders of this scope, and each one's path of names. */
  folders: RailFolder[]
  paths: Map<string, string>
  /** The top of the scope's list. */
  top: RailItem[]
}

const flag = (v: unknown): boolean => v === true || v === 'true'
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim())

/** The scope a request is about; `project` is the calling terminal's (or `--repo`'s). */
function scopeFor(req: ControlRequest, project: Project | undefined, noProject?: string): { scope?: Scope; error?: string } {
  const all = tables.railFolders.list()
  const paths = railFolderPaths(all)
  if (flag(req.args.rail)) {
    return { scope: { project: null, folders: all.filter((f) => f.projectId === null), paths, top: tables.railFolders.rail() } }
  }
  if (!project) return { error: noProject ?? 'no ORBITAL_WORKTREE_ID in environment' }
  // A project of one repo and no home is drawn as that repo: it has no list of repos to arrange.
  if (project.homeRepoId === null && project.repoIds.length <= 1) {
    return {
      error: `project '${project.name}' is a single repo, so it has no repos to arrange; pass --rail to work with the rail's own folders`
    }
  }
  const top =
    tables.railFolders.projectItems()[project.id] ?? project.repoIds.map((id): RailItem => ({ kind: 'repo', id }))
  return { scope: { project, folders: all.filter((f) => f.projectId === project.id), paths, top } }
}

/** What the rows of a scope are called: a project's repos, or the rail's projects. */
const rowKind = (scope: Scope): 'repo' | 'project' => (scope.project ? 'repo' : 'project')

/** The rows of a scope that are not folders, by id: the project's repos but its home, or the workspace's projects. */
function leaves(scope: Scope): Map<string, string> {
  if (!scope.project) return new Map(tables.projects.list().map((p) => [p.id, p.name]))
  const { homeRepoId, repoIds } = scope.project
  const names = new Map(tables.repos.list().map((r) => [r.id, r.name]))
  // The home repo is the project's header in the rail, not a row of its list.
  return new Map(repoIds.filter((id) => id !== homeRepoId).map((id) => [id, names.get(id) ?? id]))
}

/** Find a folder of the scope by id, by its path of names (`Games/Engines`), or by a name only one has. */
function resolveFolder(scope: Scope, ref: string): { folder?: RailFolder; error?: string } {
  if (!ref) return { error: 'folder name or id required' }
  const byId = scope.folders.find((f) => f.id === ref)
  if (byId) return { folder: byId }
  const lower = ref.toLowerCase()
  const byPath = scope.folders.filter((f) => scope.paths.get(f.id)?.toLowerCase() === lower)
  const hits = byPath.length > 0 ? byPath : scope.folders.filter((f) => f.name.toLowerCase() === lower)
  if (hits.length === 1) return { folder: hits[0] }
  if (hits.length > 1) {
    const where = hits.map((f) => `${scope.paths.get(f.id)} (${f.id})`).join(', ')
    return { error: `folder '${ref}' is ambiguous: ${where}. Use its path or its id.` }
  }
  const whose = scope.project ? `among the repos of project '${scope.project.name}'` : 'in the rail'
  return { error: `no folder '${ref}' ${whose} (see \`orbital folder list${scope.project ? '' : ' --rail'}\`)` }
}

/** Find a row of the scope: a repo (or, in the rail, a project) by id or name, else a folder. */
function resolveRow(scope: Scope, ref: string): { row?: RailItem; name?: string; error?: string } {
  if (!ref) return { error: `${rowKind(scope)} or folder name required` }
  const kind = rowKind(scope)
  const rows = leaves(scope)
  const lower = ref.toLowerCase()
  const named = [...rows].filter(([id, name]) => id === ref || name.toLowerCase() === lower)
  const folder = resolveFolder(scope, ref)
  if (named.length > 1) return { error: `${kind} '${ref}' is ambiguous (${named.map(([id]) => id).join(', ')}): use its id` }
  if (named.length === 1 && folder.folder) {
    return { error: `'${ref}' names both a ${kind} and a folder: use the id of the one you mean` }
  }
  if (named.length === 1) return { row: { kind, id: named[0][0] }, name: named[0][1] }
  if (folder.folder) return { row: { kind: 'folder', id: folder.folder.id }, name: scope.paths.get(folder.folder.id) }
  if (scope.project?.homeRepoId) {
    const home = tables.repos.get(scope.project.homeRepoId)
    if (home && (home.id === ref || home.name.toLowerCase() === lower)) {
      return { error: `'${home.name}' is the home repo of '${scope.project.name}': it is the project's header, not a row among its repos` }
    }
  }
  return { error: `no ${kind} or folder '${ref}' ${scope.project ? `in project '${scope.project.name}'` : 'in the rail'}` }
}

/** The scope's rows as a tree, in the order the rail draws them. */
function tree(scope: Scope): FolderTreeRow[] {
  const byId = new Map(scope.folders.map((f) => [f.id, f]))
  const names = leaves(scope)
  const kind = rowKind(scope)
  const rowsOf = (items: RailItem[]): FolderTreeRow[] =>
    items.flatMap((item): FolderTreeRow[] => {
      if (item.kind === 'folder') {
        const folder = byId.get(item.id)
        if (!folder) return []
        return [
          {
            kind: 'folder',
            id: folder.id,
            name: folder.name,
            path: scope.paths.get(folder.id) ?? folder.name,
            collapsed: folder.collapsed,
            items: rowsOf(folder.items)
          }
        ]
      }
      const name = names.get(item.id)
      return item.kind === kind && name !== undefined ? [{ kind, id: item.id, name }] : []
    })
  return rowsOf(scope.top)
}

/** A change to how a project's repos are arranged also reorders them, which the managed repo list follows. */
function arranged(scope: Scope): void {
  runtime.broadcastState()
  if (scope.project) scheduleProjectPointers()
}

const where = (scope: Scope): { scope: 'project' | 'rail'; project: string | null } => ({
  scope: scope.project ? 'project' : 'rail',
  project: scope.project?.name ?? null
})

export function listFolders(req: ControlRequest, project?: Project, noProject?: string): ControlResponse {
  const { scope, error } = scopeFor(req, project, noProject)
  if (!scope) return { ok: false, error }
  return { ok: true, data: { ...where(scope), items: tree(scope) } }
}

export function addFolder(req: ControlRequest, project?: Project, noProject?: string): ControlResponse {
  const { scope, error } = scopeFor(req, project, noProject)
  if (!scope) return { ok: false, error }
  const name = text(req.args.name)
  if (!name) return { ok: false, error: 'folder name required' }
  let parent: RailFolder | undefined
  if (req.args.in !== undefined) {
    const found = resolveFolder(scope, text(req.args.in))
    if (!found.folder) return { ok: false, error: found.error }
    parent = found.folder
  }
  const created = tables.railFolders.create(
    name,
    parent ? { parentId: parent.id } : scope.project ? { projectId: scope.project.id } : undefined
  )
  arranged(scope)
  const parentPath = parent ? scope.paths.get(parent.id) : undefined
  return {
    ok: true,
    data: { ...where(scope), id: created.id, name: created.name, path: parentPath ? `${parentPath}/${name}` : name }
  }
}

export function moveToFolder(req: ControlRequest, project?: Project, noProject?: string): ControlResponse {
  const { scope, error } = scopeFor(req, project, noProject)
  if (!scope) return { ok: false, error }
  const found = resolveRow(scope, text(req.args.row))
  if (!found.row) return { ok: false, error: found.error }
  const row = found.row

  const top = flag(req.args.top)
  if (top === (req.args.to !== undefined)) return { ok: false, error: 'say where it goes: --to <folder>, or --top' }
  let target: RailFolder | undefined
  if (!top) {
    const dest = resolveFolder(scope, text(req.args.to))
    if (!dest.folder) return { ok: false, error: dest.error }
    target = dest.folder
  }
  let beforeId: string | null = null
  if (req.args.before !== undefined) {
    const before = resolveRow(scope, text(req.args.before))
    if (!before.row) return { ok: false, error: before.error }
    beforeId = before.row.id
  }
  const targetId = target?.id ?? null

  if (row.kind === 'folder') {
    tables.railFolders.placeFolder(row.id, targetId, beforeId)
    // The repository refuses a folder a place inside itself by doing nothing.
    if ((tables.railFolders.get(row.id)?.parentId ?? null) !== targetId) {
      return { ok: false, error: `folder '${found.name}' cannot go inside itself` }
    }
  } else if (scope.project) {
    tables.projects.addRepo(scope.project.id, row.id, beforeId, targetId)
  } else {
    tables.railFolders.placeProject(row.id, targetId, beforeId)
  }
  arranged(scope)
  return {
    ok: true,
    data: { ...where(scope), kind: row.kind, id: row.id, name: found.name, folder: target ? scope.paths.get(target.id) : null }
  }
}

export function renameFolder(req: ControlRequest, project?: Project, noProject?: string): ControlResponse {
  const { scope, error } = scopeFor(req, project, noProject)
  if (!scope) return { ok: false, error }
  const found = resolveFolder(scope, text(req.args.folder))
  if (!found.folder) return { ok: false, error: found.error }
  const name = text(req.args.name)
  if (!name) return { ok: false, error: 'new folder name required' }
  tables.railFolders.rename(found.folder.id, name)
  runtime.broadcastState()
  return { ok: true, data: { ...where(scope), id: found.folder.id, name, was: found.folder.name } }
}

export function removeFolder(req: ControlRequest, project?: Project, noProject?: string): ControlResponse {
  const { scope, error } = scopeFor(req, project, noProject)
  if (!scope) return { ok: false, error }
  const found = resolveFolder(scope, text(req.args.folder))
  if (!found.folder) return { ok: false, error: found.error }
  tables.railFolders.remove(found.folder.id)
  arranged(scope)
  return {
    ok: true,
    data: { ...where(scope), id: found.folder.id, name: found.folder.name, released: found.folder.items.length }
  }
}
