import { useState, type ReactNode } from 'react'
import { FolderOpen, GitBranch } from 'lucide-react'
import { Spinner } from '@renderer/lib/status'
import { useStore } from '@renderer/store'
import { cleanIpcError } from '@renderer/lib/ipcError'
import { ModalShell, ghostBtn } from './ModalRoot'
import { SegmentedControl, type SegmentedOption } from '../SegmentedControl'
import { ADD_PROJECT_WIDTH, CloneFromGithub, CreateOnGithub, useGithubContext } from './AddProjectGithub'

/**
 * Where the project comes from. Hoisted so the options array is a stable
 * reference rather than a fresh one on every keystroke in the forms below.
 */
export type AddProjectMode = 'local' | 'clone' | 'create'

const MODES: readonly SegmentedOption<AddProjectMode>[] = [
  { value: 'local', label: 'Local folder' },
  { value: 'clone', label: 'Clone from GitHub' },
  { value: 'create', label: 'New GitHub repo' }
]

/**
 * The Add Project dialog. Three ways in, one radio group at the top:
 *
 *  - **Local folder** — the native picker over a repo that already exists.
 *  - **Clone from GitHub** — pick one of your repositories (or type
 *    `owner/repo`) and clone it into a folder of your choosing.
 *  - **New GitHub repo** — the full `gh repo create` form: owner, name with a
 *    live availability check, visibility, description, and the optional
 *    gitignore / license / README / template / homepage / team extras, then a
 *    clone of the result.
 *
 * Each mode renders its own ModalShell because the footer's primary action,
 * and what it is allowed to do, is different in each. The GitHub context (who
 * you are, your orgs, the template lists) is loaded here, above the two GitHub
 * forms, so flipping between them does not fetch it twice.
 */
export default function AddProject(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const [mode, setMode] = useState<AddProjectMode>('local')
  const github = useGithubContext(mode !== 'local')

  const modeSwitch = (
    <SegmentedControl label="Project source" options={MODES} value={mode} onChange={setMode} fill className="mb-4" />
  )

  if (mode === 'clone') return <CloneFromGithub github={github} modeSwitch={modeSwitch} onDone={closeModal} />
  if (mode === 'create') return <CreateOnGithub github={github} modeSwitch={modeSwitch} onDone={closeModal} />
  return <LocalFolder modeSwitch={modeSwitch} onDone={closeModal} />
}

function LocalFolder({ modeSwitch, onDone }: { modeSwitch: ReactNode; onDone: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The native folder picker lives in main; a non-null result means a Project
  // (and its root Worktree) was created and pushed into the store.
  const choose = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const project = await window.orbital.addProject()
      if (project) onDone()
      else setBusy(false) // dialog cancelled — keep the modal open
    } catch (e) {
      setError(cleanIpcError(e) || 'Could not open that folder as a project.')
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="Add project"
      subtitle="Open a local git repo in Orbital"
      width={ADD_PROJECT_WIDTH}
      onClose={onDone}
      footer={
        <button type="button" className={ghostBtn} onClick={onDone}>
          Cancel
        </button>
      }
    >
      {modeSwitch}

      <p className="text-[12.5px] leading-relaxed text-text-3 text-pretty">
        Point Orbital at a folder that already contains a git repository. We will register it as a project so you can
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
