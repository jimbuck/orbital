import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, FileText, Pencil, Save, X } from 'lucide-react'
import { marked } from 'marked'
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

/* ---- View modes ---------------------------------------------------------- */

type ViewMode = 'file' | 'diff' | 'preview'
type PreviewKind = 'markdown' | 'html' | null

function extOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Files that get a rendered Preview mode. */
function previewKind(path: string): PreviewKind {
  const ext = extOf(path)
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  return null
}

/* ---- Syntax highlighting (shiki, loaded lazily) -------------------------- */

/** Extension -> shiki grammar id, for the cases where they differ. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  sh: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  htm: 'html',
  svg: 'xml',
  patch: 'diff',
  gitignore: 'ini',
  env: 'ini',
  conf: 'ini'
}

/** Grammars we accept by their own name (extension === shiki id). */
const SELF_LANGS = new Set([
  'tsx', 'jsx', 'json', 'jsonc', 'json5', 'css', 'scss', 'less', 'html', 'xml', 'vue', 'svelte',
  'yaml', 'toml', 'ini', 'bash', 'bat', 'powershell', 'python', 'ruby', 'go', 'rust', 'java',
  'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'lua', 'sql', 'graphql', 'diff', 'docker',
  'markdown', 'mdx', 'typescript', 'javascript'
])

function langFor(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (name === 'dockerfile') return 'docker'
  const ext = extOf(path)
  if (EXT_LANG[ext]) return EXT_LANG[ext]
  if (SELF_LANGS.has(ext)) return ext
  return null
}

/** Above this size highlighting is skipped — a plain <pre> keeps huge files snappy. */
const HIGHLIGHT_MAX = 300_000

/** Read-only source view: shiki-highlighted when the grammar is known, plain otherwise. */
function CodeView({ path, source }: { path: string; source: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setHtml(null)
    const lang = langFor(path)
    if (!lang || source.length > HIGHLIGHT_MAX) return
    // Dynamic import so shiki (and only the needed grammar) loads on first use,
    // keeping it out of the renderer's startup bundle.
    void import('shiki')
      .then(({ codeToHtml }) => codeToHtml(source, { lang, theme: 'github-dark-default' }))
      .then((h) => {
        if (alive) setHtml(h)
      })
      .catch(() => {
        /* unknown grammar / load failure — the plain fallback below stays up */
      })
    return () => {
      alive = false
    }
  }, [path, source])

  if (html === null) {
    return (
      <pre className="allow-select px-4 py-3 font-mono text-[12px] leading-[1.6] text-text-2">
        {source}
      </pre>
    )
  }
  return (
    <div className="shiki-view allow-select px-4 py-3" dangerouslySetInnerHTML={{ __html: html }} />
  )
}

/* ---- Preview (markdown / html) ------------------------------------------- */

/** Styles injected into the markdown preview iframe to match the app theme. */
const MD_CSS = `
  :root { color-scheme: dark; }
  body { margin: 18px 22px; font: 13px/1.65 'Hanken Grotesk', system-ui, sans-serif;
         color: #cfd6e2; background: transparent; }
  h1, h2, h3, h4, h5 { color: #e6ebf2; line-height: 1.3; }
  h1 { font-size: 1.55em; border-bottom: 1px solid rgba(255,255,255,.09); padding-bottom: .3em; }
  h2 { font-size: 1.25em; border-bottom: 1px solid rgba(255,255,255,.06); padding-bottom: .25em; }
  a { color: #4f8cff; }
  code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .9em;
         background: rgba(255,255,255,.07); padding: .12em .35em; border-radius: 4px; }
  pre { background: #10141b; border: 1px solid rgba(255,255,255,.07); border-radius: 8px;
        padding: 12px 14px; overflow: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { margin: 0; padding: 0 1em; color: #8b95a6; border-left: 3px solid rgba(255,255,255,.14); }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(255,255,255,.1); padding: 5px 10px; }
  th { background: rgba(255,255,255,.04); }
  img { max-width: 100%; }
  hr { border: 0; border-top: 1px solid rgba(255,255,255,.09); }
`

