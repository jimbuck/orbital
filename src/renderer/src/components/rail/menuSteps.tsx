import type { JSX } from 'react'
import { Folder, FolderGit2, FolderMinus, FolderPlus, Layers } from 'lucide-react'
import type { Project, RailItem, Repo } from '@shared/types'
import { useStore } from '@renderer/store'
import { fireAndForget } from '@renderer/lib/bridge'
import { MenuItem, MenuPrompt } from './menu'
import {
  dissolvesOnLeave,
  foldersIn,
  placeOf,
  projectRowById,
  projectRows,
  railRows,
  type RailAction,
  type RailRow
} from './folders'

/**
 * Menu steps the rail's row menus share. Each swaps in place of the items
 * (see ./menu), so a right-click never spawns a second surface.
 */

export const MENU_TITLE = 'truncate px-2 py-1.5 text-[11.5px] font-semibold text-text-2'
const MENU_CAPTION = 'px-2 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-[0.9px] text-faint'
const PICK_LIST = 'max-h-[260px] overflow-y-auto'

/** The rail's rows as the store has them, for a menu step to read places from. */
function useRailRows(): RailRow[] {
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
 * (a group's header or a flat row), filed among the rail's folders, or a
 * member repo, filed among its project's own folders. Rail arrangement only;
 * the project and the repo are untouched.
 */
export function FolderStep({
  name,
  item,
  onNewFolder,
  onDone
}: {
  /** What the title calls the row: the repo's name on a repo row, the project's on a header. */
  name: string
  /** The row being filed: a project, or one of a group's repos. */
  item: RailItem
  onNewFolder: () => void
  onDone: () => void
}): JSX.Element {
  const rows = useRailRows()
  // A member repo is filed among its own project's folders, and stays in that project.
  const ownerId = useStore((s) => (item.kind === 'repo' ? s.repos.find((r) => r.id === item.id)?.projectId : undefined))
  const folders = foldersIn(rows, item.kind === 'repo' ? (ownerId ?? '') : null)
  const kind = item.kind === 'repo' ? 'repo' : 'project'
  const folderId = placeOf(rows, kind, item.id)?.folderId ?? null

  /** Put the row in `target` (null = the top of its list), before `beforeId` or last. */
  const place = (target: string | null, beforeId: string | null): void => {
    if (item.kind === 'repo') {
      if (ownerId) fireAndForget(window.orbital.addRepoToProject(ownerId, item.id, beforeId, target))
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
      {folders.length > 0 && <div className="my-1 h-px bg-soft" />}
      <MenuItem icon={<FolderPlus size={13} strokeWidth={1.5} />} label="New Folder…" onClick={onNewFolder} />
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
