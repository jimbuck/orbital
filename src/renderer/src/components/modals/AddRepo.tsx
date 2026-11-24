import { useState } from 'react'
import { FolderInput, FolderOpen, GitBranch } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { RailFolder } from '@shared/types'
import { Spinner } from '@renderer/lib/status'
import { useStore } from '@renderer/store'
import { cleanIpcError } from '@renderer/lib/ipcError'
import { fireAndForget } from '@renderer/lib/bridge'
import { ModalShell, ghostBtn } from './ModalRoot'
import { SegmentedControl, type SegmentedOption } from '../SegmentedControl'
import { ADD_REPO_WIDTH, CloneFromGithub, CreateOnGithub, useGithubContext, type SourceProps } from './AddRepoGithub'
import { CloneFromAzure } from './AddRepoAzure'

/**
 * Where the repo comes from. Hoisted so the options array is a stable
 * reference rather than a fresh one on every keystroke in the forms below.
 */
export type AddRepoMode = 'local' | 'clone' | 'create' | 'azure'

const MODES: readonly SegmentedOption<AddRepoMode>[] = [
  { value: 'local', label: 'Local folder' },
  { value: 'clone', label: 'Clone from GitHub' },
  { value: 'create', label: 'New GitHub repo' },
  { value: 'azure', label: 'Azure DevOps' }
]

/**
 * Where the dialog was opened from, as `openModal('addRepo', …)` data. A
 * project's menu gives `projectId`; a rail folder's gives `folderId`, plus its
 * project for a folder of that project's repos. Nothing means the top of the
 * rail.
 */
export interface AddRepoTarget {
  projectId?: string
  folderId?: string
}

/** The folder and the ones it sits in, outermost first. */
function folderTrail(folders: RailFolder[], folderId: string | undefined): RailFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const trail: RailFolder[] = []
  for (let f = folderId ? byId.get(folderId) : undefined; f && !trail.includes(f); ) {
    trail.unshift(f)
    f = f.parentId ? byId.get(f.parentId) : undefined
  }
  return trail
}

/**
 * The Add Repo dialog. Four ways in, one radio group at the top:
 *
 *  - **Local folder** — the native picker over a repo that already exists.
 *  - **Clone from GitHub** — pick one of your repositories (or type
 *    `owner/repo`) and clone it into a folder of your choosing.
 *  - **New GitHub repo** — the full `gh repo create` form: owner, name with a
 *    live availability check, visibility, description, and the optional
 *    gitignore / license / README / template / homepage / team extras, then a
 *    clone of the result.
 *  - **Azure DevOps** — paste a repository's link and clone it with git.
 *
 * Each mode renders its own ModalShell because the footer's primary action,
 * and what it is allowed to do, is different in each. The GitHub context (who
 * you are, your orgs, the template lists) is loaded here, above the two GitHub
 * forms, so flipping between them does not fetch it twice.
 *
 * Opened from a project or a rail folder, the repo is added there whichever
 * way it comes in, and the line above the sources says where.
 */
export default function AddRepo(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const target = useStore((s) => s.modalData as AddRepoTarget | null)
  const trail = useStore(useShallow((s) => folderTrail(s.railFolders, target?.folderId)))
  const folder = trail[trail.length - 1]
  // A folder of a project's repos says which project it is; main reads it the same way.
  const projectId = folder ? (folder.projectId ?? undefined) : target?.projectId
  const project = useStore((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined))
  // A plain repo row is a project of one. A second repo makes it a project
  // proper, with a header of its own to name: decided as the dialog opens,
  // since by the time the repo is in, the project no longer looks like a row.
  const [starts] = useState(() => !!project && project.homeRepoId === null && project.repoIds.length === 1)
  const [mode, setMode] = useState<AddRepoMode>('local')
  const github = useGithubContext(mode === 'clone' || mode === 'create')

  // Show where it went: the folders around it open, and so does its project.
  const onAdded = (): void => {
    const { setExpanded, setRenamingProject } = useStore.getState()
    for (const f of trail) {
      if (f.collapsed) fireAndForget(window.orbital.setRailFolderCollapsed(f.id, false))
    }
    if (projectId) {
      setExpanded(projectId, true)
      if (starts) setRenamingProject(projectId)
    }
    closeModal()
  }

  const folders = trail.map((f) => f.name).join(' › ')
  const modeSwitch = (
    <>
      {(project || folder) && (
        <div className="mb-3 flex items-center gap-1.5 text-[11.5px] text-dim">
          <FolderInput size={13} strokeWidth={1.5} className="flex-none text-faint" />
          <span className="min-w-0 truncate">
            {starts ? (
              <>
                Starts a project with <b className="font-semibold text-text-3">{project?.name}</b>
              </>
            ) : project ? (
              <>
                Adding to <b className="font-semibold text-text-3">{project.name}</b>
                {folders && ` › ${folders}`}
              </>
            ) : (
              <>
                Adding to the folder <b className="font-semibold text-text-3">{folders}</b>
              </>
            )}
          </span>
        </div>
      )}
      <SegmentedControl label="Repo source" options={MODES} value={mode} onChange={setMode} fill className="mb-4" />
    </>
  )

  const source: SourceProps = { modeSwitch, onDone: closeModal, onAdded, projectId, folderId: folder?.id }

  if (mode === 'clone') return <CloneFromGithub github={github} {...source} />
  if (mode === 'create') return <CreateOnGithub github={github} {...source} />
  if (mode === 'azure') return <CloneFromAzure {...source} />
  return <LocalFolder {...source} projectName={starts ? undefined : project?.name} />
}

function LocalFolder({
  modeSwitch,
  onDone,
  onAdded,
  projectId,
  folderId,
  projectName
}: SourceProps & { projectName?: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The native folder picker lives in main; a non-null result means a Repo
  // (and its root Worktree) was created and pushed into the store.
  const choose = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const repo = await window.orbital.addRepo(projectId, folderId)
      if (repo) onAdded()
      else setBusy(false) // dialog cancelled — keep the modal open
    } catch (e) {
      setError(cleanIpcError(e) || 'Could not open that folder as a repo.')
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="Add repo"
      subtitle={projectName ? `Open a local git repo in ${projectName}` : 'Open a local git repo in Orbital'}
      width={ADD_REPO_WIDTH}
      onClose={onDone}
      footer={
        <button type="button" className={ghostBtn} onClick={onDone}>
          Cancel
        </button>
      }
    >
      {modeSwitch}

      <p className="text-[12.5px] leading-relaxed text-text-3 text-pretty">
        Point Orbital at a folder that already contains a git repository. We will register it as a repo so you can
        launch Worktrees against it.
      </p>

      <button
        type="button"
        onClick={choose}
        disabled={busy}
        className="mt-4 flex w-full items-center justify-center gap-2.5 rounded-btn bg-accent px-4 py-3 text-[13px] font-bold text-on-accent hover:bg-accent-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
      >
        {busy ? (
          <Spinner className="text-[16px]" />
        ) : (
          <FolderOpen size={16} strokeWidth={1.5} />
        )}
        {busy ? 'Opening…' : 'Choose folder…'}
      </button>

      <div className="mt-3 flex items-center gap-2.5 rounded-btn border border-green/20 bg-green/[0.06] px-3 py-2.5">
        <GitBranch size={14} strokeWidth={1.5} className="flex-none text-green-2" />
        <span className="text-[11.5px] text-green-2">A root Worktree on the repo&rsquo;s current branch is created automatically.</span>
      </div>

      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