/**
 * Rendered preview in a sandboxed iframe (no scripts, no app access) so
 * arbitrary repo content can never reach the window.orbital bridge.
 */
function Preview({ kind, source }: { kind: Exclude<PreviewKind, null>; source: string }): JSX.Element {
  const doc = useMemo(() => {
    if (kind === 'html') return source
    const body = marked.parse(source, { async: false }) as string
    return `<!doctype html><meta charset="utf-8"><style>${MD_CSS}</style><body>${body}</body>`
  }, [kind, source])

  return (
    <iframe
      title="preview"
      sandbox=""
      srcDoc={doc}
      className={`h-full w-full border-0 ${kind === 'html' ? 'bg-white' : ''}`}
    />
  )
}

/* ---- Tree helpers -------------------------------------------------------- */

interface Selected {
  path: string
  gitState?: GitFileState
  /** Viewing the staged (index) side of the diff (from tab config). */
  staged: boolean
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
 * The editor tab: a recursive file tree on the left (git-state badges on files,
 * change dots on directories) and, on the right, the selected file with a
 * File / Diff / Preview mode toggle — Diff when the file has changes, Preview
 * for markdown and HTML.
 */
export default function EditorTab({ tab }: { tab: Tab }): JSX.Element {
  const flightId = useStore((s) => activeFlight(s)?.id)
  const [tree, setTree] = useState<FileNode[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<Selected | null>(null)
  const [mode, setMode] = useState<ViewMode>('file')
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const reqRef = useRef(0)

  // Load the tree, and keep it fresh: any state broadcast (git watcher, staging,
  // commits, saves) refetches it debounced, so badges track the repo live.
  useEffect(() => {
    if (!flightId) return
    let alive = true
    let timer: number | undefined
    const refetch = (): void => {
      void window.orbital.fileTree(flightId).then((nodes) => {
        if (alive) setTree(nodes)
      })
    }
    refetch()
    const unsub = window.orbital.onStateChanged(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(refetch, 400)
    })
    return () => {
      alive = false
      unsub()
      window.clearTimeout(timer)
    }
  }, [flightId])

  // Directories containing at least one changed file get a dot in the tree.
  const changedDirs = useMemo(() => {
    const set = new Set<string>()
    const walk = (nodes: FileNode[]): boolean => {
      let any = false
      for (const n of nodes) {
        if (n.type === 'dir') {
          if (walk(n.children ?? [])) {
            set.add(n.path)
            any = true
          }
        } else if (n.gitState) {
          any = true
        }
      }
      return any
    }
    walk(tree)
    return set
  }, [tree])

  const openFile = useCallback((node: FileNode, staged = false): void => {
    reqRef.current++
    setSelected({ path: node.path, gitState: node.gitState, staged })
    setMode(staged || node.gitState ? 'diff' : 'file')
    setEditing(false)
    setDiff(null)
    setContent(null)
    setLoading(false)
  }, [])

  // Fetch whatever the current mode needs and doesn't have yet.
  useEffect(() => {
    if (!flightId || !selected) return
    const needDiff = mode === 'diff' && diff === null
    const needContent = mode !== 'diff' && content === null
    if (!needDiff && !needContent) return
    const id = ++reqRef.current
    setLoading(true)
    void (async () => {
      try {
        if (needDiff) {
          const d = await window.orbital.gitDiff(flightId, selected.path, selected.staged)
          if (reqRef.current === id) setDiff(d)
        }
        if (needContent) {
          const c = await window.orbital.readFile(flightId, selected.path)
          if (reqRef.current === id) {
            setContent(c)
            setDraft(c)
          }
        }
      } catch {
        // Unreadable (e.g. a deleted file opened in File mode) — the body shows
        // a notice; content stays null and this effect doesn't re-run.
      } finally {
        if (reqRef.current === id) setLoading(false)
      }
    })()
  }, [flightId, selected, mode, diff, content])

  // When a tree refresh changes the selected file's git state, follow it: the
  // Diff toggle appears/disappears and a stale diff is refetched. The file
  // content (possibly mid-edit) is left alone.
  useEffect(() => {
    if (!selected) return
    const gs = findNode(tree, selected.path)?.gitState
    if (gs === selected.gitState) return
    setSelected((s) => (s ? { ...s, gitState: gs } : s))
    setDiff(null)
    if (!gs && !selected.staged && mode === 'diff') setMode('file')
  }, [tree, selected, mode])

  // Auto-open the tab's configured file once the tree is available.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    const fp = tab.config.filePath
    if (!fp || autoOpenedRef.current || tree.length === 0) return
    autoOpenedRef.current = true
    openFile(
      findNode(tree, fp) ?? { name: fp.split('/').pop() || fp, path: fp, type: 'file' },
      !!tab.config.diffStaged
    )
  }, [tab.config.filePath, tab.config.diffStaged, tree, openFile])

  const save = async (): Promise<void> => {
    if (!flightId || !selected) return
    await window.orbital.writeFile(flightId, selected.path, draft)
    const c = await window.orbital.readFile(flightId, selected.path)
    setContent(c)
    setDraft(c)
    setEditing(false)
    setDiff(null) // saved content invalidates any cached diff
  }

  const kind = selected ? previewKind(selected.path) : null
  const canDiff = !!selected && (!!selected.gitState || selected.staged)
  const modes: { id: ViewMode; label: string }[] = [
    { id: 'file', label: 'File' },
    ...(canDiff ? [{ id: 'diff' as const, label: 'Diff' }] : []),
    ...(kind ? [{ id: 'preview' as const, label: 'Preview' }] : [])
  ]

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
              changedDirs={changedDirs}
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

              <div className="flex flex-none items-center gap-2">
                {mode === 'diff' && diff && (
                  <span className="flex items-center gap-2 font-mono text-[10px]">
                    <span className="text-diff-add">+{diff.additions}</span>
                    <span className="text-diff-del">−{diff.deletions}</span>
                  </span>
                )}

                {mode === 'file' &&
                  content !== null &&
                  (editing ? (
                    <div className="flex items-center gap-1.5">
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
                      className={`flex items-center gap-1.5 rounded-chip px-2 py-1 text-[11px] font-medium text-text-3 hover:bg-hover hover:text-text-2 ${FOCUS}`}
                    >
                      <Pencil size={13} strokeWidth={1.5} />
                      Edit
                    </button>
                  ))}

                {modes.length > 1 && (
                  <div className="flex items-center rounded-[7px] border border-line-2 bg-bg p-[2px]">
                    {modes.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => {
                          if (m.id === mode) return
                          setEditing(false)
                          setDraft(content ?? '')
                          setMode(m.id)
                        }}
                        className={`rounded-[5px] px-2 py-[3px] text-[10.5px] font-semibold ${
                          mode === m.id ? 'bg-accent/15 text-blue' : 'text-muted hover:text-text-2'
                        } ${FOCUS}`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <div className="px-4 py-3 font-mono text-[11px] text-faint">Loading…</div>
              ) : mode === 'diff' ? (
                diff && <DiffView diff={diff} />
              ) : content === null ? (
                <div className="px-4 py-3 font-mono text-[11px] text-faint">
                  File could not be read{selected.gitState === 'deleted' ? ' (deleted)' : ''}.
                </div>
              ) : mode === 'preview' && kind ? (
                <Preview kind={kind} source={content} />
              ) : editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className={`allow-select h-full w-full resize-none bg-pane px-4 py-3 font-mono text-[12px] leading-[1.6] text-text-2 ${FOCUS}`}
                />
              ) : (
                <CodeView path={selected.path} source={content} />
              )}
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
  selectedPath,
  changedDirs
}: {
  node: FileNode
  depth: number
  expanded: Record<string, boolean>
  toggle: (path: string) => void
  onSelect: (node: FileNode) => void
  selectedPath: string | null
  changedDirs: Set<string>
}): JSX.Element {
  const pad = { paddingLeft: depth * 12 + 8 }

  if (node.type === 'dir') {
    const open = !!expanded[node.path]
    const dirty = changedDirs.has(node.path)
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
          {dirty && !open && <span className="ml-auto mr-0.5 size-[5px] flex-none rounded-full bg-amber/70" />}
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
            changedDirs={changedDirs}
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
