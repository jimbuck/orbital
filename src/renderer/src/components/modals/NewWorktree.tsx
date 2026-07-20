import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronDown, FolderGit2 } from 'lucide-react'
import { useStore, activeProject, tasksForProject } from '@renderer/store'
import type { Project, Task, BranchInfo } from '@shared/types'
import { ModalShell, primaryBtn, ghostBtn, inputBase, fieldLabel } from './ModalRoot'

/** modalData payload for the New Worktree modal. */
interface NewWorktreeData {
  project?: Project
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
        className={`${inputBase} ${mono ? 'font-mono' : ''} cursor-pointer appearance-none pr-8 [&_option]:bg-elev [&_option]:text-text`}
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

export default function NewWorktree(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const setActiveWorktree = useStore((s) => s.setActiveWorktree)
  const data = useStore((s) => s.modalData) as NewWorktreeData | null
  const fallback = useStore(activeProject)
  const project = data?.project ?? fallback

  // Subscribe via useShallow: tasksForProject() builds a fresh array each call,
  // and a selector that returns a new reference every render makes zustand v5's
  // useSyncExternalStore loop forever ("Maximum update depth exceeded").
  const allTasks = useStore(useShallow((s) => (project ? tasksForProject(s, project.id) : [])))
  const prefill = data?.task
  // Only tasks without a Worktree can be linked — plus the prefill task itself.
  const linkable = useMemo(
    () => allTasks.filter((t) => !t.worktreeId || t.id === prefill?.id),
    [allTasks, prefill?.id]
  )

  const [name, setName] = useState(prefill?.title ?? '')
  // "new" forks a fresh branch named after the Worktree; "existing" checks out
  // a branch the repo already has (e.g. reviewing a PR branch).
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [branch, setBranch] = useState(prefill ? toBranch(prefill.title) : '')
  // Once the user hand-edits the branch field it stops tracking the name.
  const [branchTouched, setBranchTouched] = useState(false)
  const [existingBranch, setExistingBranch] = useState('')
  const [baseRef, setBaseRef] = useState('') // '' => HEAD
  const [linkedTaskId, setLinkedTaskId] = useState(prefill?.id ?? '')
  const [info, setInfo] = useState<BranchInfo>({ branches: [], remotes: [], head: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Load the repo's branches + what HEAD points at for the base-ref picker.
  const projectId = project?.id
  useEffect(() => {
    if (!projectId) return
    let alive = true
    void window.orbital.listBranches(projectId).then((r) => {
      if (alive) setInfo(r)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  // No project to target — surface a clear message instead of a broken form.
  if (!project) {
    return (
      <ModalShell
        title="New Worktree"
        width={520}
        onClose={closeModal}
        footer={
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Close
          </button>
        }
      >
        <p className="text-[12.5px] text-text-3">Add a project first, then create a Worktree on it.</p>
      </ModalShell>
    )
  }

  // The branch field tracks the name (slugified) until it is hand-edited.
  const onName = (value: string): void => {
    setName(value)
    if (!branchTouched) setBranch(toBranch(value))
  }

  // Picking a task seeds the name (and derived branch) when it isn't set yet.
  const onPickTask = (taskId: string): void => {
    setLinkedTaskId(taskId)
    const task = linkable.find((t) => t.id === taskId)
    if (task && !name.trim()) onName(task.title)
  }

  // Picking a branch defaults the name from it (sans remote prefix) when empty.
  const onPickExisting = (value: string): void => {
    setExistingBranch(value)
    if (value && !name.trim()) setName(value.replace(/^[^/]+\//, ''))
  }

  const submit = async (): Promise<void> => {
    const trimmedBranch = mode === 'new' ? branch.trim() : existingBranch
    if (!trimmedBranch) {
      setError(mode === 'new' ? 'Branch name is required.' : 'Pick a branch to open.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const worktree = await window.orbital.createWorktree(project.id, {
        branch: mode === 'new' ? trimmedBranch : undefined,
        existingBranch: mode === 'existing' ? trimmedBranch : undefined,
        name: name.trim() || (mode === 'new' ? trimmedBranch : trimmedBranch.replace(/^[^/]+\//, '')),
        worktree: true,
        baseRef: mode === 'new' ? baseRef || undefined : undefined,
        taskId: linkedTaskId || undefined
      })
      setActiveWorktree(worktree.id)
      closeModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create the Worktree.')
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
      title="New Worktree"
      subtitle={`Creates a git worktree · ${project.name}`}
      width={520}
      onClose={closeModal}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryBtn}
            onClick={submit}
            disabled={busy || (mode === 'new' ? !branch.trim() : !existingBranch)}
          >
            Create Worktree
          </button>
        </>
      }
    >
      <label className={fieldLabel} htmlFor="nf-name">
        Worktree name
      </label>
      <input
        id="nf-name"
        autoFocus
        value={name}
        onChange={(e) => onName(e.target.value)}
        onKeyDown={onEnter}
        placeholder="Login flow, Review PR 42…"
        className={`mt-1.5 ${inputBase}`}
      />

      {/* Two-way branch source; mirrors the Settings theme segmented control. */}
      <div className="mt-4 flex items-center rounded-[7px] border border-line-2 bg-bg p-[2px]">
        {(
          [
            ['new', 'Create new branch'],
            ['existing', 'Open existing branch']
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            aria-pressed={mode === value}
            className={`flex-1 rounded-[5px] px-2.5 py-[3px] text-[11px] font-semibold ${
              mode === value ? 'bg-accent/15 text-blue' : 'text-muted hover:text-text-2'
            } focus-visible:ring-2 focus-visible:ring-accent/60 outline-none`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'new' ? (
        <>
          <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-branch">
            Branch name <span className="font-normal text-faint">· generated from the name</span>
          </label>
          <input
            id="nf-branch"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value)
              setBranchTouched(true)
            }}
            onKeyDown={onEnter}
            placeholder="feat/cli-flags"
            aria-invalid={Boolean(error && !branch.trim())}
            className={`mt-1.5 font-mono ${inputBase}`}
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
        </>
      ) : (
        <>
          <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-existing">
            Branch{' '}
            <span className="font-normal text-faint">· remote picks get a local tracking branch</span>
          </label>
          <Select id="nf-existing" value={existingBranch} onChange={onPickExisting} mono>
            <option value="">Pick a branch…</option>
            {info.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            {info.remotes.length > 0 && (
              <optgroup label="Remote">
                {info.remotes.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </>
      )}

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
        <span className="truncate font-mono">{project.repoPath}</span>
      </div>

      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
