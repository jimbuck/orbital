import type { JSX } from 'react'
import { Folder, FolderGit2, FolderMinus, FolderPlus, Layers } from 'lucide-react'
import type { Project, Repo } from '@shared/types'
import { useStore } from '@renderer/store'
import { fireAndForget } from '@renderer/lib/bridge'
import { MenuItem, MenuPrompt } from './menu'
import { dissolvesOnLeave, projectRowById, projectRows, railRows, type RailAction } from './folders'

/**
 * Menu steps the rail's row menus share. Each swaps in place of the items
 * (see ./menu), so a right-click never spawns a second surface.
 */

export const MENU_TITLE = 'truncate px-2 py-1.5 text-[11.5px] font-semibold text-text-2'
const MENU_CAPTION = 'px-2 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-[0.9px] text-faint'
const PICK_LIST = 'max-h-[260px] overflow-y-auto'

/**
 * "Move to Folder": file a project in a folder (last in it), start a new
 * folder for it, or take it out to the top level just below its folder.
 * Rail arrangement only; the project is untouched.
 */
export function FolderStep({
  name,
  projectId,
  onNewFolder,
  onDone
}: {
  /** What the title calls the row: the repo's name on a flat row, the project's on a header. */
  name: string
  projectId: string
  onNewFolder: () => void
  onDone: () => void
}): JSX.Element {
  const folders = useStore((s) => s.railFolders)
  const folderId = folders.find((f) => f.projectIds.includes(projectId))?.id ?? null

  const moveTo = (target: string): void => {
    fireAndForget(window.orbital.placeProject(projectId, target, null))
    onDone()
  }
  // Out of its folder, it lands at the top level just below that folder, which
  // is the nearest place to where it was.
  const removeFromFolder = (): void => {
    const rail = useStore.getState().railItems
    const at = rail.findIndex((item) => item.kind === 'folder' && item.id === folderId)
    fireAndForget(window.orbital.placeProject(projectId, null, at === -1 ? null : (rail[at + 1]?.id ?? null)))
    onDone()
  }

  return (
    <>
      <div className={MENU_TITLE}>Move {name} to</div>
      <div className={PICK_LIST}>
        {folders.map((folder) => (
          <MenuItem
            key={folder.id}
            icon={<Folder size={13} strokeWidth={1.5} />}
            label={folder.name}
            hint={folder.id === folderId ? 'current' : undefined}
            disabled={folder.id === folderId}
            onClick={() => moveTo(folder.id)}
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

/** The name prompt "New Folder…" leads to: a folder made to hold `projectId`, where it was. */
export function NewFolderStep({
  name,
  projectId,
  onDone
}: {
  name: string
  projectId: string
  onDone: () => void
}): JSX.Element {
  return (
    <MenuPrompt
      label={`New folder for ${name}`}
      placeholder="Folder name"
      confirmLabel="Create"
      onSubmit={(folderName) => {
        fireAndForget(window.orbital.createRailFolder(folderName, projectId))
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
  const projects = useStore((s) => s.projects)
  const repos = useStore((s) => s.repos)
  const folders = useStore((s) => s.railFolders)
  const rail = useStore((s) => s.railItems)
  const rows = railRows(projects, repos, folders, rail, {})
  const all = projectRows(rows)
  const groups = all.filter((p) => p.kind === 'group')
  const flats = all.filter((p) => p.kind === 'flat' && p.id !== project.id)
  const dissolves = dissolvesOnLeave(projectRowById(rows, project.id))

  const join = (projectId: string, forms: boolean): void =>
    onPick({ op: 'addRepoToProject', projectId, repoId: repo.id, beforeRepoId: null, forms, dissolves })

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
