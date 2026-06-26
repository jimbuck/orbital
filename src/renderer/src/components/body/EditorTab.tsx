import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, FileText, Pencil, Save, X } from 'lucide-react'
import type { Tab, FileNode, FileDiff, GitFileState } from '@shared/types'
import { useStore, activeFlight } from '@renderer/store'

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/** Single-letter git badge + tint for a changed file. */
function gitBadge(state: GitFileState): { letter: string; cls: string } {
  switch (state) {
    case 'added':
      return { letter: 'A', cls: 'bg-green/15 text-green-2' }
    case 'deleted':
      return { letter: 'D', cls: 'bg-red/15 text-red-2' }
    case 'renamed':
      return { letter: 'R', cls: 'bg-accent/15 text-blue' }
    case 'copied':
      return { letter: 'C', cls: 'bg-accent/15 text-blue' }
    case 'conflicted':
      return { letter: 'U', cls: 'bg-red/15 text-red-2' }
    case 'untracked':
      return { letter: '?', cls: 'bg-white/[0.06] text-muted' }
    default:
      return { letter: 'M', cls: 'bg-amber/15 text-amber-2' }
  }
}

interface Selected {
  path: string
  gitState?: GitFileState
}

/** Depth-first search for a node by its path. */
function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const hit = findNode(node.children, path)
      if (hit) return hit
    }
  }
  return null
}

/**
 * The editor tab: a recursive file tree on the left and, on the right, either a
 * custom unified diff (for changed files) or a read-only file view with an
 * inline edit / save affordance.
 */
