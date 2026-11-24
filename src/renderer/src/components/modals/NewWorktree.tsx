import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, FolderGit2 } from 'lucide-react'
import { useStore, activeRepo, activeProject, tasksForProject } from '@renderer/store'
import {
  impliedWorktreeRepoId,
  parseTargetValue,
  taskLaneKey,
  targetValue,
  trackerFocusRepoId,
  worktreeTargets,
  PROJECT_LANE
} from '@renderer/lib/taskScope'
import type { Repo, Task, BranchInfo } from '@shared/types'
import { branchSlug, prefixedBranch } from '@shared/worktree-branch'
import { useSetting } from '@renderer/lib/settings'
import { ModalShell, primaryBtn, ghostBtn, inputBase, fieldLabel } from './ModalRoot'
import { SegmentedControl, type SegmentedOption } from '../SegmentedControl'
import { Select } from './Select'

/** Where the Worktree's branch comes from. Hoisted so the options array is a
 *  stable reference rather than a fresh one on every keystroke in this form. */
const BRANCH_SOURCES: readonly SegmentedOption<'new' | 'existing'>[] = [
  { value: 'new', label: 'Create new branch' },
  { value: 'existing', label: 'Open existing branch' }
]

/** modalData payload for the New Worktree modal. */
interface NewWorktreeData {
  /** The repo it goes in (rail entries). Without it the task's repo, or a pick. */
  repo?: Repo
  /** Pre-link this task and seed the branch/name from it (play-button flow). */
  task?: Task
}

