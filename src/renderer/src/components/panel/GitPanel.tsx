import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  X
} from 'lucide-react'
import { useStore, activeWorktree, activeProject } from '@renderer/store'
import { ContextMenu, type MenuPos } from '../rail/menu'
import type { GitFileState, GitFileStatus, GitStatus } from '@shared/types'

/* Secondary button recipe (design guide: "// secondary"). */
const SECONDARY =
  'border border-line-2 rounded-[7px] text-[11.5px] font-semibold bg-hover text-text-2 ' +
  'hover:bg-panel-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-hover'

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/** Width of the branch-picker dropdown (anchored under the branch name). */
const PICKER_WIDTH = 232

/** The git operation currently in flight (one at a time), keyed for its spinner. */
type GitOp =
  | 'pull'
  | 'fetch'
  | 'push'
  | 'checkout'
  | 'commit'
  | 'stage'
  | 'unstage'
  | 'stageAll'
  | 'unstageAll'
  | 'discard'
  | 'discardAll'
  | 'refresh'

/** Strip Electron's IPC-rejection wrapper so the banner shows git's actual stderr. */
function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim()
}

/** Map a git file state to its single-letter badge + tint (M amber, A green, D red, ? muted). */
function stateBadge(state: GitFileState): { letter: string; className: string } {
  switch (state) {
    case 'added':
      return { letter: 'A', className: 'bg-green/15 text-green-2' }
    case 'deleted':
      return { letter: 'D', className: 'bg-red/15 text-red-2' }
    case 'renamed':
      return { letter: 'R', className: 'bg-amber/15 text-amber-2' }
    case 'copied':
      return { letter: 'C', className: 'bg-green/15 text-green-2' }
    case 'conflicted':
      return { letter: 'U', className: 'bg-red/15 text-red-2' }
    case 'untracked':
      return { letter: '?', className: 'bg-line-2 text-muted' }
    case 'modified':
    default:
      return { letter: 'M', className: 'bg-amber/15 text-amber-2' }
  }
}