export default function EditorTab({ tab }: { tab: Tab }): JSX.Element {
  const flightId = useStore((s) => activeFlight(s)?.id)
  const [tree, setTree] = useState<FileNode[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<Selected | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const reqRef = useRef(0)

  // Load the tree for the active Flight; open the tab's configured file if any.
  useEffect(() => {
    if (!flightId) return
    let alive = true
    void window.orbital.fileTree(flightId).then((nodes) => {
      if (alive) setTree(nodes)
    })
    return () => {
      alive = false
    }
  }, [flightId])

  const openFile = useCallback(
    async (node: FileNode): Promise<void> => {
      if (!flightId) return
      const id = ++reqRef.current
      setSelected({ path: node.path, gitState: node.gitState })
      setEditing(false)
      setDiff(null)
      setContent(null)
      setLoading(true)
      try {
        if (node.gitState) {
          const d = await window.orbital.gitDiff(flightId, node.path, false)
          if (reqRef.current === id) setDiff(d)
        } else {
          const c = await window.orbital.readFile(flightId, node.path)
          if (reqRef.current === id) {
            setContent(c)
            setDraft(c)
          }
        }
      } finally {
        if (reqRef.current === id) setLoading(false)
      }
    },
    [flightId]
  )

  // Auto-open the tab's configured file once the tree is available.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    const fp = tab.config.filePath
    if (!fp || autoOpenedRef.current || tree.length === 0) return
    autoOpenedRef.current = true
    void openFile(findNode(tree, fp) ?? { name: fp.split('/').pop() || fp, path: fp, type: 'file' })
  }, [tab.config.filePath, tree, openFile])

  const save = async (): Promise<void> => {
    if (!flightId || !selected) return
    await window.orbital.writeFile(flightId, selected.path, draft)
    const c = await window.orbital.readFile(flightId, selected.path)
    setContent(c)
    setDraft(c)
    setEditing(false)
  }

  return (
    <div className="flex h-full w-full bg-pane">
      {/* File tree */}
      <div className="w-56 flex-none overflow-y-auto border-r border-line bg-rail/40 py-1.5">
        {tree.length === 0 ? (
          <div className="px-3 py-2 text-xs text-faint">No files</div>
        ) : (
          tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              toggle={(p) => setExpanded((e) => ({ ...e, [p]: !e[p] }))}
              onSelect={openFile}
              selectedPath={selected?.path ?? null}
            />
          ))
        )}
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-faint">
            Select a file
          </div>
        ) : (
          <>
            <div className="flex h-9 flex-none items-center justify-between gap-3 border-b border-line bg-bar px-3">
              <span className="truncate font-mono text-[11.5px] text-text-2">{selected.path}</span>
              {diff ? (
                <span className="flex flex-none items-center gap-2 font-mono text-[10px]">
                  <span className="text-diff-add">+{diff.additions}</span>
                  <span className="text-diff-del">−{diff.deletions}</span>
                </span>
              ) : content !== null ? (
                editing ? (
                  <div className="flex flex-none items-center gap-1.5">
                    <button
                      onClick={() => {
                        setEditing(false)
                        setDraft(content)
                      }}
                      className={`flex items-center gap-1.5 rounded-chip px-2 py-1 text-[11px] font-medium text-text-3 hover:bg-hover ${FOCUS}`}
                    >
                      <X size={13} strokeWidth={1.5} />
                      Cancel
                    </button>
                    <button
                      onClick={() => void save()}
                      className={`flex items-center gap-1.5 rounded-chip bg-accent px-2.5 py-1 text-[11px] font-semibold text-[#06122e] hover:brightness-110 ${FOCUS}`}
                    >
                      <Save size={13} strokeWidth={1.5} />
                      Save
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setEditing(true)}
                    className={`flex flex-none items-center gap-1.5 rounded-chip px-2 py-1 text-[11px] font-medium text-text-3 hover:bg-hover hover:text-text-2 ${FOCUS}`}
                  >
                    <Pencil size={13} strokeWidth={1.5} />
                    Edit
                  </button>
                )
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <div className="px-4 py-3 font-mono text-[11px] text-faint">Loading…</div>
              ) : diff ? (
                <DiffView diff={diff} />
              ) : editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className={`allow-select h-full w-full resize-none bg-pane px-4 py-3 font-mono text-[12px] leading-[1.6] text-text-2 ${FOCUS}`}
                />
              ) : content !== null ? (
                <pre className="allow-select px-4 py-3 font-mono text-[12px] leading-[1.6] text-text-2">
                  {content}
                </pre>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ---- File tree node ----------------------------------------------------- */

function TreeNode({
  node,
  depth,
  expanded,
  toggle,
  onSelect,
  selectedPath
}: {
  node: FileNode
  depth: number
  expanded: Record<string, boolean>
  toggle: (path: string) => void
  onSelect: (node: FileNode) => void
  selectedPath: string | null
}): JSX.Element {
  const pad = { paddingLeft: depth * 12 + 8 }

  if (node.type === 'dir') {
    const open = !!expanded[node.path]
    return (
      <>
        <button
          onClick={() => toggle(node.path)}
          style={pad}
          className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12px] text-text-3 hover:bg-hover ${FOCUS}`}
        >
          <ChevronRight
            size={13}
            strokeWidth={1.5}
            className={`flex-none text-faint transition-transform ${open ? 'rotate-90' : ''}`}
          />
          {open ? (
            <FolderOpen size={14} strokeWidth={1.5} className="flex-none text-muted" />
          ) : (
            <Folder size={14} strokeWidth={1.5} className="flex-none text-muted" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            onSelect={onSelect}
            selectedPath={selectedPath}
          />
        ))}
      </>
    )
  }

  const isSelected = node.path === selectedPath
  const badge = node.gitState ? gitBadge(node.gitState) : null
  return (
    <button
      onClick={() => onSelect(node)}
      style={pad}
      className={`flex w-full items-center gap-2 py-1 pr-2 text-left text-[12px] hover:bg-hover ${
        isSelected ? 'bg-accent/10 text-text' : 'text-text-3'
      } ${FOCUS}`}
    >
      {badge ? (
        <span
          className={`flex size-3.5 flex-none items-center justify-center rounded-[3px] font-mono text-[9px] font-bold ${badge.cls}`}
        >
          {badge.letter}
        </span>
      ) : (
        <FileText size={13} strokeWidth={1.5} className="flex-none text-faint" />
      )}
      <span className="truncate font-mono text-[11.5px]">{node.name}</span>
    </button>
  )
}

/* ---- Diff view ---------------------------------------------------------- */

/** Strip a leading +/-/space that the diff producer may already include. */
function stripSign(line: { type: string; text: string }): string {
  const { type, text } = line
  if (type === 'add' && text.startsWith('+')) return text.slice(1)
  if (type === 'del' && text.startsWith('-')) return text.slice(1)
  if (type === 'context' && text.startsWith(' ')) return text.slice(1)
  return text
}

function DiffView({ diff }: { diff: FileDiff }): JSX.Element {
  if (diff.binary) {
    return <div className="px-4 py-3 font-mono text-[11px] text-faint">Binary file not shown</div>
  }
  return (
    <div className="font-mono text-[11px] leading-[1.7]">
      {diff.lines.map((line, i) => {
        if (line.type === 'hunk') {
          return (
            <div key={i} className="flex bg-diff-hunk/8 text-diff-hunk">
              <span className="w-[62px] flex-none pr-3 text-right text-faint">@@</span>
              <span className="whitespace-pre">{line.text}</span>
            </div>
          )
        }
        const rowBg = line.type === 'add' ? 'bg-green/10' : line.type === 'del' ? 'bg-red/10' : ''
        const textCls =
          line.type === 'add'
            ? 'text-diff-add'
            : line.type === 'del'
              ? 'text-diff-del'
              : line.type === 'meta'
                ? 'text-faint'
                : 'text-text-3'
        const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '
        return (
          <div key={i} className={`flex ${rowBg}`}>
            <span className="w-[30px] flex-none pr-1.5 text-right text-faint">{line.oldNo ?? ''}</span>
            <span className="w-[30px] flex-none pr-3 text-right text-faint">{line.newNo ?? ''}</span>
            <span className={`whitespace-pre ${textCls}`}>
              {sign} {stripSign(line)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
