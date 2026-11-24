import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleOff,
  FolderInput,
  FolderOpen,
  House,
  Layers,
  ListMinus,
  Pencil,
  Plus,
  Terminal,
  Trash2
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStatus, type Project, type Repo as RepoModel, type TerminalStatus } from '@shared/types'
import { useStore } from '@renderer/store'
import { StatusDot, worktreeStatusLabel, worktreeStatusTextClass } from '@renderer/lib/status'
import { BranchStub, DOT_CELL, WorktreeBranches } from './treeLines'
import { ContextMenu, MenuItem, MenuConfirm, clampMenuPos, type MenuPos } from './menu'
import { beginRailDrag, dissolvesOnLeave, placeOf, projectRowById, repoPathLabel, type RailAction } from './folders'
import { FolderStep, NewFolderStep, ProjectStep } from './menuSteps'
import {
  currentRailRows,
  dissolveConfirm,
  folderSessionOf,
  makeHome,
  needsYouLabel,
  ptyCount,
  runRailAction,
  type DissolveConfirm
} from './railActions'
import { fireAndForget } from '@renderer/lib/bridge'
import { fileManagerName } from '@renderer/lib/platform'

/**
 * What the context menu is showing: its items, or one of the steps that swap in
 * place of them (see ./menu). `move` is the folder picker (the rail's folders
 * for a flat row, its project's own for a member) and `newFolder` the name
 * prompt it leads to; `project` is the Move to Project picker; `confirm`
 * holds a move that would close a folder session with terminals open.
 */
type MenuStep =
  | { kind: 'items' }
  | { kind: 'confirmRemove' }
  | { kind: 'move' }
  | { kind: 'newFolder' }
  | { kind: 'project' }
  | { kind: 'confirm'; action: RailAction; confirm: DissolveConfirm }
  | { kind: 'confirmHome'; terminals: number }

/**
 * The expand/collapse chevron, carrying what the hidden Worktrees add up to.
 *
 * It is the control that hides them, so it is the right place to say what is
 * behind it — and a far quieter place than the repo's own status dot, which
 * used to do this job and in doing so claimed the repo itself was working
 * when it was one linked Worktree that was.
 *
 * Tinted in the app's status vocabulary (lib/status.tsx), and pulsing only
 * while COLLAPSED and only for the two states that are asking for a person.
 * Expanded, every child row already shows its own dot; a second animation over
 * the top of them is noise, and the tint alone still summarises the group.
 */
export function GroupChevron({ expanded, status }: { expanded: boolean; status: TerminalStatus }): JSX.Element {
  const Chevron = expanded ? ChevronDown : ChevronRight
  const idleTint = expanded ? 'text-muted' : 'text-faint'
  const tint = status === 'idle' ? idleTint : worktreeStatusTextClass(status)
  const pulse = !expanded && (status === 'needs_attention' || status === 'error') ? 'animate-pulse' : ''
  return <Chevron size={14} strokeWidth={1.5} className={`${tint} ${pulse}`} />
}

/** The amber needs-you pill a collapsed row carries for what it hides. */
export function NeedsYouPill({ count }: { count: number }): JSX.Element {
  const label = needsYouLabel(count)
  return (
    <span
      title={label}
      aria-label={label}
      className="inline-flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-amber/15 px-[5px] font-mono text-[10px] font-bold text-amber-2"
    >
      {count}
    </span>
  )
}

/**
 * A repo header in the rail. The header row IS the root Worktree:
 * clicking it selects the repo's root Worktree directly. Linked Worktrees
 * live in the collapsible list below — the chevron only renders when there
 * are any.
 *
 * Two variants, which differ in the subline, the menu and what the drag means
 * and nothing else:
 *
 * - `flat`: a one-repo project with no home, drawn as the repo. It files and
 *   reorders as its project, and joins another project as a repo; dropping a
 *   repo on its middle starts a project with it.
 * - `member`: one of a group's repos. Its path reads relative to the
 *   project's root, it reorders among the members, and dragged out it
 *   detaches into a project of its own.
 *
 * The Rail owns every drop; `joinTarget` says a dragged repo would start a
 * project with this flat row.
 */
