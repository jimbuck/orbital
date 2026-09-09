import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Check, Copy, GitBranch, Loader2, RefreshCw, Tag, X } from 'lucide-react'
import { useStore, activeProject, activeWorktree } from '@renderer/store'
import type { FileDiff, GitCommit, GitCommitDetail, GitCommitFile, GitFileState } from '@shared/types'
import { GRAPH_COLOR_COUNT, layoutGraph, type GraphRow } from '@renderer/lib/commitGraph'
import DiffView from '../body/DiffView'

/* ---- Tunables ------------------------------------------------------------ */

/** Commits fetched per page (and per "Load more"). */
const PAGE = 100
/** Graph geometry: lane pitch and the fixed row height every list row shares. */
const LANE_W = 14
const ROW_H = 44
const NODE_R = 4

/** One CSS colour per graph lane colour index (see GRAPH_COLOR_COUNT). */
const GRAPH_COLORS = [
  'var(--color-accent)',
  'var(--color-green)',
  'var(--color-amber)',
  'var(--color-purple)',
  'var(--color-red)',
  'var(--color-blue)'
]
if (GRAPH_COLORS.length !== GRAPH_COLOR_COUNT) throw new Error('GRAPH_COLORS must cover every lane colour')

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/* ---- Helpers ------------------------------------------------------------- */

/** Strip Electron's IPC-rejection wrapper so the banner shows git's actual stderr. */
function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim()
}