export default function NewWorktree(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const setActiveWorktree = useStore((s) => s.setActiveWorktree)
  const data = useStore((s) => s.modalData) as NewWorktreeData | null
  const prefill = data?.task
  const fallback = useStore(activeRepo)
  const active = useStore(activeProject)
  const repos = useStore((s) => s.repos)
  const focusRepoId = useStore(trackerFocusRepoId)
  // Whose worktree this is: the task's project, else the active one.
  const project = useStore((s) => (prefill ? s.projects.find((p) => p.id === prefill.projectId) : undefined)) ?? active
  // Where it goes, when that is settled before the form opens: the repo it was
  // opened for (a rail entry; without a task, the active repo), else the
  // task's repo, else the project's only repo. Otherwise the user picks.
  const implied = impliedWorktreeRepoId(data?.repo ?? (prefill ? undefined : fallback), prefill, project)
  // A pick is modelled as a target (a repo now; the whole project later, #403).
  const targets = useMemo(() => (project ? worktreeTargets(project, repos) : []), [project, repos])
  const [picked, setPicked] = useState(() =>
    implied === null && focusRepoId && project?.repoIds.includes(focusRepoId)
      ? targetValue({ kind: 'repo', repoId: focusRepoId })
      : ''
  )
  const pickedTarget = parseTargetValue(picked)
  const repoIdChosen = implied ?? (pickedTarget?.kind === 'repo' ? pickedTarget.repoId : null)
  const repo = data?.repo ?? repos.find((r) => r.id === repoIdChosen)
  const asking = implied === null
  const projectId = project?.id ?? repo?.projectId

  // Subscribe via useShallow: tasksForProject() builds a fresh array each call,
  // and a selector that returns a new reference every render makes zustand v5's
  // useSyncExternalStore loop forever ("Maximum update depth exceeded").
  const allTasks = useStore(useShallow((s) => (projectId ? tasksForProject(s, projectId) : [])))
  // Only tasks without a Worktree can be linked (plus the prefill task itself),
  // and only those this repo can take: filed under it, or under no repo yet.
  const linkable = useMemo(() => {
    if (!repo) return { tagged: [] as Task[], untagged: [] as Task[] }
    const open = allTasks.filter((t) => !t.worktreeId || t.id === prefill?.id)
    const lane = (t: Task): string => (project ? taskLaneKey(t, project) : (t.repoId ?? PROJECT_LANE))
    return {
      tagged: open.filter((t) => lane(t) === repo.id),
      untagged: open.filter((t) => lane(t) === PROJECT_LANE)
    }
  }, [allTasks, prefill?.id, repo, project])
  const linkableCount = linkable.tagged.length + linkable.untagged.length

  // The branch suggested for a name: its slug behind the workspace's prefix
  // (Settings, Git). Main names a Worktree it is given no branch for the same way.
  const prefix = useSetting('worktreeBranchPrefix')
  const toBranch = (text: string): string => prefixedBranch(prefix, branchSlug(text))

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
  const repoId = repo?.id
  useEffect(() => {
    if (!repoId) return
    let alive = true
    void window.orbital.listBranches(repoId).then((r) => {
      if (alive) setInfo(r)
    })
    return () => {
      alive = false
    }
  }, [repoId])

  // Nothing to target — surface a clear message instead of a broken form.
  if (!repo && (!asking || targets.length === 0)) {
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
        <p className="text-[12.5px] text-text-3">Add a repo first, then create a Worktree on it.</p>
      </ModalShell>
    )
  }

  // The branch field tracks the name (slugified) until it is hand-edited.
  const onName = (value: string): void => {
    setName(value)
    if (!branchTouched) setBranch(toBranch(value))
  }

  // Picking another repo reloads its branches (the effect is keyed on it),
  // and the branch picks made for the old one no longer apply.
  const onPickTarget = (value: string): void => {
    setPicked(value)
    setExistingBranch('')
    setBaseRef('')
    setInfo({ branches: [], remotes: [], head: '' })
  }

  // Picking a task seeds the name (and derived branch) when it isn't set yet.
  const onPickTask = (taskId: string): void => {
    setLinkedTaskId(taskId)
    const task = [...linkable.tagged, ...linkable.untagged].find((t) => t.id === taskId)
    if (task && !name.trim()) onName(task.title)
  }

  // Picking a branch defaults the name from it (sans remote prefix) when empty.
  const onPickExisting = (value: string): void => {
    setExistingBranch(value)
    if (value && !name.trim()) setName(value.replace(/^[^/]+\//, ''))
  }

  const submit = async (): Promise<void> => {
    if (!repo) {
      setError('Pick a repo first.')
      return
    }
    const trimmedBranch = mode === 'new' ? branch.trim() : existingBranch
    if (!trimmedBranch) {
      setError(mode === 'new' ? 'Branch name is required.' : 'Pick a branch to open.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const worktree = await window.orbital.createWorktree(repo.id, {
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

  const multi = !!project && project.repoIds.length > 1
  const subtitle = multi
    ? `Creates a git worktree · ${project.name}${repo ? ` · ${repo.name}` : ''}`
    : `Creates a git worktree · ${repo?.name ?? project?.name ?? ''}`
  const repoById = new Map(repos.map((r) => [r.id, r]))

  return (
    <ModalShell
      title="New Worktree"
      subtitle={subtitle}
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
            disabled={busy || !repo || (mode === 'new' ? !branch.trim() : !existingBranch)}
          >
            Create Worktree
          </button>
        </>
      }
    >
      {asking && project && (
        <div className="mb-4">
          <label className={fieldLabel} htmlFor="nf-repo">
            Repo{' '}
            <span className="font-normal text-faint">
              ·{' '}
              {prefill
                ? `#${prefill.seq} has no repo, so pick where the work happens`
                : 'where the worktree is created'}
            </span>
          </label>
          <Select id="nf-repo" value={picked} onChange={onPickTarget} autoFocus={!picked}>
            <option value="">Pick a repo…</option>
            {/* A `project` target (#403) would render first as "Whole project",
                with the repos under an optgroup; v1 offers repos only. */}
            {targets.map((t) => {
              if (t.kind !== 'repo') return null
              const r = repoById.get(t.repoId)
              return (
                <option key={t.repoId} value={targetValue(t)}>
                  {r?.name ?? t.repoId}
                  {t.repoId === project.homeRepoId ? ' (home)' : ''}
                </option>
              )
            })}
          </Select>
          {prefill && (
            <div className="mt-1.5 text-[11px] text-faint">Starting it files #{prefill.seq} under that repo.</div>
          )}
        </div>
      )}

      {/* Everything below depends on the repo, so it waits for one. */}
      <fieldset disabled={!repo} className={`m-0 min-w-0 border-0 p-0 ${repo ? '' : 'opacity-50'}`}>
        <label className={fieldLabel} htmlFor="nf-name">
          Worktree name
        </label>
        <input
          id="nf-name"
          autoFocus={!asking || !!picked}
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={onEnter}
          placeholder="Login flow, Review PR 42…"
          className={`mt-1.5 ${inputBase}`}
        />

        {/* Two-way branch source. Shares SegmentedControl with the other one-of-N
            choices in the app, so it gets the same radio semantics and the same
            keyboard contract. It used to be hand-rolled `aria-pressed` toggles
            that only claimed to mirror that control. */}
        <SegmentedControl
          label="Branch source"
          options={BRANCH_SOURCES}
          value={mode}
          onChange={setMode}
          fill
          className="mt-4"
        />

        {mode === 'new' ? (
          <>
            <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-branch">
              Branch name{' '}
              <span className="font-normal text-faint">
                · generated from the name{prefix ? `, prefixed with ${prefix}` : ''}
              </span>
            </label>
            <input
              id="nf-branch"
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value)
                setBranchTouched(true)
              }}
              onKeyDown={onEnter}
              placeholder={prefix ? `${prefix}cli-flags` : 'feat/cli-flags'}
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

        {linkableCount > 0 && (
          <>
            <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-task">
              Link a task <span className="font-normal text-faint">· optional</span>
            </label>
            <Select id="nf-task" value={linkedTaskId} onChange={onPickTask}>
              <option value="">No linked task</option>
              {linkable.tagged.map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.seq} {t.title}
                </option>
              ))}
              {linkable.untagged.length > 0 &&
                (multi ? (
                  <optgroup label="No repo yet">
                    {linkable.untagged.map((t) => (
                      <option key={t.id} value={t.id}>
                        #{t.seq} {t.title}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  linkable.untagged.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.seq} {t.title}
                    </option>
                  ))
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

        {repo && (
          <div className="mt-2.5 flex items-center gap-2 text-[11px] text-dim">
            <FolderGit2 size={13} strokeWidth={1.5} className="flex-none text-faint" />
            <span className="truncate font-mono">{repo.repoPath}</span>
          </div>
        )}
      </fieldset>

      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