export default function Repo({
  repo,
  project: projectProp,
  variant = 'flat',
  joinTarget = false
}: {
  repo: RepoModel
  /** Its project. Looked up from the store when not given. */
  project?: Project
  variant?: 'flat' | 'member'
  joinTarget?: boolean
}): JSX.Element {
  const storedProject = useStore((s) => s.projects.find((p) => p.id === repo.projectId))
  const project = projectProp ?? storedProject
  const worktrees = useStore(useShallow((s) => s.worktrees.filter((w) => w.repoId === repo.id)))
  const expanded = useStore((s) => !!s.expanded[repo.id])
  const isActive = useStore((s) => s.activeRepoId === repo.id)
  const activeWorktreeId = useStore((s) => s.activeWorktreeId)
  const setActiveRepo = useStore((s) => s.setActiveRepo)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const setExpanded = useStore((s) => s.setExpanded)
  const openModal = useStore((s) => s.openModal)
  const member = variant === 'member'
  const root = worktrees.find((w) => w.kind === 'root')
  const linked = worktrees.filter((w) => w.kind === 'linked')
  const rootActive = !!root && activeWorktreeId === root.id
  // The header row IS the root Worktree, so its dot is the ROOT's status and
  // nothing else. Rolling every Worktree in the repo into it meant a single
  // agent working in one linked Worktree painted two spinners down the rail —
  // one on the row that was working and one on a row that was not — which reads
  // as two things running rather than one thing, in there.
  const rootStatus = root?.status ?? 'idle'
  // What the collapsed children add up to. This is what the chevron carries:
  // it is the control that hides them, so it is the right place to say what is
  // behind it. Same precedence rule as everywhere else (PRD §5), which does
  // mean a lone 'done' beside an idle sibling reads as idle — that is the
  // app's one aggregation rule, not a decision this row gets to relitigate.
  const linkedStatus = aggregateStatus(linked.map((w) => w.status))
  // Linked only, for the same reason as the dot: a root that needs you already
  // says so in its own dot, and a badge counting it too would double-report it.
  const needsAttention = linked.filter((w) => w.status === 'needs_attention').length

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [step, setStep] = useState<MenuStep>({ kind: 'items' })
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(repo.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const closeMenu = (): void => {
    setMenu(null)
    setStep({ kind: 'items' })
  }

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setStep({ kind: 'items' })
    setMenu(clampMenuPos(e, 210, 300))
  }

  /** Run a move, confirming first when it would close a folder session that has terminals open. */
  const pick = (action: RailAction): void => {
    const confirm = dissolveConfirm(action)
    if (confirm) {
      setStep({ kind: 'confirm', action, confirm })
      return
    }
    runRailAction(action)
    closeMenu()
  }

  // Out of its project, it lands as its own row just below the project.
  const removeFromProject = (): void => {
    if (!project) return
    const rows = currentRailRows()
    const at = placeOf(rows, 'project', project.id)
    pick({
      op: 'detachRepo',
      repoId: repo.id,
      folderId: at?.folderId ?? null,
      beforeId: at?.ids[at.index + 1] ?? null,
      dissolves: dissolvesOnLeave(projectRowById(rows, project.id))
    })
  }

  // Making a member the home closes the folder session; say so when that
  // takes terminals with it. A flat row has no folder session to close.
  const makeHomeRepo = (): void => {
    if (!project) return
    const terminals = ptyCount(folderSessionOf(useStore.getState().worktrees, project.id))
    if (terminals > 0) {
      setStep({ kind: 'confirmHome', terminals })
      return
    }
    makeHome(project.id, repo.id)
    closeMenu()
  }

  const startRename = (): void => {
    setDraft(repo.name)
    setRenaming(true)
    closeMenu()
  }
  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (name && name !== repo.name) void window.orbital.renameRepo(repo.id, name)
  }
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setRenaming(false)
    }
  }

  const activate = (): void => setActiveRepo(repo.id)
  const onHeaderKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (renaming || e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate()
    } else if (linked.length > 0 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      setExpanded(repo.id, e.key === 'ArrowRight')
    }
  }

  const pathLabel = member && project ? repoPathLabel(repo.repoPath, project.rootPath) : repo.repoPath
  const projectName = project?.name ?? ''
  // What "Move to Folder" files: a flat row is its project, among the rail's
  // folders; a member is the repo, among its project's own.
  const filed = member ? ({ kind: 'repo', id: repo.id } as const) : ({ kind: 'project', id: repo.projectId } as const)

  return (
    // The data attribute is how the Rail tells what a drag is over: a flat
    // row is its project, a member row is a repo inside one.
    <div {...(member ? { 'data-repo-id': repo.id } : { 'data-project-id': repo.projectId })} className="mb-1">
      <div
        role="button"
        tabIndex={0}
        title={member ? repo.repoPath : undefined}
        aria-current={rootActive ? 'true' : undefined}
        onClick={() => !renaming && activate()}
        onKeyDown={onHeaderKey}
        onContextMenu={openMenu}
        draggable={!renaming}
        onDragStart={(e) => beginRailDrag(e, { kind: 'repo', id: repo.id })}
        className={`group flex cursor-pointer items-center gap-2 rounded-[8px] px-[9px] py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          joinTarget
            ? 'bg-accent/10 ring-1 ring-inset ring-accent/50'
            : rootActive
              ? 'bg-panel-2'
              : isActive
                ? 'bg-hover'
                : 'hover:bg-hover'
        }`}
      >
        {linked.length > 0 ? (
          <button
            type="button"
            // The tint is a colour, and colour alone is not a status. The label
            // is where a screen reader (and the tooltip) gets the same news.
            aria-label={`${expanded ? 'Collapse' : 'Expand'} repo${
              linkedStatus === 'idle' ? '' : ` — worktrees ${worktreeStatusLabel(linkedStatus)}`
            }`}
            aria-expanded={expanded}
            title={linkedStatus === 'idle' ? undefined : `Worktrees ${worktreeStatusLabel(linkedStatus)}`}
            onClick={(e) => {
              e.stopPropagation()
              toggleExpanded(repo.id)
            }}
            className="flex flex-none items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <GroupChevron expanded={expanded} status={linkedStatus} />
          </button>
        ) : (
          <span className="w-[14px] flex-none" />
        )}

        <span title={worktreeStatusLabel(rootStatus)} className={DOT_CELL}>
          <StatusDot status={rootStatus} />
          {expanded && linked.length > 0 && <BranchStub />}
        </span>

        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              ref={inputRef}
              value={draft}
              aria-label="Repo name"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              className="allow-select w-full rounded border border-accent/60 bg-bg px-1 py-0.5 text-[13.5px] font-bold text-text outline-none"
            />
          ) : (
            <div className={`truncate text-[13.5px] font-bold ${isActive ? 'text-text' : 'text-text-2'}`}>
              {repo.name}
            </div>
          )}
          {joinTarget ? (
            // The one drop that makes something new says so.
            <div className="mt-px truncate font-mono text-[10.5px] text-accent">Drop to start a project</div>
          ) : (
            <div className="mt-px truncate font-mono text-[10.5px] text-faint">
              {root ? `${root.branch} · ` : ''}
              {pathLabel}
            </div>
          )}
        </div>

        {!renaming && (
          <button
            type="button"
            aria-label="New Worktree"
            title="New Worktree"
            onClick={(e) => {
              e.stopPropagation()
              openModal('newWorktree', { repo })
            }}
            className="flex size-5 flex-none items-center justify-center rounded-[6px] text-faint opacity-0 outline-none hover:bg-hover hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100"
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        )}

        {!renaming && needsAttention > 0 && <NeedsYouPill count={needsAttention} />}
      </div>

      {expanded && linked.length > 0 && (
        <WorktreeBranches worktrees={linked} label={`Worktrees of ${repo.name}`}>
          <button
            type="button"
            onClick={() => openModal('newWorktree', { repo })}
            className="mt-px flex items-center gap-[7px] rounded px-[9px] py-[6px] text-left text-[11.5px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Plus size={13} strokeWidth={1.5} className="flex-none" />
            <span>New Worktree</span>
          </button>
        </WorktreeBranches>
      )}

      {menu && (
        <ContextMenu pos={menu} width={210} onClose={closeMenu}>
          {step.kind === 'items' && (
            <>
              <MenuItem icon={<Pencil size={13} strokeWidth={1.5} />} label="Rename" onClick={startRename} />
              <MenuItem
                icon={<FolderInput size={13} strokeWidth={1.5} />}
                label="Move to Folder"
                onClick={() => setStep({ kind: 'move' })}
              />
              {!member && project && (
                <>
                  <MenuItem
                    icon={<Layers size={13} strokeWidth={1.5} />}
                    label="Move to Project"
                    onClick={() => setStep({ kind: 'project' })}
                  />
                  <MenuItem
                    icon={<House size={13} strokeWidth={1.5} />}
                    label="Make Home Repo"
                    onClick={makeHomeRepo}
                  />
                </>
              )}
              <MenuItem
                icon={<Plus size={13} strokeWidth={1.5} />}
                label="New Worktree"
                onClick={() => {
                  openModal('newWorktree', { repo })
                  closeMenu()
                }}
              />
              {member && project && (
                <>
                  <div className="my-1 h-px bg-soft" />
                  <MenuItem
                    icon={<House size={13} strokeWidth={1.5} />}
                    label="Make Home Repo"
                    onClick={makeHomeRepo}
                  />
                  <MenuItem
                    icon={<Layers size={13} strokeWidth={1.5} />}
                    label="Move to Project"
                    onClick={() => setStep({ kind: 'project' })}
                  />
                  <MenuItem
                    icon={<ListMinus size={13} strokeWidth={1.5} />}
                    label="Remove from Project"
                    onClick={removeFromProject}
                  />
                  <div className="my-1 h-px bg-soft" />
                </>
              )}
              {/* Clear Status acts on a Worktree row, so it can only appear when
                  there is one. */}
              {root && (
                <MenuItem
                  icon={<CircleOff size={13} strokeWidth={1.5} />}
                  label="Clear Status"
                  onClick={() => {
                    void window.orbital.clearWorktreeStatus(root.id)
                    closeMenu()
                  }}
                />
              )}
              {/* The two OS hand-offs are NOT behind that guard, and must not be.
                  A repo's root Worktree row is created by
                  `reconcileRepoWorktrees`, which gives up without writing any
                  rows when `git worktree list` fails — a path that is not a git
                  repo, or has gone unreadable, never gets one. That state is
                  permanent, and it is exactly when a user wants to open the
                  folder and find out why, so hiding both items there would take
                  the tools away at the moment they are needed.

                  They still don't send a path over the bridge: these two name
                  the REPO and main reads its own stored `repoPath`, the same
                  provenance as the Worktree path the `(worktreeId, path)` calls
                  resolve against. What is not coming back is the renderer
                  handing main an absolute path to open. */}
              <MenuItem
                icon={<FolderOpen size={13} strokeWidth={1.5} />}
                label={`Open in ${fileManagerName}`}
                onClick={() => {
                  fireAndForget(window.orbital.openRepoPath(repo.id))
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<Terminal size={13} strokeWidth={1.5} />}
                label="Open in External Terminal"
                onClick={() => {
                  fireAndForget(window.orbital.openRepoInTerminal(repo.id))
                  closeMenu()
                }}
              />
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<Trash2 size={13} strokeWidth={1.5} />}
                label="Remove repo"
                danger
                onClick={() => setStep({ kind: 'confirmRemove' })}
              />
            </>
          )}

          {step.kind === 'move' && (
            <FolderStep
              name={repo.name}
              item={filed}
              onNewFolder={() => setStep({ kind: 'newFolder' })}
              onDone={closeMenu}
            />
          )}

          {step.kind === 'newFolder' && <NewFolderStep name={repo.name} item={filed} onDone={closeMenu} />}

          {step.kind === 'project' && project && <ProjectStep repo={repo} project={project} onPick={pick} />}

          {step.kind === 'confirm' && (
            <MenuConfirm
              message={step.confirm.message}
              hint={step.confirm.hint}
              confirmLabel={step.confirm.confirmLabel}
              danger={false}
              onConfirm={() => {
                runRailAction(step.action)
                closeMenu()
              }}
              onCancel={closeMenu}
            />
          )}

          {step.kind === 'confirmHome' && project && (
            <MenuConfirm
              message={`Make ${repo.name} the home repo of "${projectName}"?`}
              hint={`The project session moves into ${repo.name}. ${
                step.terminals === 1
                  ? 'The 1 terminal open in the folder session closes.'
                  : `The ${step.terminals} terminals open in the folder session close.`
              }`}
              confirmLabel="Make Home"
              danger={false}
              onConfirm={() => {
                makeHome(project.id, repo.id)
                closeMenu()
              }}
              onCancel={closeMenu}
            />
          )}

          {step.kind === 'confirmRemove' && (
            <MenuConfirm
              message={`Remove "${repo.name}" from Orbital?`}
              hint="The repo and its worktrees stay on disk; open terminals close."
              confirmLabel="Remove"
              danger={false}
              onConfirm={() => {
                void window.orbital.removeRepo(repo.id)
                closeMenu()
              }}
              onCancel={closeMenu}
            />
          )}
        </ContextMenu>
      )}
    </div>
  )
}
