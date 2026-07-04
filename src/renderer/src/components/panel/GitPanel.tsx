import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react'
import { Check, GitBranch, Loader2, Minus, Plus, RefreshCw, Undo2, X } from 'lucide-react'
import { useStore, activeFlight, activeWorkspace } from '@renderer/store'
import type { GitFileState, GitFileStatus, GitStatus } from '@shared/types'

/* Secondary button recipe (design guide: "// secondary"). */
const SECONDARY =
  'border border-line-2 rounded-[7px] text-[11.5px] font-semibold bg-hover text-text-2 ' +
  'hover:bg-panel-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-hover'

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/** The git operation currently in flight (one at a time), keyed for its spinner. */
type GitOp =
  | 'pull'
  | 'fetch'
  | 'push'
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
      return { letter: '?', className: 'bg-white/[0.06] text-muted' }
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
        {file.path}
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
 * Git surface for the active Flight: branch + ahead/behind + refresh, Pull /
 * Fetch / Worktree, staged & unstaged lists with stage/unstage/discard/compare
 * per file (plus stage-all / unstage-all / discard-all), and a commit area with
 * amend support. One operation runs at a time; failures surface in an error
 * banner instead of vanishing. Status reloads on Flight change, after every
 * mutation, and whenever main broadcasts state (the git watcher's signal).
 */
export default function GitPanel(): JSX.Element {
  const flight = useStore(activeFlight)
  const workspace = useStore(activeWorkspace)
  const openModal = useStore((s) => s.openModal)

  const [status, setStatus] = useState<GitStatus | null>(null)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [busy, setBusy] = useState<GitOp | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Discard confirmation target: a file path, or '*' for discard-all. */
  const [armed, setArmed] = useState<string | null>(null)

  const flightId = flight?.id ?? null

  const refresh = useCallback(async (): Promise<void> => {
    if (!flightId) {
      setStatus(null)
      return
    }
    try {
      setStatus(await window.orbital.gitStatus(flightId))
    } catch {
      setStatus(null)
    }
  }, [flightId])

  // Load on mount and whenever the active Flight changes.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // External git activity (commits from a terminal, checkouts, agent edits)
  // triggers a state broadcast via the main-process git watcher — re-read status.
  useEffect(() => window.orbital.onStateChanged(() => void refresh()), [refresh])

  // Draft message / amend / confirmations are per-Flight state; drop them on switch.
  useEffect(() => {
    setMessage('')
    setAmend(false)
    setArmed(null)
    setError(null)
  }, [flightId])

  // An armed discard disarms itself if not confirmed promptly.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 4000)
    return () => clearTimeout(t)
  }, [armed])

  if (!flight) {
    return (
      <div className="border-b border-soft px-[15px] py-4">
        <span className="text-[11px] tracking-[0.9px] uppercase text-muted font-bold">Git</span>
        <div className="mt-2 text-[12px] text-faint">No Flight</div>
      </div>
    )
  }

  const staged = status?.staged ?? []
  const unstaged = status?.unstaged ?? []
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const branch = status?.branch ?? flight.branch

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

  /** Open (or re-focus) an editor tab showing this file's staged/unstaged diff. */
  const openDiff = (f: GitFileStatus): void => {
    for (const pane of flight.panes) {
      const existing = pane.tabs.find(
        (t) => t.type === 'editor' && t.config.filePath === f.path && !!t.config.diffStaged === f.staged
      )
      if (existing) {
        void window.orbital.setActiveTab(pane.id, existing.id)
        return
      }
    }
    void window.orbital.createTab(flight.id, null, 'editor', { filePath: f.path, diffStaged: f.staged })
  }

  const commit = (): void => {
    const msg = message.trim()
    if (!msg || (staged.length === 0 && !amend)) return
    void exec('commit', async () => {
      await window.orbital.gitCommit(flight.id, msg, amend)
      setMessage('')
      setAmend(false)
    })
  }

  const toggleAmend = async (): Promise<void> => {
    const next = !amend
    setAmend(next)
    // Amending with an empty box almost always means "reuse the last message".
    if (next && !message.trim()) {
      const last = await window.orbital.gitLastCommitMessage(flight.id).catch(() => '')
      if (last) setMessage(last)
    }
  }

  const commitDisabled = !!busy || !message.trim() || (staged.length === 0 && !amend)

  const spinner = <Loader2 size={12} strokeWidth={2} className="flex-none animate-spin" />

  return (
    <div className="border-b border-soft">
      {/* header: label + branch + ahead/behind + refresh */}
      <div className="flex items-center justify-between px-[15px] pt-[13px] pb-[11px]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] tracking-[0.9px] uppercase text-muted font-bold">Git</span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-accent min-w-0">
            <GitBranch size={12} strokeWidth={1.5} className="flex-none" />
            <span className="truncate" title={branch}>
              {branch}
            </span>
          </span>
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

      {/* actions */}
      <div className="flex gap-[7px] px-[15px] pb-3">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void exec('pull', () => window.orbital.gitPull(flight.id))}
          className={`flex-1 py-[7px] inline-flex items-center justify-center gap-1.5 ${SECONDARY}`}
        >
          {busy === 'pull' && spinner}
          Pull{behind > 0 ? ` ↓${behind}` : ''}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void exec('fetch', () => window.orbital.gitFetch(flight.id))}
          className={`flex-1 py-[7px] inline-flex items-center justify-center gap-1.5 ${SECONDARY}`}
        >
          {busy === 'fetch' && spinner}
          Fetch
        </button>
        <button
          type="button"
          onClick={() => openModal('newFlight', { workspace })}
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
                onClick={() => void exec('unstageAll', () => window.orbital.gitUnstageAll(flight.id))}
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
          staged.map((f) => (
            <GitFileRow
              key={`s:${f.path}`}
              file={f}
              action="unstage"
              armed={false}
              disabled={!!busy}
              onAction={() => void exec('unstage', () => window.orbital.gitUnstage(flight.id, f.path))}
              onOpenDiff={() => openDiff(f)}
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
                    onClick={() => void exec('discardAll', () => window.orbital.gitDiscardAll(flight.id))}
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
                    onClick={() => void exec('stageAll', () => window.orbital.gitStageAll(flight.id))}
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
          unstaged.map((f) => (
            <GitFileRow
              key={`u:${f.path}`}
              file={f}
              action="stage"
              armed={armed === f.path}
              disabled={!!busy}
              onAction={() => void exec('stage', () => window.orbital.gitStage(flight.id, f.path))}
              onOpenDiff={() => openDiff(f)}
              onArm={() => setArmed(f.path)}
              onDiscard={() => void exec('discard', () => window.orbital.gitDiscard(flight.id, f.path))}
              onDisarm={() => setArmed(null)}
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
            className="flex-1 py-[9px] inline-flex items-center justify-center gap-1.5 rounded-btn bg-accent text-[12.5px] font-bold text-[#06122e] hover:bg-[#6a9dff] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent"
          >
            {busy === 'commit' && spinner}
            {amend ? 'Amend' : 'Commit'}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void exec('push', () => window.orbital.gitPush(flight.id))}
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