/** Small square icon button used for row and section-header actions. */
function IconBtn({
  title,
  onClick,
  disabled,
  className,
  children
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex-none rounded p-0.5 ${FOCUS} disabled:cursor-not-allowed disabled:opacity-40 ${className ?? ''}`}
    >
      {children}
    </button>
  )
}

/**
 * One changed-file row. The path is a button that opens the file's diff in an
 * editor tab; stage/unstage + discard actions appear on hover. Discard is a
 * two-step confirm: the first click arms the row, a second (✓) executes.
 */
function GitFileRow({
  file,
  action,
  armed,
  disabled,
  onAction,
  onOpenDiff,
  onArm,
  onDiscard,
  onDisarm
}: {
  file: GitFileStatus
  action: 'stage' | 'unstage'
  armed: boolean
  disabled: boolean
  onAction: () => void
  onOpenDiff: () => void
  /** Absent on staged rows — unstage first, then discard. */
  onArm?: () => void
  onDiscard?: () => void
  onDisarm?: () => void
}): JSX.Element {
  const badge = stateBadge(file.state)
  const isStage = action === 'stage'
  const untracked = file.state === 'untracked'
  // The enclosing tree already conveys the folders, so the row shows just the
  // filename segment; the full path stays in the tooltip. (Git paths use '/'.)
  const name = file.path.split('/').pop() || file.path
  return (
    <div
      className={`group flex items-center gap-[9px] px-[7px] py-[5px] rounded-md ${
        armed ? 'bg-red/10' : 'hover:bg-hover'
      }`}
    >
      <span
        className={`flex-none size-[14px] rounded-[3px] flex items-center justify-center font-mono text-[9px] font-bold ${badge.className}`}
      >
        {badge.letter}
      </span>
      <button
        type="button"
        onClick={onOpenDiff}
        title={`Open diff — ${file.path}`}
        className={`flex-1 min-w-0 truncate rounded text-left font-mono text-[11.5px] text-text-2 hover:text-text ${FOCUS}`}
      >
        {name}
      </button>

      {armed ? (
        <span className="flex flex-none items-center gap-1">
          <span className="text-[10px] font-bold text-red-2">{untracked ? 'Delete?' : 'Discard?'}</span>
          <IconBtn title="Confirm" onClick={() => onDiscard?.()} disabled={disabled} className="text-red-2 hover:text-red">
            <Check size={14} strokeWidth={2} />
          </IconBtn>
          <IconBtn title="Cancel" onClick={() => onDisarm?.()} className="text-faint hover:text-text">
            <X size={14} strokeWidth={1.5} />
          </IconBtn>
        </span>
      ) : (
        <span className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {onArm && (
            <IconBtn
              title={untracked ? 'Delete file' : 'Discard changes'}
              onClick={onArm}
              disabled={disabled}
              className="text-faint hover:text-red-2"
            >
              <Undo2 size={13} strokeWidth={1.5} />
            </IconBtn>
          )}
          <IconBtn
            title={isStage ? 'Stage' : 'Unstage'}
            onClick={onAction}
            disabled={disabled}
            className={isStage ? 'text-accent hover:text-blue' : 'text-faint hover:text-text'}
          >
            {isStage ? <Plus size={14} strokeWidth={1.5} /> : <Minus size={14} strokeWidth={1.5} />}
          </IconBtn>
        </span>
      )}
    </div>
  )
}

/**
 * A node in the changed-files tree: either a directory (has `children`) or a
 * file leaf (has `file`). `name` is the short segment shown in the row; `path`
 * is the full repo-relative path, used as the stable key for expand/collapse.
 */
type TreeNode = {
  name: string
  path: string
  children?: TreeNode[]
  file?: GitFileStatus
}

/** Directories before files, each alphabetical. */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const aDir = a.children ? 0 : 1
    const bDir = b.children ? 0 : 1
    return aDir - bDir || a.name.localeCompare(b.name)
  })
  for (const n of nodes) if (n.children) sortNodes(n.children)
}

/**
 * Collapse chains of single-child directories into one node ("a/b/c" shown as a
 * single row), the way VS Code's Source Control tree does, then recurse.
 */
function collapseChains(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (!node.children) return node
    let cur = node
    while (cur.children!.length === 1 && cur.children![0].children) {
      const only = cur.children![0]
      cur = { name: `${cur.name}/${only.name}`, path: only.path, children: only.children }
    }
    cur.children = collapseChains(cur.children!)
    return cur
  })
}

/** Build a nested directory tree from a flat list of changed files. */
function buildFileTree(files: GitFileStatus[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/')
      let child = node.children!.find((c) => c.children && c.path === dirPath)
      if (!child) {
        child = { name: parts[i], path: dirPath, children: [] }
        node.children!.push(child)
      }
      node = child
    }
    node.children!.push({ name: parts[parts.length - 1], path: file.path, file })
  }
  sortNodes(root.children!)
  return collapseChains(root.children!)
}

/** Every file leaf under a node — a directory's descendants, or the leaf itself. */
function collectFiles(node: TreeNode): GitFileStatus[] {
  if (node.file) return [node.file]
  const out: GitFileStatus[] = []
  for (const child of node.children!) out.push(...collectFiles(child))
  return out
}

/**
 * Recursively render one tree node. File leaves defer to `renderLeaf` (the
 * unchanged `GitFileRow`); directory rows toggle a collapsed key on click and
 * carry hover-revealed folder actions from `renderDirActions` (applied to every
 * descendant file). `armedDir` marks the folder whose discard is awaiting
 * confirmation, tinting its row like an armed file. Indentation grows with depth.
 */
function TreeRow({
  node,
  depth,
  section,
  collapsed,
  armedDir,
  onToggle,
  renderLeaf,
  renderDirActions
}: {
  node: TreeNode
  depth: number
  section: 's' | 'u'
  collapsed: Set<string>
  /** Full path of the folder armed for discard (unstaged section only), else null. */
  armedDir: string | null
  onToggle: (key: string) => void
  renderLeaf: (file: GitFileStatus) => JSX.Element
  renderDirActions: (node: TreeNode) => ReactNode
}): JSX.Element {
  const indent = { paddingLeft: depth * 12 }

  if (node.file) {
    return <div style={indent}>{renderLeaf(node.file)}</div>
  }

  const key = `${section}:${node.path}`
  const open = !collapsed.has(key)
  const Chevron = open ? ChevronDown : ChevronRight
  const armed = armedDir === node.path
  return (
    <>
      <div
        style={indent}
        className={`group flex items-center gap-1 rounded-md pr-[7px] ${
          armed ? 'bg-red/10' : 'hover:bg-hover'
        }`}
      >
        <button
          type="button"
          onClick={() => onToggle(key)}
          title={node.path}
          className={`flex min-w-0 flex-1 items-center gap-1 rounded-md px-[7px] py-[4px] text-left ${FOCUS}`}
        >
          <Chevron size={13} strokeWidth={1.5} className="flex-none text-faint" />
          <span className="min-w-0 truncate font-mono text-[11.5px] text-faint">{node.name}</span>
        </button>
        {renderDirActions(node)}
      </div>
      {open &&
        node.children!.map((child) => (
          <TreeRow
            key={`${section}:${child.path}`}
            node={child}
            depth={depth + 1}
            section={section}
            collapsed={collapsed}
            armedDir={armedDir}
            onToggle={onToggle}
            renderLeaf={renderLeaf}
            renderDirActions={renderDirActions}
          />
        ))}
    </>
  )
}

/**
 * Git surface for the active Worktree: branch + ahead/behind + refresh, Pull /
 * Fetch / Worktree, staged & unstaged lists with stage/unstage/discard/compare
 * per file (plus stage-all / unstage-all / discard-all), and a commit area with
 * amend support. One operation runs at a time; failures surface in an error
 * banner instead of vanishing. Status reloads on Worktree change, after every
 * mutation, and whenever main broadcasts state (the git watcher's signal).
 */
export default function GitPanel(): JSX.Element {
  const worktree = useStore(activeWorktree)
  const project = useStore(activeProject)
  const openModal = useStore((s) => s.openModal)

  const [status, setStatus] = useState<GitStatus | null>(null)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [busy, setBusy] = useState<GitOp | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Discard confirmation target: a file path, or '*' for discard-all. */
  const [armed, setArmed] = useState<string | null>(null)
  /** Collapsed directory nodes, keyed `s:`/`u:` + full dir path (default expanded = absent). */
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  /** Branch picker (root Worktree only): anchor position when open, branch list, draft name. */
  const [pickerPos, setPickerPos] = useState<MenuPos | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [newBranch, setNewBranch] = useState('')

  const worktreeId = worktree?.id ?? null

  const refresh = useCallback(async (): Promise<void> => {
    if (!worktreeId) {
      setStatus(null)
      return
    }
    try {
      setStatus(await window.orbital.gitStatus(worktreeId))
    } catch {
      setStatus(null)
    }
  }, [worktreeId])

  // Load on mount and whenever the active Worktree changes.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // External git activity (commits from a terminal, checkouts, agent edits)
  // triggers a state broadcast via the main-process git watcher — re-read status.
  useEffect(() => window.orbital.onStateChanged(() => void refresh()), [refresh])

  // Draft message / amend / confirmations / picker are per-Worktree state; drop them on switch.
  useEffect(() => {
    setMessage('')
    setAmend(false)
    setArmed(null)
    setError(null)
    setPickerPos(null)
    setCollapsedDirs(new Set())
  }, [worktreeId])

  const toggleDir = useCallback((key: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // An armed discard disarms itself if not confirmed promptly.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 4000)
    return () => clearTimeout(t)
  }, [armed])

  if (!worktree) {
    return (
      <div className="border-b border-soft px-[15px] py-4">
        <span className="text-[11px] tracking-[0.9px] uppercase text-muted font-bold">Git</span>
        <div className="mt-2 text-[12px] text-faint">No Worktree</div>
      </div>
    )
  }

  const staged = status?.staged ?? []
  const unstaged = status?.unstaged ?? []
  const stagedTree = buildFileTree(staged)
  const unstagedTree = buildFileTree(unstaged)
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const branch = status?.branch ?? worktree.branch
  // Only the root checkout may move HEAD — linked Worktrees are pinned to their branch.
  const isRoot = worktree.kind === 'root'

  /** Run one git operation with busy/error bookkeeping, then re-read status. */
  const exec = async (op: GitOp, fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(op)
    setError(null)
    setArmed(null)
    try {
      await fn()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(null)
    }
    await refresh()
  }

  /** Apply a per-file git op to a folder's descendants in order, as one operation. */
  const forEachFile = (
    files: GitFileStatus[],
    op: (path: string) => Promise<void>
  ): Promise<void> => files.reduce((p, f) => p.then(() => op(f.path)), Promise.resolve())

  /** Open (or re-focus) an editor tab showing this file's staged/unstaged diff. */
  const openDiff = (f: GitFileStatus): void => {
    for (const pane of worktree.panes) {
      const existing = pane.tabs.find(
        (t) => t.type === 'editor' && t.config.filePath === f.path && !!t.config.diffStaged === f.staged
      )
      if (existing) {
        void window.orbital.setActiveTab(pane.id, existing.id)
        return
      }
    }
    void window.orbital.createTab(worktree.id, null, 'editor', { filePath: f.path, diffStaged: f.staged })
  }

  /** Anchor the branch picker under the branch button and (re)load the local branch list. */
  const openPicker = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setPickerPos({ x: Math.min(r.left, window.innerWidth - PICKER_WIDTH - 12), y: r.bottom + 4 })
    setNewBranch('')
    if (project) {
      void window.orbital.listBranches(project.id).then((info) => setBranches(info.branches))
    }
  }

  /** Switch to (or create-and-switch to) a branch; failures land in the error banner. */
  const checkoutBranch = (target: string, create: boolean): void => {
    setPickerPos(null)
    if (!create && target === branch) return
    void exec('checkout', () => window.orbital.gitCheckout(worktree.id, target, create))
  }

  const commit = (): void => {
    const msg = message.trim()
    if (!msg || (staged.length === 0 && !amend)) return
    void exec('commit', async () => {
      await window.orbital.gitCommit(worktree.id, msg, amend)
      setMessage('')
      setAmend(false)
    })
  }

  const toggleAmend = async (): Promise<void> => {
    const next = !amend
    setAmend(next)
    // Amending with an empty box almost always means "reuse the last message".
    if (next && !message.trim()) {
      const last = await window.orbital.gitLastCommitMessage(worktree.id).catch(() => '')
      if (last) setMessage(last)
    }
  }

  const commitDisabled = !!busy || !message.trim() || (staged.length === 0 && !amend)

  const spinner = <Loader2 size={12} strokeWidth={2} className="flex-none animate-spin" />

  // Hover-revealed folder action span shared by both sections; mirrors the file
  // row's action strip (same wrapper opacity + focus behaviour).
  const dirActions = (children: ReactNode): JSX.Element => (
    <span className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      {children}
    </span>
  )

  /** Unstage every file under a staged folder. */
  const renderStagedDirActions = (node: TreeNode): ReactNode => {
    const files = collectFiles(node)
    return dirActions(
      <IconBtn
        title="Unstage folder"
        onClick={() =>
          void exec('unstage', () => forEachFile(files, (p) => window.orbital.gitUnstage(worktree.id, p)))
        }
        disabled={!!busy}
        className="text-faint hover:text-text"
      >
        <Minus size={14} strokeWidth={1.5} />
      </IconBtn>
    )
  }

  /** Stage every file under a changed folder, or discard them all (armed confirm). */
  const renderUnstagedDirActions = (node: TreeNode): ReactNode => {
    const files = collectFiles(node)
    if (armed === node.path) {
      return (
        <span className="flex flex-none items-center gap-1">
          <span className="text-[10px] font-bold text-red-2">Discard {files.length}?</span>
          <IconBtn
            title={`Confirm — discard changes in ${files.length} file${files.length === 1 ? '' : 's'}`}
            onClick={() =>
              void exec('discard', () => forEachFile(files, (p) => window.orbital.gitDiscard(worktree.id, p)))
            }
            disabled={!!busy}
            className="text-red-2 hover:text-red"
          >
            <Check size={14} strokeWidth={2} />
          </IconBtn>
          <IconBtn title="Cancel" onClick={() => setArmed(null)} className="text-faint hover:text-text">
            <X size={14} strokeWidth={1.5} />
          </IconBtn>
        </span>
      )
    }
    return dirActions(
      <>
        <IconBtn
          title="Discard folder"
          onClick={() => setArmed(node.path)}
          disabled={!!busy}
          className="text-faint hover:text-red-2"
        >
          <Undo2 size={13} strokeWidth={1.5} />
        </IconBtn>
        <IconBtn
          title="Stage folder"
          onClick={() =>
            void exec('stage', () => forEachFile(files, (p) => window.orbital.gitStage(worktree.id, p)))
          }
          disabled={!!busy}
          className="text-accent hover:text-blue"
        >
          <Plus size={14} strokeWidth={1.5} />
        </IconBtn>
      </>
    )
  }

  return (
    <div className="border-b border-soft">
      {/* header: label + branch + ahead/behind + refresh */}
      <div className="flex items-center justify-between px-[15px] pt-[13px] pb-[11px]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] tracking-[0.9px] uppercase text-muted font-bold">Git</span>
          {isRoot ? (
            <button
              type="button"
              onClick={openPicker}
              disabled={!!busy}
              title={`Switch branch — ${branch}`}
              className={`flex items-center gap-1 rounded font-mono text-[11px] text-accent min-w-0 hover:text-blue disabled:cursor-not-allowed ${FOCUS}`}
            >
              <GitBranch size={12} strokeWidth={1.5} className="flex-none" />
              <span className="truncate">{branch}</span>
              {busy === 'checkout' ? (
                <Loader2 size={11} strokeWidth={2} className="flex-none animate-spin" />
              ) : (
                <ChevronDown size={11} strokeWidth={1.5} className="flex-none text-faint" />
              )}
            </button>
          ) : (
            <span className="flex items-center gap-1 font-mono text-[11px] text-accent min-w-0">
              <GitBranch size={12} strokeWidth={1.5} className="flex-none" />
              <span className="truncate" title={branch}>
                {branch}
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] flex-none">
          <span className={ahead > 0 ? 'text-green-2' : 'text-faint'} title="Commits ahead of upstream">
            ↑{ahead}
          </span>
          <span className={behind > 0 ? 'text-amber-2' : 'text-faint'} title="Commits behind upstream">
            ↓{behind}
          </span>
          <IconBtn
            title="Refresh status"
            onClick={() => void exec('refresh', () => Promise.resolve())}
            disabled={!!busy}
            className="text-faint hover:text-text-2"
          >
            <RefreshCw size={12} strokeWidth={1.5} className={busy === 'refresh' ? 'animate-spin' : ''} />
          </IconBtn>
        </div>
      </div>

      {/* branch picker: local branches + create-and-switch (root Worktree only) */}
      {pickerPos && (
        <ContextMenu pos={pickerPos} width={PICKER_WIDTH} onClose={() => setPickerPos(null)}>
          <div className="max-h-56 overflow-y-auto">
            {branches.length === 0 && <div className="px-2 py-1.5 text-[11px] text-faint">No local branches</div>}
            {branches.map((b) => (
              <button
                key={b}
                type="button"
                role="menuitem"
                onClick={() => checkoutBranch(b, false)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  b === branch ? 'text-accent' : 'text-text-2'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{b}</span>
                {b === branch && <Check size={12} strokeWidth={2} className="flex-none" />}
              </button>
            ))}
          </div>
          <div className="mt-1 flex gap-1.5 border-t border-line-2 px-1 pb-1 pt-1.5">
            <input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newBranch.trim()) checkoutBranch(newBranch.trim(), true)
              }}
              placeholder="New branch…"
              className={`min-w-0 flex-1 rounded-md border border-line-2 bg-bg px-2 py-1 font-mono text-[11px] text-text placeholder:text-faint ${FOCUS}`}
            />
            <button
              type="button"
              disabled={!newBranch.trim()}
              onClick={() => checkoutBranch(newBranch.trim(), true)}
              title="Create the branch and switch to it"
              className={`flex-none px-2 py-1 ${SECONDARY}`}
            >
              Create
            </button>
          </div>
        </ContextMenu>
      )}

      {/* actions */}
      <div className="flex gap-[7px] px-[15px] pb-3">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void exec('pull', () => window.orbital.gitPull(worktree.id))}
          className={`flex-1 py-[7px] inline-flex items-center justify-center gap-1.5 ${SECONDARY}`}
        >
          {busy === 'pull' && spinner}
          Pull{behind > 0 ? ` ↓${behind}` : ''}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void exec('fetch', () => window.orbital.gitFetch(worktree.id))}
          className={`flex-1 py-[7px] inline-flex items-center justify-center gap-1.5 ${SECONDARY}`}
        >
          {busy === 'fetch' && spinner}
          Fetch
        </button>
        <button
          type="button"
          onClick={() => openModal('newWorktree', { project })}
          className={`flex-1 py-[7px] inline-flex items-center justify-center gap-1 ${SECONDARY}`}
        >
          <Plus size={13} strokeWidth={1.5} />
          Worktree
        </button>
      </div>

      {/* error banner */}
      {error && (
        <div className="mx-[15px] mb-2 flex items-start gap-2 rounded-[7px] border border-red/25 bg-red/10 px-2.5 py-2">
          <span className="allow-select min-w-0 flex-1 break-words font-mono text-[10.5px] leading-snug text-red-2">
            {error}
          </span>
          <IconBtn title="Dismiss" onClick={() => setError(null)} className="text-red-2/70 hover:text-red-2">
            <X size={12} strokeWidth={1.5} />
          </IconBtn>
        </div>
      )}

      {/* staged */}
      <div className="px-[15px]">
        <div className="flex items-center justify-between pt-[7px] pb-[6px]">
          <span className="text-[10.5px] tracking-[0.5px] uppercase text-faint font-bold">Staged</span>
          <div className="flex items-center gap-1.5">
            {staged.length > 0 && (
              <IconBtn
                title="Unstage all"
                onClick={() => void exec('unstageAll', () => window.orbital.gitUnstageAll(worktree.id))}
                disabled={!!busy}
                className="text-faint hover:text-text"
              >
                <Minus size={13} strokeWidth={1.5} />
              </IconBtn>
            )}
            <span className="font-mono text-[10.5px] text-green-2">{staged.length}</span>
          </div>
        </div>
        {staged.length === 0 ? (
          <div className="px-[7px] pb-1 text-[11px] text-faint">No staged changes</div>
        ) : (
          stagedTree.map((node) => (
            <TreeRow
              key={`s:${node.path}`}
              node={node}
              depth={0}
              section="s"
              collapsed={collapsedDirs}
              armedDir={null}
              onToggle={toggleDir}
              renderDirActions={renderStagedDirActions}
              renderLeaf={(f) => (
                <GitFileRow
                  file={f}
                  action="unstage"
                  armed={false}
                  disabled={!!busy}
                  onAction={() => void exec('unstage', () => window.orbital.gitUnstage(worktree.id, f.path))}
                  onOpenDiff={() => openDiff(f)}
                />
              )}
            />
          ))
        )}
      </div>

      {/* unstaged */}
      <div className="px-[15px] pb-1">
        <div className="flex items-center justify-between pt-[9px] pb-[6px]">
          <span className="text-[10.5px] tracking-[0.5px] uppercase text-faint font-bold">Changes</span>
          <div className="flex items-center gap-1.5">
            {unstaged.length > 0 &&
              (armed === '*' ? (
                <>
                  <span className="text-[10px] font-bold text-red-2">Discard all?</span>
                  <IconBtn
                    title="Confirm — discard all changes and delete untracked files"
                    onClick={() => void exec('discardAll', () => window.orbital.gitDiscardAll(worktree.id))}
                    disabled={!!busy}
                    className="text-red-2 hover:text-red"
                  >
                    <Check size={14} strokeWidth={2} />
                  </IconBtn>
                  <IconBtn title="Cancel" onClick={() => setArmed(null)} className="text-faint hover:text-text">
                    <X size={14} strokeWidth={1.5} />
                  </IconBtn>
                </>
              ) : (
                <>
                  <IconBtn
                    title="Discard all changes"
                    onClick={() => setArmed('*')}
                    disabled={!!busy}
                    className="text-faint hover:text-red-2"
                  >
                    <Undo2 size={13} strokeWidth={1.5} />
                  </IconBtn>
                  <IconBtn
                    title="Stage all"
                    onClick={() => void exec('stageAll', () => window.orbital.gitStageAll(worktree.id))}
                    disabled={!!busy}
                    className="text-faint hover:text-accent"
                  >
                    <Plus size={13} strokeWidth={1.5} />
                  </IconBtn>
                </>
              ))}
            <span className="font-mono text-[10.5px] text-amber-2">{unstaged.length}</span>
          </div>
        </div>
        {unstaged.length === 0 ? (
          <div className="px-[7px] pb-1 text-[11px] text-faint">Working tree clean</div>
        ) : (
          unstagedTree.map((node) => (
            <TreeRow
              key={`u:${node.path}`}
              node={node}
              depth={0}
              section="u"
              collapsed={collapsedDirs}
              armedDir={armed}
              onToggle={toggleDir}
              renderDirActions={renderUnstagedDirActions}
              renderLeaf={(f) => (
                <GitFileRow
                  file={f}
                  action="stage"
                  armed={armed === f.path}
                  disabled={!!busy}
                  onAction={() => void exec('stage', () => window.orbital.gitStage(worktree.id, f.path))}
                  onOpenDiff={() => openDiff(f)}
                  onArm={() => setArmed(f.path)}
                  onDiscard={() => void exec('discard', () => window.orbital.gitDiscard(worktree.id, f.path))}
                  onDisarm={() => setArmed(null)}
                />
              )}
            />
          ))
        )}
      </div>

      {/* commit */}
      <div className="px-[15px] pt-2 pb-[14px]">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={amend ? 'Amended commit message…' : 'Commit message…'}
          rows={2}
          className="allow-select w-full resize-none px-[11px] py-[9px] rounded-btn bg-bg border border-line-2 text-[12px] text-text leading-snug placeholder:text-faint outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        />
        <label className="mt-1.5 flex w-fit cursor-pointer select-none items-center gap-1.5 text-[11px] text-text-3 hover:text-text-2">
          <input
            type="checkbox"
            checked={amend}
            onChange={() => void toggleAmend()}
            className="size-3 accent-accent"
          />
          Amend last commit
        </label>
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            onClick={commit}
            disabled={commitDisabled}
            title="Ctrl+Enter"
            className="flex-1 py-[9px] inline-flex items-center justify-center gap-1.5 rounded-btn bg-accent text-[12.5px] font-bold text-on-accent hover:bg-accent-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent"
          >
            {busy === 'commit' && spinner}
            {amend ? 'Amend' : 'Commit'}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void exec('push', () => window.orbital.gitPush(worktree.id))}
            className={`flex-none px-4 py-[9px] inline-flex items-center justify-center gap-1.5 rounded-btn ${SECONDARY}`}
          >
            {busy === 'push' && spinner}
            Push ↑{ahead}
          </button>
        </div>
      </div>
    </div>
  )
}
