import type { JSX } from 'react'
import { Folder, FolderGit2, FolderMinus, FolderPlus, Layers } from 'lucide-react'
import type { Project, RailItem, Repo } from '@shared/types'
import { useStore } from '@renderer/store'
import { fireAndForget } from '@renderer/lib/bridge'
import { MenuItem, MenuPrompt } from './menu'
import {
  dissolvesOnLeave,
  folderIsWithin,
  foldersIn,
  leafRows,
  placeOf,
  projectRowById,
  projectRows,
  railRows,
  type FolderRow,
  type ProjectRow,
  type RailAction,
  type RailRow,
  type RepoRow
} from './folders'

/**
 * Menu steps the rail's row menus share. Each swaps in place of the items
 * (see ./menu), so a right-click never spawns a second surface.
 */

export const MENU_TITLE = 'truncate px-2 py-1.5 text-[11.5px] font-semibold text-text-2'
const MENU_CAPTION = 'px-2 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-[0.9px] text-faint'
const PICK_LIST = 'max-h-[260px] overflow-y-auto'

/** The rail's rows as the store has them, for a menu step to read places from. */
export function useRailRows(): RailRow[] {
  const projects = useStore((s) => s.projects)
  const repos = useStore((s) => s.repos)
  const folders = useStore((s) => s.railFolders)
  const rail = useStore((s) => s.railItems)
  const projectItems = useStore((s) => s.railProjectItems)
  return railRows(projects, repos, folders, rail, {}, projectItems)
}

/**
 * "Move to Folder": file a row in a folder (last in it), start a new folder
 * for it, or take it out of its folder to just below it. The row is a project
 * (a group's header or a flat row), filed among the rail's folders; a member
 * repo, filed among its project's own folders; or a folder, filed among the
 * other folders of its kind (never in itself). Rail arrangement only; the
 * project and the repo are untouched.
 */
export function FolderStep({
  name,
  item,
  onNewFolder,
  onDone
}: {
  /** What the title calls the row: the repo's name on a repo row, the project's on a header, the folder's on a folder. */
  name: string
  /** The row being filed: a project, one of a group's repos, or a folder. */
  item: RailItem
  /** Leads to the name prompt for a folder made to hold the row. Absent for a folder, which has New Folder Inside. */
  onNewFolder?: () => void
  onDone: () => void
}): JSX.Element {
  const rows = useRailRows()
  // A member repo is filed among its own project's folders, and stays in that
  // project; so does one of a project's folders. Null is the rail's own folders.
  const scope = useStore((s) => {
    if (item.kind === 'repo') return s.repos.find((r) => r.id === item.id)?.projectId ?? ''
    if (item.kind === 'folder') return s.railFolders.find((f) => f.id === item.id)?.projectId ?? null
    return null
  })
  const folders = foldersIn(rows, scope).filter(
    // A folder does not go into itself, or into anything inside it.
    ({ folder }) => item.kind !== 'folder' || !folderIsWithin(rows, folder.id, item.id)
  )
  const folderId = placeOf(rows, item.kind, item.id)?.folderId ?? null

  /** Put the row in `target` (null = the top of its list), before `beforeId` or last. */
  const place = (target: string | null, beforeId: string | null): void => {
    if (item.kind === 'repo') {
      if (scope) fireAndForget(window.orbital.addRepoToProject(scope, item.id, beforeId, target))
    } else if (item.kind === 'folder') {
      fireAndForget(window.orbital.placeRailFolder(item.id, target, beforeId))
    } else {
      fireAndForget(window.orbital.placeProject(item.id, target, beforeId))
    }
    onDone()
  }
  // Out of its folder, it lands just below that folder, in the list the
  // folder is in, which is the nearest place to where it was.
  const removeFromFolder = (): void => {
    const holder = folderId === null ? null : placeOf(rows, 'folder', folderId)
    place(holder?.folderId ?? null, holder ? (holder.ids[holder.index + 1] ?? null) : null)
  }

  return (
    <>
      <div className={MENU_TITLE}>Move {name} to</div>
      <div className={PICK_LIST}>
        {folders.map(({ folder, depth }) => (
          <MenuItem
            key={folder.id}
            // Indented by how deep the folder is nested, as the rail draws it.
            icon={
              <span className="inline-flex" style={{ paddingLeft: depth * 10 }}>
                <Folder size={13} strokeWidth={1.5} />
              </span>
            }
            label={folder.name}
            hint={folder.id === folderId ? 'current' : undefined}
            disabled={folder.id === folderId}
            onClick={() => place(folder.id, null)}
          />
        ))}
      </div>
      {folders.length === 0 && !onNewFolder && folderId === null && (
        <div className="px-2 py-1.5 text-[11px] text-faint">No other folders yet.</div>
      )}
      {folders.length > 0 && (onNewFolder || folderId !== null) && <div className="my-1 h-px bg-soft" />}
      {onNewFolder && (
        <MenuItem icon={<FolderPlus size={13} strokeWidth={1.5} />} label="New Folder…" onClick={onNewFolder} />
      )}
      {folderId !== null && (
        <MenuItem
          icon={<FolderMinus size={13} strokeWidth={1.5} />}
          label="Remove from Folder"
          onClick={removeFromFolder}
        />
      )}
    </>
  )
}

