import { useCallback, useEffect, useState, type JSX } from 'react'
import { GitBranch, Minus, Plus } from 'lucide-react'
import { useStore, activeFlight, activeWorkspace } from '@renderer/store'
import type { GitFileState, GitFileStatus, GitStatus } from '@shared/types'

/* Secondary button recipe (design guide: "// secondary"). */
const SECONDARY =
  'border border-line-2 rounded-[7px] text-[11.5px] font-semibold bg-hover text-text-2 ' +
  'hover:bg-panel-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

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

/** One changed-file row with a colored letter badge, truncated mono path and a stage/unstage toggle. */
function GitFileRow({
  file,
  action,
  onAction
}: {
  file: GitFileStatus
  action: 'stage' | 'unstage'
  onAction: () => void
}): JSX.Element {
  const badge = stateBadge(file.state)
  const isStage = action === 'stage'
  return (
    <div className="flex items-center gap-[9px] px-[7px] py-[5px] rounded-md hover:bg-hover">
      <span
        className={`flex-none size-[14px] rounded-[3px] flex items-center justify-center font-mono text-[9px] font-bold ${badge.className}`}
      >
        {badge.letter}
      </span>
      <span className="font-mono text-[11.5px] text-text-2 flex-1 min-w-0 truncate" title={file.path}>
        {file.path}
      </span>
      <button
        type="button"
        onClick={onAction}
        title={isStage ? 'Stage' : 'Unstage'}
        aria-label={`${isStage ? 'Stage' : 'Unstage'} ${file.path}`}
        className={`flex-none rounded p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          isStage ? 'text-accent hover:text-blue' : 'text-faint hover:text-text'
        }`}
      >
        {isStage ? <Plus size={14} strokeWidth={1.5} /> : <Minus size={14} strokeWidth={1.5} />}
      </button>
    </div>
  )
}

/**
 * Git surface for the active Flight: branch + ahead/behind, Pull/Fetch/Worktree,
 * staged & unstaged file lists, and a commit/push area. Reloads `gitStatus`
 * whenever the active Flight changes and after every mutation.
 */
export default function GitPanel(): JSX.Element {
  const flight = useStore(activeFlight)
  const workspace = useStore(activeWorkspace)
  const openModal = useStore((s) => s.openModal)

  const [status, setStatus] = useState<GitStatus | null>(null)
  const [message, setMessage] = useState('')

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

  const pull = async (): Promise<void> => {
    await window.orbital.gitPull(flight.id)
    await refresh()
  }
  const fetch = async (): Promise<void> => {
    await window.orbital.gitFetch(flight.id)
    await refresh()
  }
  const stage = async (path: string): Promise<void> => {
    await window.orbital.gitStage(flight.id, path)
    await refresh()
  }
  const unstage = async (path: string): Promise<void> => {
    await window.orbital.gitUnstage(flight.id, path)
    await refresh()
  }
  const commit = async (): Promise<void> => {
    const msg = message.trim()
    if (!msg) return
    await window.orbital.gitCommit(flight.id, msg)
    setMessage('')
    await refresh()
  }
  const push = async (): Promise<void> => {
    await window.orbital.gitPush(flight.id)
    await refresh()
  }

  return (
    <div className="border-b border-soft">
      {/* header: label + branch + ahead/behind */}
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
          <span className={ahead > 0 ? 'text-green-2' : 'text-faint'}>↑{ahead}</span>
          <span className="text-faint">↓{behind}</span>
        </div>
      </div>

      {/* actions */}
      <div className="flex gap-[7px] px-[15px] pb-3">
        <button type="button" onClick={() => void pull()} className={`flex-1 py-[7px] ${SECONDARY}`}>
          Pull
        </button>
        <button type="button" onClick={() => void fetch()} className={`flex-1 py-[7px] ${SECONDARY}`}>
          Fetch
        </button>
        <button
          type="button"
          onClick={() => openModal('newFlight', workspace)}
          className={`flex-1 py-[7px] inline-flex items-center justify-center gap-1 ${SECONDARY}`}
        >
          <Plus size={13} strokeWidth={1.5} />
          Worktree
        </button>
      </div>

      {/* staged */}
      <div className="px-[15px]">
        <div className="flex items-center justify-between pt-[7px] pb-[6px]">
          <span className="text-[10.5px] tracking-[0.5px] uppercase text-faint font-bold">Staged</span>
          <span className="font-mono text-[10.5px] text-green-2">{staged.length}</span>
        </div>
        {staged.map((f) => (
          <GitFileRow key={`s:${f.path}`} file={f} action="unstage" onAction={() => void unstage(f.path)} />
        ))}
      </div>

      {/* unstaged */}
      <div className="px-[15px] pb-1">
        <div className="flex items-center justify-between pt-[9px] pb-[6px]">
          <span className="text-[10.5px] tracking-[0.5px] uppercase text-faint font-bold">Changes</span>
          <span className="font-mono text-[10.5px] text-amber-2">{unstaged.length}</span>
        </div>
        {unstaged.map((f) => (
          <GitFileRow key={`u:${f.path}`} file={f} action="stage" onAction={() => void stage(f.path)} />
        ))}
      </div>

      {/* commit */}
      <div className="px-[15px] pt-2 pb-[14px]">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message…"
          rows={2}
          className="allow-select w-full resize-none px-[11px] py-[9px] rounded-btn bg-bg border border-line-2 text-[12px] text-text leading-snug placeholder:text-faint outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        />
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            onClick={() => void commit()}
            disabled={!message.trim() || staged.length === 0}
            className="flex-1 py-[9px] rounded-btn bg-accent text-[12.5px] font-bold text-[#06122e] hover:bg-[#6a9dff] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent"
          >
            Commit
          </button>
          <button
            type="button"
            onClick={() => void push()}
            className={`flex-none px-4 py-[9px] rounded-btn ${SECONDARY}`}
          >
            Push ↑{ahead}
          </button>
        </div>
      </div>
    </div>
  )
}