/** "just now" / "12m ago" / "3d ago" — coarse on purpose; the detail pane has the full date. */
export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round(now / 1000 - ts))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(d / 365)}y ago`
}

/** Single-letter badge + tint for a changed file, matching the git panel's. */
function fileBadge(state: GitFileState): { letter: string; className: string } {
  switch (state) {
    case 'added':
      return { letter: 'A', className: 'bg-green/15 text-green-2' }
    case 'deleted':
      return { letter: 'D', className: 'bg-red/15 text-red-2' }
    case 'renamed':
      return { letter: 'R', className: 'bg-accent/15 text-blue' }
    case 'copied':
      return { letter: 'C', className: 'bg-accent/15 text-blue' }
    case 'conflicted':
      return { letter: 'U', className: 'bg-red/15 text-red-2' }
    default:
      return { letter: 'M', className: 'bg-amber/15 text-amber-2' }
  }
}

/* ---- Pieces -------------------------------------------------------------- */

/** One row's slice of the lane graph: pass-through lanes, this node, its parent lines. */
function GraphCell({ row, lanes }: { row: GraphRow; lanes: number }): JSX.Element {
  const cx = (lane: number): number => lane * LANE_W + LANE_W / 2
  const mid = ROW_H / 2
  const x = cx(row.lane)
  return (
    <svg
      width={lanes * LANE_W}
      height={ROW_H}
      className="flex-none"
      aria-hidden="true"
      style={{ minWidth: lanes * LANE_W }}
    >
      {row.through.map((t) => (
        <line
          key={`t${t.lane}`}
          x1={cx(t.lane)}
          y1={0}
          x2={cx(t.lane)}
          y2={ROW_H}
          stroke={GRAPH_COLORS[t.color]}
          strokeWidth={1.5}
        />
      ))}
      {/* The previous row's outbound segment ends at this row's top edge; the
          stub from there into the node completes it. A tip has nothing above. */}
      {!row.tip && <line x1={x} y1={0} x2={x} y2={mid} stroke={GRAPH_COLORS[row.color]} strokeWidth={1.5} />}
      {row.outbound.map((e) => {
        const x1 = cx(e.to)
        const d =
          e.to === row.lane
            ? `M ${x} ${mid} L ${x} ${ROW_H}`
            : `M ${x} ${mid} C ${x} ${ROW_H}, ${x1} ${mid}, ${x1} ${ROW_H}`
        return <path key={`o${e.to}`} d={d} fill="none" stroke={GRAPH_COLORS[e.color]} strokeWidth={1.5} />
      })}
      {row.merge ? (
        <circle cx={x} cy={mid} r={NODE_R} fill="var(--color-panel)" stroke={GRAPH_COLORS[row.color]} strokeWidth={2} />
      ) : (
        <circle cx={x} cy={mid} r={NODE_R} fill={GRAPH_COLORS[row.color]} />
      )}
    </svg>
  )
}

/** A branch / tag / HEAD chip beside the subject. */
function RefChip({ name }: { name: string }): JSX.Element {
  const isTag = name.startsWith('tag: ')
  const label = isTag ? name.slice(5) : name
  const isRemote = !isTag && name.includes('/')
  const tint = isTag
    ? 'border-amber/30 bg-amber/10 text-amber-2'
    : isRemote
      ? 'border-line-2 bg-hover text-muted'
      : 'border-accent/30 bg-accent/10 text-accent'
  return (
    <span
      title={name}
      className={`inline-flex max-w-[160px] flex-none items-center gap-1 rounded-chip border px-1.5 py-px font-mono text-[9.5px] font-semibold ${tint}`}
    >
      {isTag ? <Tag size={9} strokeWidth={2} /> : <GitBranch size={9} strokeWidth={2} />}
      <span className="truncate">{label}</span>
    </span>
  )
}

function CommitRow({
  commit,
  row,
  lanes,
  selected,
  onSelect
}: {
  commit: GitCommit
  row: GraphRow
  lanes: number
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      data-hash={commit.hash}
      style={{ height: ROW_H }}
      className={`flex w-full items-stretch gap-2 pr-3 text-left ${FOCUS} ${
        selected ? 'bg-accent/10' : 'hover:bg-hover'
      }`}
    >
      <GraphCell row={row} lanes={lanes} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[3px]">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 truncate text-[12px] ${selected ? 'font-semibold text-text' : 'font-medium text-text-2'}`}>
            {commit.subject || <span className="italic text-faint">(no subject)</span>}
          </span>
          {commit.isHead && (
            <span className="flex-none rounded-chip border border-green/30 bg-green/10 px-1.5 py-px font-mono text-[9.5px] font-bold text-green-2">
              HEAD
            </span>
          )}
          {commit.refs.map((r) => (
            <RefChip key={r} name={r} />
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-2 font-mono text-[10.5px] text-dim">
          <span className="flex-none text-faint">{commit.hash.slice(0, 7)}</span>
          <span className="truncate">{commit.author}</span>
          <span className="flex-none text-faint" title={new Date(commit.timestamp * 1000).toLocaleString()}>
            {relativeTime(commit.timestamp)}
          </span>
        </div>
      </div>
    </button>
  )
}

function FileRow({
  file,
  selected,
  onSelect
}: {
  file: GitCommitFile
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const badge = fileBadge(file.state)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      className={`flex w-full items-center gap-[9px] rounded-md px-2 py-[5px] text-left ${FOCUS} ${
        selected ? 'bg-accent/10' : 'hover:bg-hover'
      }`}
    >
      <span
        className={`flex size-[14px] flex-none items-center justify-center rounded-[3px] font-mono text-[9px] font-bold ${badge.className}`}
      >
        {badge.letter}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-2">
        {file.oldPath && <span className="text-faint">{file.oldPath} → </span>}
        {file.path}
      </span>
      <span className="flex flex-none items-center gap-1.5 font-mono text-[10.5px]">
        {file.binary ? (
          <span className="text-faint">bin</span>
        ) : (
          <>
            <span className="text-green-2">+{file.additions}</span>
            <span className="text-red-2">−{file.deletions}</span>
          </>
        )}
      </span>
    </button>
  )
}

/* ---- The modal ----------------------------------------------------------- */

/**
 * Commit history for the active Worktree's current branch: a lane graph +
 * commit list on the left (paged, newest first), and on the right the selected
 * commit's message, its changed files, and the selected file's diff. Opens as a
 * full-size modal like the task board (View ▸ Commit History, or the clock
 * button in the git panel header).
 */
export default function CommitHistory(): JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const project = useStore(activeProject)
  const worktree = useStore(activeWorktree)
  const worktreeId = worktree?.id ?? null

  const [commits, setCommits] = useState<GitCommit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [file, setFile] = useState<GitCommitFile | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  // Monotonic request ids so a slow reply for a previous worktree / commit /
  // file can never overwrite the state of the one selected since.
  const listReq = useRef(0)
  const detailReq = useRef(0)
  const diffReq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  /** (Re)load the first page, dropping everything loaded so far. */
  const loadFirst = useCallback(async (): Promise<void> => {
    if (!worktreeId) return
    const req = ++listReq.current
    setLoading(true)
    setError(null)
    try {
      const page = await window.orbital.gitLog(worktreeId, 0, PAGE)
      if (req !== listReq.current) return
      setCommits(page.commits)
      setHasMore(page.hasMore)
      // Land on HEAD so the right-hand pane is never empty on open; keep the
      // user's pick if it is still in the (refreshed) list.
      setSelected((cur) => (cur && page.commits.some((c) => c.hash === cur) ? cur : (page.commits[0]?.hash ?? null)))
    } catch (err) {
      if (req === listReq.current) setError(cleanError(err))
    } finally {
      if (req === listReq.current) setLoading(false)
    }
  }, [worktreeId])

  const loadMore = async (): Promise<void> => {
    if (!worktreeId || loading || !hasMore) return
    const req = ++listReq.current
    setLoading(true)
    try {
      const page = await window.orbital.gitLog(worktreeId, commits.length, PAGE)
      if (req !== listReq.current) return
      setCommits((cur) => [...cur, ...page.commits])
      setHasMore(page.hasMore)
    } catch (err) {
      if (req === listReq.current) setError(cleanError(err))
    } finally {
      if (req === listReq.current) setLoading(false)
    }
  }

  // Fresh list on open and whenever the active Worktree changes underneath.
  useEffect(() => {
    setCommits([])
    setSelected(null)
    setHasMore(false)
    void loadFirst()
  }, [loadFirst])

  // A commit, checkout or pull elsewhere moves HEAD; the git panel refreshes
  // on the same git-changed push. Only the first page is re-read, and only a
  // changed tip resets the list — otherwise a long scrolled history would keep
  // snapping back on every working-tree write while an agent edits files.
  useEffect(
    () =>
      window.orbital.onGitChanged((evt) => {
        if (!worktreeId || !evt.worktreeIds.includes(worktreeId)) return
        void window.orbital
          .gitLog(worktreeId, 0, 1)
          .then((page) => {
            const tip = page.commits[0]?.hash ?? null
            setCommits((cur) => {
              if ((cur[0]?.hash ?? null) !== tip) void loadFirst()
              return cur
            })
          })
          .catch(() => {})
      }),
    [worktreeId, loadFirst]
  )

  // Selected commit → its detail; the first changed file is picked so the diff
  // pane fills in without a second click.
  useEffect(() => {
    setDetail(null)
    setDetailError(null)
    setFile(null)
    setDiff(null)
    setCopied(false)
    if (!worktreeId || !selected) return
    const req = ++detailReq.current
    window.orbital
      .gitCommitDetail(worktreeId, selected)
      .then((d) => {
        if (req !== detailReq.current) return
        setDetail(d)
        setFile(d.files[0] ?? null)
      })
      .catch((err) => {
        if (req === detailReq.current) setDetailError(cleanError(err))
      })
  }, [worktreeId, selected])

  // Selected file → its diff.
  useEffect(() => {
    setDiff(null)
    if (!worktreeId || !selected || !file) return
    const req = ++diffReq.current
    setDiffLoading(true)
    window.orbital
      .gitCommitDiff(worktreeId, selected, file.path, file.oldPath)
      .then((d) => {
        if (req === diffReq.current) setDiff(d)
      })
      .catch((err) => {
        if (req === diffReq.current) setDetailError(cleanError(err))
      })
      .finally(() => {
        if (req === diffReq.current) setDiffLoading(false)
      })
  }, [worktreeId, selected, file])

  const rows = useMemo(() => layoutGraph(commits), [commits])
  const lanes = useMemo(() => Math.max(1, ...rows.map((r) => r.width)), [rows])
  const selectedCommit = commits.find((c) => c.hash === selected) ?? null

  // Up/Down walk the list from the keyboard, keeping the row in view.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (!commits.length) return
    e.preventDefault()
    const i = commits.findIndex((c) => c.hash === selected)
    const next = Math.min(commits.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
    const hash = commits[next].hash
    setSelected(hash)
    listRef.current?.querySelector<HTMLElement>(`[data-hash="${hash}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const copyHash = (): void => {
    if (!detail) return
    window.orbital.writeClipboard(detail.hash)
    setCopied(true)
  }

  // The message body minus its subject line (already shown as the heading).
  const bodyRest = detail ? detail.body.split('\n').slice(1).join('\n').trim() : ''

  return (
    <div
      style={{ animation: 'panelIn .16s ease-out' }}
      className="flex h-[86vh] w-[1480px] max-w-[95vw] flex-col overflow-hidden bg-panel border border-line-strong rounded-modal elev-modal"
    >
      <header className="flex flex-none items-center justify-between px-[18px] py-[15px] border-b border-soft">
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-text">Commit history</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-dim">
            {worktree ? (
              <>
                <span className="truncate">{project?.name}</span>
                <span className="text-faint">▸</span>
                <span className="truncate">{worktree.name}</span>
                <span className="text-faint">·</span>
                <span className="inline-flex items-center gap-1 font-mono text-accent">
                  <GitBranch size={11} strokeWidth={1.5} />
                  {worktree.branch}
                </span>
                {commits.length > 0 && (
                  <span className="text-faint">
                    · {commits.length}
                    {hasMore ? '+' : ''} commit{commits.length === 1 && !hasMore ? '' : 's'}
                  </span>
                )}
              </>
            ) : (
              'No Worktree selected'
            )}
          </div>
        </div>
        <div className="flex flex-none items-center gap-1">
          <button
            type="button"
            aria-label="Refresh"
            title="Reload the history"
            disabled={loading || !worktreeId}
            onClick={() => void loadFirst()}
            className={`grid size-7 place-items-center rounded-[7px] text-muted hover:bg-hover hover:text-text transition-colors disabled:opacity-40 ${FOCUS}`}
          >
            <RefreshCw size={13} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={closeModal}
            className={`grid size-7 place-items-center rounded-[7px] text-muted hover:bg-hover hover:text-text transition-colors ${FOCUS}`}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left: graph + commit list */}
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={onListKey}
          aria-label="Commits"
          className={`flex w-[46%] min-w-0 flex-none flex-col overflow-y-auto border-r border-soft py-1 ${FOCUS}`}
        >
          {error && (
            <div className="mx-3 my-2 rounded-[7px] border border-red/25 bg-red/10 px-2.5 py-2 font-mono text-[10.5px] leading-snug text-red-2 allow-select">
              {error}
            </div>
          )}
          {!error && !loading && commits.length === 0 && (
            <div className="px-4 py-6 text-[12px] text-faint">
              {worktreeId ? 'No commits yet on this branch.' : 'Select a Worktree to see its history.'}
            </div>
          )}
          {commits.map((c, i) => (
            <CommitRow
              key={c.hash}
              commit={c}
              row={rows[i]}
              lanes={lanes}
              selected={c.hash === selected}
              onSelect={() => setSelected(c.hash)}
            />
          ))}
          {(hasMore || (loading && commits.length === 0)) && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadMore()}
              className={`mx-3 my-2 inline-flex items-center justify-center gap-1.5 rounded-[7px] border border-line-2 bg-hover py-[7px] text-[11.5px] font-semibold text-text-2 hover:bg-panel-2 transition-colors disabled:opacity-60 ${FOCUS}`}
            >
              {loading && <Loader2 size={12} strokeWidth={2} className="animate-spin" />}
              {loading ? 'Loading…' : `Load ${PAGE} more`}
            </button>
          )}
        </div>

        {/* Right: selected commit */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!selectedCommit ? (
            <div className="flex flex-1 items-center justify-center text-[12px] text-faint">
              {commits.length ? 'Select a commit' : ''}
            </div>
          ) : (
            <>
              <div className="flex-none border-b border-soft px-[18px] py-3">
                <div className="text-[13px] font-bold text-text allow-select">{selectedCommit.subject}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
                  <span className="allow-select">
                    {selectedCommit.author}
                    {selectedCommit.email && <span className="text-faint"> &lt;{selectedCommit.email}&gt;</span>}
                  </span>
                  <span className="text-faint">{new Date(selectedCommit.timestamp * 1000).toLocaleString()}</span>
                  <button
                    type="button"
                    onClick={copyHash}
                    disabled={!detail}
                    title="Copy the full hash"
                    className={`inline-flex items-center gap-1 rounded font-mono text-[10.5px] text-muted hover:text-text ${FOCUS}`}
                  >
                    {copied ? (
                      <Check size={11} strokeWidth={2} className="text-green-2" />
                    ) : (
                      <Copy size={11} strokeWidth={1.5} />
                    )}
                    <span className="allow-select">{selectedCommit.hash}</span>
                  </button>
                  {selectedCommit.parents.length > 1 && (
                    <span className="rounded-chip border border-purple/30 bg-purple/10 px-1.5 py-px font-mono text-[9.5px] font-semibold text-purple-2">
                      merge · {selectedCommit.parents.length} parents
                    </span>
                  )}
                </div>
                {bodyRest && (
                  <pre className="mt-2 max-h-[22vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-3 allow-select">
                    {bodyRest}
                  </pre>
                )}
                {detailError && (
                  <div className="mt-2 rounded-[7px] border border-red/25 bg-red/10 px-2.5 py-2 font-mono text-[10.5px] leading-snug text-red-2 allow-select">
                    {detailError}
                  </div>
                )}
              </div>

              <div className="flex-none max-h-[34%] overflow-y-auto border-b border-soft px-[10px] py-2">
                {!detail && !detailError && (
                  <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-faint">
                    <Loader2 size={12} strokeWidth={2} className="animate-spin" /> Loading changes…
                  </div>
                )}
                {detail && detail.files.length === 0 && (
                  <div className="px-2 py-1 text-[11px] text-faint">No file changes (an empty commit).</div>
                )}
                {detail?.files.map((f) => (
                  <FileRow
                    key={`${f.oldPath ?? ''}→${f.path}`}
                    file={f}
                    selected={file === f}
                    onSelect={() => setFile(f)}
                  />
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                {file && (
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-soft bg-panel px-[18px] py-[6px] font-mono text-[11px]">
                    <span className="min-w-0 truncate text-text-2">{file.path}</span>
                    {diff && !diff.binary && (
                      <span className="flex-none text-faint">
                        <span className="text-green-2">+{diff.additions}</span>{' '}
                        <span className="text-red-2">−{diff.deletions}</span>
                      </span>
                    )}
                    {diffLoading && <Loader2 size={11} strokeWidth={2} className="flex-none animate-spin text-faint" />}
                  </div>
                )}
                {diff && file && (
                  <div className="allow-select px-2 py-1">
                    <DiffView diff={diff} path={file.path} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