/**
 * "Move Here": file rows that are already in the rail in this folder, one
 * click each. A folder of repos offers its project's other repos, a folder of
 * projects every project (and plain repo row) that is not already directly in
 * it. The step stays open, and a row leaves the list as it is filed, so
 * several can be gathered in one go. Rail arrangement only.
 */
export function GatherStep({
  row,
  project
}: {
  row: FolderRow<ProjectRow> | FolderRow<RepoRow>
  /** The project whose repos this folder arranges; absent for a folder of projects. */
  project?: Project
}): JSX.Element {
  const rows = useRailRows()
  const { folder } = row
  const folderName = (id: string | null): string | undefined =>
    id === null ? undefined : foldersIn(rows, project?.id ?? null).find((f) => f.folder.id === id)?.folder.name

  // What can be filed here, in rail order, with the folder each is in now.
  const candidates: Array<{ id: string; label: string; group: boolean; from: string | undefined }> = []
  if (project) {
    const owner = projectRowById(rows, project.id)
    for (const repo of owner?.kind === 'group' ? owner.members : []) {
      const at = placeOf(rows, 'repo', repo.id)
      if (at && at.folderId !== folder.id) {
        candidates.push({ id: repo.id, label: repo.name, group: false, from: folderName(at.folderId) })
      }
    }
  } else {
    for (const p of projectRows(rows)) {
      const at = placeOf(rows, 'project', p.id)
      if (at && at.folderId !== folder.id) {
        candidates.push({
          id: p.id,
          label: p.kind === 'flat' ? p.repo.name : p.project.name,
          group: p.kind === 'group',
          from: folderName(at.folderId)
        })
      }
    }
  }

  const file = (id: string): void => {
    if (project) fireAndForget(window.orbital.addRepoToProject(project.id, id, null, folder.id))
    else fireAndForget(window.orbital.placeProject(id, folder.id, null))
  }
  const here = leafRows<ProjectRow | RepoRow>(row.items).length

  return (
    <>
      <div className={MENU_TITLE}>Move into {folder.name}</div>
      {candidates.length === 0 ? (
        <div className="px-2 py-1.5 text-[11px] text-faint">
          {here > 0 ? 'Everything is in this folder already.' : project ? 'No repos to move yet.' : 'Nothing to move yet.'}
        </div>
      ) : (
        <div className={PICK_LIST}>
          {candidates.map((c) => (
            <MenuItem
              key={c.id}
              icon={c.group ? <Layers size={13} strokeWidth={1.5} /> : <FolderGit2 size={13} strokeWidth={1.5} />}
              label={c.label}
              hint={c.from ? `in ${c.from}` : undefined}
              onClick={() => file(c.id)}
            />
          ))}
        </div>
      )}
    </>
  )
}

/** The name prompt "New Folder…" leads to: a folder made to hold `item`, where it was. */
export function NewFolderStep({
  name,
  item,
  onDone
}: {
  name: string
  /** The project or member repo the folder is made for. */
  item: RailItem
  onDone: () => void
}): JSX.Element {
  return (
    <MenuPrompt
      label={`New folder for ${name}`}
      placeholder="Folder name"
      confirmLabel="Create"
      onSubmit={(folderName) => {
        fireAndForget(window.orbital.createRailFolder(folderName, { holding: item }))
        onDone()
      }}
      onCancel={onDone}
    />
  )
}

/**
 * "Move to Project": every group, then (under "New project with") every other
 * plain repo row, which the repo would start a project with. It hands back the
 * action rather than running it, so the menu can confirm first when the move
 * closes a folder session with terminals open.
 */
export function ProjectStep({
  repo,
  project,
  onPick
}: {
  repo: Repo
  /** The repo's own project. */
  project: Project
  onPick: (action: RailAction) => void
}): JSX.Element {
  const rows = useRailRows()
  const all = projectRows(rows)
  const groups = all.filter((p) => p.kind === 'group')
  const flats = all.filter((p) => p.kind === 'flat' && p.id !== project.id)
  const dissolves = dissolvesOnLeave(projectRowById(rows, project.id))

  const join = (projectId: string, forms: boolean): void =>
    onPick({ op: 'addRepoToProject', projectId, repoId: repo.id, folderId: null, beforeId: null, forms, dissolves })

  return (
    <>
      <div className={MENU_TITLE}>Move {repo.name} to</div>
      {groups.length === 0 && flats.length === 0 && (
        <div className="px-2 py-1.5 text-[11px] text-faint">No other repos yet.</div>
      )}
      {groups.length > 0 && (
        <div className={PICK_LIST}>
          {groups.map((g) => (
            <MenuItem
              key={g.id}
              icon={<Layers size={13} strokeWidth={1.5} />}
              label={g.project.name}
              hint={g.id === project.id ? 'current' : undefined}
              disabled={g.id === project.id}
              onClick={() => join(g.id, false)}
            />
          ))}
        </div>
      )}
      {flats.length > 0 && (
        <>
          {groups.length > 0 && <div className="my-1 h-px bg-soft" />}
          <div className={MENU_CAPTION}>New project with</div>
          <div className={PICK_LIST}>
            {flats.map((f) =>
              f.kind === 'flat' ? (
                <MenuItem
                  key={f.id}
                  icon={<FolderGit2 size={13} strokeWidth={1.5} />}
                  label={f.repo.name}
                  onClick={() => join(f.id, true)}
                />
              ) : null
            )}
          </div>
        </>
      )}
    </>
  )
}
