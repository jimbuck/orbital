import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronDown, FolderGit2 } from 'lucide-react'
import { useStore, activeWorkspace, tasksForWorkspace } from '@renderer/store'
import type { Workspace, Task, BranchInfo } from '@shared/types'
import { ModalShell, primaryBtn, ghostBtn, inputBase, fieldLabel } from './ModalRoot'

/** modalData payload for the New Flight modal. */
interface NewFlightData {
  workspace?: Workspace
  /** Pre-link this task and seed the branch/name from it (play-button flow). */
  task?: Task
}

/** Local slug suggestion for the branch field; main re-slugifies on submit. */
function toBranch(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}

/** Shared dark-styled <select> with a chevron affordance. */
function Select({
  value,
  onChange,
  children,
  id,
  mono
}: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  id?: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="relative mt-1.5">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputBase} ${mono ? 'font-mono' : ''} cursor-pointer appearance-none pr-8 [&>option]:bg-elev [&>option]:text-text`}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        strokeWidth={1.5}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
      />
    </div>
  )
}

export default function NewFlight(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const setActiveFlight = useStore((s) => s.setActiveFlight)
  const data = useStore((s) => s.modalData) as NewFlightData | null
  const fallback = useStore(activeWorkspace)
  const workspace = data?.workspace ?? fallback

  // Subscribe via useShallow: tasksForWorkspace() builds a fresh array each call,
  // and a selector that returns a new reference every render makes zustand v5's
  // useSyncExternalStore loop forever ("Maximum update depth exceeded").
  const allTasks = useStore(useShallow((s) => (workspace ? tasksForWorkspace(s, workspace.id) : [])))
  const prefill = data?.task
  // Only tasks without a Flight can be linked — plus the prefill task itself.
  const linkable = useMemo(
    () => allTasks.filter((t) => !t.flightId || t.id === prefill?.id),
    [allTasks, prefill?.id]
  )

  const [branch, setBranch] = useState(prefill ? toBranch(prefill.title) : '')
  const [name, setName] = useState(prefill?.title ?? '')
  const [baseRef, setBaseRef] = useState('') // '' => HEAD
  const [linkedTaskId, setLinkedTaskId] = useState(prefill?.id ?? '')
  const [info, setInfo] = useState<BranchInfo>({ branches: [], head: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Load the repo's branches + what HEAD points at for the base-ref picker.
  const workspaceId = workspace?.id
  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    void window.orbital.listBranches(workspaceId).then((r) => {
      if (alive) setInfo(r)
    })
    return () => {
      alive = false
    }
  }, [workspaceId])

  // No workspace to target — surface a clear message instead of a broken form.
  if (!workspace) {
    return (
      <ModalShell
        title="New Flight"
        width={520}
        onClose={closeModal}
        footer={
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Close
          </button>
        }
      >
        <p className="text-[12.5px] text-text-3">Add a workspace first, then create a Flight on it.</p>
      </ModalShell>
    )
  }

  // Picking a task seeds the branch/name when they haven't been set yet.
  const onPickTask = (taskId: string): void => {
    setLinkedTaskId(taskId)
    const task = linkable.find((t) => t.id === taskId)
    if (task) {
      if (!branch.trim()) setBranch(toBranch(task.title))
      if (!name.trim()) setName(task.title)
    }
  }

  const submit = async (): Promise<void> => {
    const trimmedBranch = branch.trim()
    if (!trimmedBranch) {
      setError('Branch name is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const flight = await window.orbital.createFlight(workspace.id, {
        branch: trimmedBranch,
        name: name.trim() || trimmedBranch,
        worktree: true,
        baseRef: baseRef || undefined,
        taskId: linkedTaskId || undefined
      })
      setActiveFlight(flight.id)
      closeModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create the Flight.')
      setBusy(false)
    }
  }

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <ModalShell
      title="New Flight"
      subtitle={`Creates a git worktree and a Flight · ${workspace.name}`}
      width={520}
      onClose={closeModal}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={submit} disabled={busy || !branch.trim()}>
            Create Flight
          </button>
        </>
      }
    >
      <label className={fieldLabel} htmlFor="nf-branch">
        Branch name
      </label>
      <input
        id="nf-branch"
        autoFocus
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        onKeyDown={onEnter}
        placeholder="feat/cli-flags"
        aria-invalid={Boolean(error && !branch.trim())}
        className={`mt-1.5 font-mono ${inputBase}`}
      />

      <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-name">
        Flight name <span className="font-normal text-faint">· optional</span>
      </label>
      <input
        id="nf-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onEnter}
        placeholder="Defaults to the branch name"
        className={`mt-1.5 ${inputBase}`}
      />

      <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-base">
        Base ref <span className="font-normal text-faint">· the new branch forks from here</span>
      </label>
      <Select id="nf-base" value={baseRef} onChange={setBaseRef} mono>
        <option value="">HEAD{info.head ? ` — current branch (${info.head})` : ''}</option>
        {info.branches.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </Select>

      {linkable.length > 0 && (
        <>
          <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-task">
            Link a task <span className="font-normal text-faint">· optional</span>
          </label>
          <Select id="nf-task" value={linkedTaskId} onChange={onPickTask}>
            <option value="">No linked task</option>
            {linkable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        </>
      )}

      <div className="mt-4 flex items-center gap-2.5 rounded-btn border border-green/20 bg-green/[0.06] px-3 py-2.5">
        <Check size={14} strokeWidth={1.5} className="flex-none text-green-2" />
        <span className="text-[11.5px] text-green-2">
          A worktree is created and your <span className="font-mono">.env</span> files are synced in.
        </span>
      </div>

      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-dim">
        <FolderGit2 size={13} strokeWidth={1.5} className="flex-none text-faint" />
        <span className="truncate font-mono">{workspace.repoPath}</span>
      </div>

      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
