import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, FileText, Image as ImageIcon, RefreshCw, Save, X } from 'lucide-react'
import { marked } from 'marked'
import type { BundledLanguage } from 'shiki'
import type { Tab, FileNode, FileDiff, GitFileState } from '@shared/types'
import { useResolvedTheme, type ResolvedTheme } from '@renderer/lib/theme'
import { useFileTree } from '@renderer/lib/fileTree'
import { extOf, imageMime, resolveMarkdownImages } from '@renderer/lib/markdownAssets'
import { clampMenuPos, type MenuPos } from '../rail/menu'
import FileContextMenu, { FILE_MENU_WIDTH, type FileMutation } from './FileContextMenu'

/** Shiki bundled theme id for each resolved app theme. */
function shikiTheme(theme: ResolvedTheme): 'github-light-default' | 'github-dark-default' {
  return theme === 'light' ? 'github-light-default' : 'github-dark-default'
}

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
      return { letter: '?', cls: 'bg-line-2 text-muted' }
    default:
      return { letter: 'M', cls: 'bg-amber/15 text-amber-2' }
  }
}

/* ---- View modes ---------------------------------------------------------- */

type ViewMode = 'file' | 'diff' | 'preview'
type PreviewKind = 'markdown' | 'html' | 'svg' | null

/** Files that get a rendered Preview mode. */
function previewKind(path: string): PreviewKind {
  const ext = extOf(path)
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'svg') return 'svg'
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

/**
 * Editable source view with live syntax highlighting: a transparent-text
 * textarea (caret + input) stacked over a shiki-rendered mirror of the draft,
 * scroll-synced. Both layers share the exact font metrics and padding, so the
 * glyphs line up. Falls back to a plain visible textarea when the grammar is
 * unknown or the file is too large to highlight.
 */
function CodeEditor({
  path,
  value,
  onChange
}: {
  path: string
  value: string
  onChange: (next: string) => void
}): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const theme = useResolvedTheme()

  useEffect(() => {
    const lang = langFor(path)
    if (!lang || value.length > HIGHLIGHT_MAX) {
      setHtml(null)
      return
    }
    let alive = true
    // Tiny debounce so fast typing doesn't queue a highlight per keystroke.
    const t = setTimeout(() => {
      void import('shiki')
        // The trailing newline keeps the mirror's height in step with the
        // textarea when the draft ends mid-newline.
        .then(({ codeToHtml }) => codeToHtml(value + '\n', { lang, theme: shikiTheme(theme) }))
        .then((h) => {
          if (alive) setHtml(h)
        })
        .catch(() => {
          if (alive) setHtml(null)
        })
    }, 30)
    return () => {
      alive = false
      clearTimeout(t)
    }
    // theme is a dep so the mirror re-highlights when the app theme flips.
  }, [path, value, theme])

  const syncScroll = (): void => {
    const mirror = mirrorRef.current
    const ta = taRef.current
    if (!mirror || !ta) return
    mirror.scrollTop = ta.scrollTop
    mirror.scrollLeft = ta.scrollLeft
  }

  useEffect(syncScroll, [html])

  return (
    <div className="relative h-full w-full">
      {html !== null && (
        <div
          ref={mirrorRef}
          aria-hidden
          className="shiki-view pointer-events-none absolute inset-0 overflow-hidden whitespace-pre px-4 py-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={(e) => {
          // Tab indents instead of moving focus; execCommand keeps native undo.
          if (e.key === 'Tab') {
            e.preventDefault()
            document.execCommand('insertText', false, '  ')
          }
        }}
        spellCheck={false}
        wrap="off"
        className={`allow-select absolute inset-0 h-full w-full resize-none whitespace-pre bg-transparent px-4 py-3 font-mono text-[12px] leading-[1.6] ${
          html !== null
            ? `text-transparent ${theme === 'light' ? 'caret-[#17202e]' : 'caret-[#e6ebf2]'}`
            : 'text-text-2'
        } ${FOCUS}`}
      />
    </div>
  )
}

/* ---- Preview (markdown / html) ------------------------------------------- */

/**
 * Styles injected into the markdown preview iframe to match the app theme.
 * The iframe is sandboxed (no app CSS reaches it), so the palette is inlined
 * per resolved theme rather than pulling from the design tokens.
 */
function mdCss(theme: ResolvedTheme): string {
  const c =
    theme === 'light'
      ? {
          scheme: 'light',
          text: '#2b3546',
          heading: '#17202e',
          line1: 'rgba(0,0,0,.12)',
          line2: 'rgba(0,0,0,.08)',
          link: '#2563eb',
          codeBg: 'rgba(0,0,0,.05)',
          preBg: '#f1f4f9',
          preLine: 'rgba(0,0,0,.08)',
          quote: '#667085',
          quoteBar: 'rgba(0,0,0,.16)',
          cellLine: 'rgba(0,0,0,.12)',
          thBg: 'rgba(0,0,0,.04)'
        }
      : {
          scheme: 'dark',
          text: '#cfd6e2',
          heading: '#e6ebf2',
          line1: 'rgba(255,255,255,.09)',
          line2: 'rgba(255,255,255,.06)',
          link: '#4f8cff',
          codeBg: 'rgba(255,255,255,.07)',
          preBg: '#10141b',
          preLine: 'rgba(255,255,255,.07)',
          quote: '#8b95a6',
          quoteBar: 'rgba(255,255,255,.14)',
          cellLine: 'rgba(255,255,255,.1)',
          thBg: 'rgba(255,255,255,.04)'
        }
  return `
  :root { color-scheme: ${c.scheme}; }
  body { margin: 18px 22px; font: 13px/1.65 'Hanken Grotesk', system-ui, sans-serif;
         color: ${c.text}; background: transparent; }
  h1, h2, h3, h4, h5 { color: ${c.heading}; line-height: 1.3; }
  h1 { font-size: 1.55em; border-bottom: 1px solid ${c.line1}; padding-bottom: .3em; }
  h2 { font-size: 1.25em; border-bottom: 1px solid ${c.line2}; padding-bottom: .25em; }
  a { color: ${c.link}; }
  code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .9em;
         background: ${c.codeBg}; padding: .12em .35em; border-radius: 4px; }
  pre { background: ${c.preBg}; border: 1px solid ${c.preLine}; border-radius: 8px;
        padding: 12px 14px; overflow: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { margin: 0; padding: 0 1em; color: ${c.quote}; border-left: 3px solid ${c.quoteBar}; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid ${c.cellLine}; padding: 5px 10px; }
  th { background: ${c.thBg}; }
  img { max-width: 100%; }
  hr { border: 0; border-top: 1px solid ${c.line1}; }
`
}

/**
 * Rendered preview in a sandboxed iframe. Scripts stay disabled (no allow-scripts),
 * so arbitrary repo content still can't reach the window.orbital bridge. For the
 * markdown case we add allow-same-origin — with no scripts this is safe, and it's
 * needed so the PARENT can read the frame's DOM to intercept anchor clicks (per
 * the link-handling spec: plain click → internal browser tab, Ctrl/Cmd → external).
 *
 * A srcDoc frame has no usable base URL, so relative image references would all
 * break; lib/markdownAssets inlines them as data: URLs before the document is
 * written. That happens outside the frame, on parsed DOM, and adds no sandbox
 * permissions — the frame stays script-free.
 */
export function Preview({
  kind,
  source,
  path,
  worktreeId,
  onLink
}: {
  kind: Exclude<PreviewKind, null>
  source: string
  /** Repo-relative path of the previewed file — the base for relative images. */
  path: string
  worktreeId: string | undefined
  onLink: (href: string, external: boolean) => void
}): JSX.Element {
  const theme = useResolvedTheme()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [doc, setDoc] = useState('')
  // Same request-id guard EditorTab uses for its loads: image resolution is
  // async, so a slow render of the previous file must never land on top of a
  // newer one after a fast file switch or another keystroke.
  const reqRef = useRef(0)
  // Identifies the *document* currently in the frame — see the staleness note in
  // the effect below. Null while nothing trustworthy is on screen.
  const shownRef = useRef<string | null>(null)

  useEffect(() => {
    const id = ++reqRef.current
    // Identity of the thing being previewed: a file (or worktree) switch changes
    // it, a keystroke or a theme flip does not.
    const docId = JSON.stringify([worktreeId ?? '', kind, path])
    const show = (html: string): void => {
      if (reqRef.current !== id) return
      shownRef.current = docId
      setDoc(html)
    }

    if (kind !== 'markdown') {
      show(source)
      return
    }
    const body = marked.parse(source, { async: false }) as string
    const wrap = (b: string): string =>
      `<!doctype html><meta charset="utf-8"><style>${mdCss(theme)}</style><body>${b}</body>`
    if (!worktreeId) {
      show(wrap(body))
      return
    }

    // Local images become data: URLs *before* the frame is written, so the
    // preview never flashes broken images and is only rebuilt once. Cached
    // images resolve in a microtask, which keeps typing and theme flips smooth.
    //
    // That still leaves a window (first render of a file, cold cache, slow IPC)
    // in which the frame holds the previous render. Whether that is acceptable
    // depends entirely on *what changed*, which is what shownRef tracks:
    //
    //  - A different file (or worktree) is now selected. What's on screen is
    //    another document entirely, and showing it under this file's header is
    //    simply false — blank the frame and let the new render fill it.
    //  - The same file re-rendered after a keystroke or a theme flip. The last
    //    good render is still an honest picture of that file, only a beat
    //    behind, so holding it is the correct behaviour. Blanking here would
    //    strobe the preview on every keypress — a far worse regression than the
    //    momentary lag it would "fix".
    if (shownRef.current !== docId) {
      shownRef.current = null
      setDoc('')
    }

    void resolveMarkdownImages(body, { worktreeId, mdPath: path })
      .then((resolved) => show(wrap(resolved)))
      .catch(() => {
        // Resolution as a whole failed (it shouldn't — individual images already
        // degrade on their own). Show the unresolved markdown rather than nothing.
        show(wrap(body))
      })
  }, [kind, source, theme, path, worktreeId])

  // Intercept anchor clicks inside the (same-origin, script-free) markdown frame:
  // the sandbox would otherwise navigate the tiny iframe itself. Reattach on each
  // `load` because a srcDoc rebuild (theme/source change) replaces contentDocument.
  useEffect(() => {
    if (kind !== 'markdown') return
    const iframe = iframeRef.current
    if (!iframe) return

    const onClick = (e: MouseEvent): void => {
      const anchor = (e.target as HTMLElement)?.closest?.('a')
      const href = anchor?.getAttribute('href')
      if (!anchor || !href) return
      e.preventDefault() // stop the sandboxed frame from navigating itself
      // Pure in-page fragment (#heading) — nothing to open.
      if (href.startsWith('#')) return
      const resolved = anchor.href // absolute URL resolved by the browser
      if (/^https?:\/\//i.test(resolved)) {
        onLink(resolved, e.ctrlKey || e.metaKey)
      } else {
        // mailto:, tel:, etc. — hand off to the OS.
        onLink(resolved, true)
      }
    }

    const attach = (): void => {
      const cdoc = iframe.contentDocument
      if (cdoc) cdoc.addEventListener('click', onClick)
    }
    const detach = (): void => {
      const cdoc = iframe.contentDocument
      if (cdoc) cdoc.removeEventListener('click', onClick)
    }

    iframe.addEventListener('load', attach)
    // The frame may already be loaded (effect re-run without a fresh load).
    attach()
    return () => {
      iframe.removeEventListener('load', attach)
      detach()
    }
  }, [kind, doc, onLink])

  // SVG renders via an <img> data URL — script-safe, like the iframe sandbox.
  if (kind === 'svg') {
    return <ImageView src={`data:image/svg+xml;utf8,${encodeURIComponent(source)}`} alt="SVG preview" />
  }

  return (
    <iframe
      ref={iframeRef}
      title="preview"
      // allow-same-origin (no allow-scripts) lets the parent read the frame's DOM
      // to intercept link clicks; scripts stay disabled so repo content is inert.
      sandbox={kind === 'markdown' ? 'allow-same-origin' : ''}
      srcDoc={doc}
      className={`h-full w-full border-0 ${kind === 'html' ? 'bg-white' : ''}`}
    />
  )
}

/* ---- Image view ----------------------------------------------------------- */

/** Centered image on a checkerboard (so transparency reads), with natural size. */
function ImageView({ src, alt }: { src: string; alt: string }): JSX.Element {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2.5 p-6">
      <img
        src={src}
        alt={alt}
        onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        className="min-h-0 max-h-full max-w-full rounded border border-line-2 object-contain [background:repeating-conic-gradient(var(--checker-a)_0%_25%,var(--checker-b)_0%_50%)_0_0/16px_16px]"
      />
      {dims && (
        <span className="flex-none font-mono text-[10px] text-faint">
          {dims.w} × {dims.h}
        </span>
      )}
    </div>
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
export default function EditorTab({ tab, active }: { tab: Tab; active: boolean }): JSX.Element {
  // The tab's OWN worktree, never the globally active one. Every read this
  // component makes — the file tree, file contents, diffs, and the preview's
  // inlined images — has to be against the repo whose file the tab is showing.
  // Reading `activeWorktree(store)` instead coupled all of that to a value the
  // cockpit's worktree switcher changes underneath a still-mounted tab: the load
  // effects re-ran against the *other* repo while `content`/`draft` still held
  // this repo's text, spending IPC on files nobody asked for and seeding the
  // markdown asset cache with the wrong worktree's bytes. A tab belongs to
  // exactly one worktree for its whole life (tabs only ever move between panes
  // of their own worktree — see moveTab/moveTabToEdge in main/ipc), so
  // `tab.worktreeId` is both correct and stable.
  const worktreeId = tab.worktreeId
  // Shared, per-worktree file tree: dedupes fetches across editor tabs and only
  // refetches on state changes while this tab is active (see lib/fileTree).
  const { tree, refresh: refetchTree } = useFileTree(worktreeId, active)
  // Contents of expanded ignored directories, fetched on demand (the shared
  // tree collapses fully-ignored dirs to a single childless node).
  const [lazyChildren, setLazyChildren] = useState<Record<string, FileNode[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<Selected | null>(null)
  const [mode, setMode] = useState<ViewMode>('file')
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [imageData, setImageData] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [menu, setMenu] = useState<{ node: FileNode; pos: MenuPos } | null>(null)
  const reqRef = useRef(0)

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

  const loadDir = useCallback(
    (path: string): void => {
      void window.orbital
        .listDir(worktreeId, path)
        .then((kids) => setLazyChildren((m) => ({ ...m, [path]: kids })))
        .catch(() => {
          // Unreadable (e.g. removed since the tree was fetched) — stays empty.
        })
    },
    [worktreeId]
  )

  const openFile = useCallback((node: FileNode, staged = false): void => {
    reqRef.current++
    setSelected({ path: node.path, gitState: node.gitState, staged })
    // Images open on the rendered image — their "diff" is just a binary notice.
    setMode(!imageMime(node.path) && (staged || node.gitState) ? 'diff' : 'file')
    setDiff(null)
    setContent(null)
    setImageData(null)
    setLoading(false)
  }, [])

  const openMenu = useCallback((e: React.MouseEvent, node: FileNode): void => {
    e.preventDefault()
    e.stopPropagation()
    // The height passed to the clamp is the tallest variant (a changed file,
    // which adds the git block); over-estimating only biases the menu upward,
    // whereas under-estimating would let the bottom items fall off-screen.
    setMenu({ node, pos: clampMenuPos(e, FILE_MENU_WIDTH, 340) })
  }, [])

  /**
   * A file operation from the tree's context menu landed. Refetch immediately
   * rather than waiting on the filesystem watcher — its broadcast is debounced,
   * and a tree that lags a click the user just made reads as a failure.
   * The open file then has to be kept pointed at something that still exists.
   */
  const onFileMutated = useCallback(
    (m: FileMutation): void => {
      setLazyChildren({})
      refetchTree()
      if (m.kind === 'created') {
        // Reveal what was just made: expand the directory it landed in, and
        // open a new file straight away (that's why you made it).
        const slash = m.path.lastIndexOf('/')
        if (slash !== -1) setExpanded((e) => ({ ...e, [m.path.slice(0, slash)]: true }))
        if (m.type === 'file') {
          openFile({ name: m.path.slice(slash + 1), path: m.path, type: 'file' })
        }
      } else if (m.kind === 'renamed') {
        // Follow the open file to its new path — including the case where an
        // ANCESTOR directory was what got renamed.
        setSelected((s) => {
          if (!s) return s
          if (s.path === m.from) return { ...s, path: m.to }
          if (s.path.startsWith(`${m.from}/`)) return { ...s, path: m.to + s.path.slice(m.from.length) }
          return s
        })
      } else {
        // Deleted. Keeping a binned file open in an editable buffer would invite
        // saving it back into existence, so close it.
        setSelected((s) => (s && (s.path === m.path || s.path.startsWith(`${m.path}/`)) ? null : s))
      }
    },
    [refetchTree, openFile]
  )

  // Fetch whatever the current mode needs and doesn't have yet.
  useEffect(() => {
    if (!selected) return
    const mime = imageMime(selected.path)
    const needDiff = mode === 'diff' && diff === null
    const needImage = mode !== 'diff' && !!mime && imageData === null
    const needContent = mode !== 'diff' && !mime && content === null
    if (!needDiff && !needImage && !needContent) return
    const id = ++reqRef.current
    setLoading(true)
    void (async () => {
      try {
        if (needDiff) {
          const d = await window.orbital.gitDiff(worktreeId, selected.path, selected.staged)
          if (reqRef.current === id) setDiff(d)
        }
        if (needImage) {
          const b64 = await window.orbital.readFileBase64(worktreeId, selected.path)
          if (reqRef.current === id) setImageData(`data:${mime};base64,${b64}`)
        }
        if (needContent) {
          const c = await window.orbital.readFile(worktreeId, selected.path)
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
  }, [worktreeId, selected, mode, diff, content, imageData])

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
    if (!selected) return
    await window.orbital.writeFile(worktreeId, selected.path, draft)
    const c = await window.orbital.readFile(worktreeId, selected.path)
    setContent(c)
    setDraft(c)
    setDiff(null) // saved content invalidates any cached diff
  }

  // Link clicks in the markdown preview: Ctrl/Cmd → OS external browser; a plain
  // click → a new internal browser tab in this pane (per the link-handling spec).
  const onPreviewLink = useCallback(
    (href: string, external: boolean): void => {
      if (external) void window.orbital.openExternal(href)
      else void window.orbital.createTab(worktreeId, tab.paneId, 'browser', { url: href })
    },
    [worktreeId, tab.paneId]
  )

  const kind = selected ? previewKind(selected.path) : null
  const isImage = !!selected && !!imageMime(selected.path)
  const dirty = content !== null && draft !== content
  const canDiff = !!selected && (!!selected.gitState || selected.staged)
  const modes: { id: ViewMode; label: string }[] = [
    { id: 'file', label: 'File' },
    ...(canDiff ? [{ id: 'diff' as const, label: 'Diff' }] : []),
    ...(kind ? [{ id: 'preview' as const, label: 'Preview' }] : [])
  ]

  return (
    <div className="flex h-full w-full bg-pane">
      {/* File tree */}
      <div className="flex w-56 flex-none flex-col border-r border-line bg-rail/40 py-1.5">
        <div className="flex flex-none items-center justify-between pb-1 pl-3 pr-2">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.5px] text-faint">Files</span>
          <button
            type="button"
            title="Refresh file tree"
            aria-label="Refresh file tree"
            onClick={() => {
              // Drop lazily loaded ignored-dir contents too; expanded ones refetch.
              setLazyChildren({})
              refetchTree()
            }}
            className={`flex-none rounded p-0.5 text-faint hover:text-text-2 ${FOCUS}`}
          >
            <RefreshCw size={12} strokeWidth={1.5} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
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
                lazyChildren={lazyChildren}
                loadDir={loadDir}
                onContextMenu={openMenu}
              />
            ))
          )}
        </div>
      </div>

      {menu && (
        <FileContextMenu
          worktreeId={worktreeId}
          node={menu.node}
          pos={menu.pos}
          onClose={() => setMenu(null)}
          onMutated={onFileMutated}
        />
      )}

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

                {mode === 'file' && !isImage && content !== null && (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setDraft(content)}
                      disabled={!dirty}
                      className={`flex items-center gap-1.5 rounded-chip px-2 py-1 text-[11px] font-medium text-text-3 hover:bg-hover disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`}
                    >
                      <X size={13} strokeWidth={1.5} />
                      Cancel
                    </button>
                    <button
                      onClick={() => void save()}
                      disabled={!dirty}
                      className={`flex items-center gap-1.5 rounded-chip bg-accent px-2.5 py-1 text-[11px] font-semibold text-on-accent hover:bg-accent-hover transition-colors disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`}
                    >
                      <Save size={13} strokeWidth={1.5} />
                      Save
                    </button>
                  </div>
                )}

                {modes.length > 1 && (
                  <div className="flex items-center rounded-[7px] border border-line-2 bg-bg p-[2px]">
                    {modes.map((m) => (
                      <button
                        key={m.id}
                        // The draft survives mode switches — unsaved edits are
                        // not discarded by peeking at the Diff or Preview.
                        onClick={() => setMode(m.id)}
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
                diff && <DiffView diff={diff} path={selected.path} />
              ) : isImage ? (
                imageData ? (
                  <ImageView src={imageData} alt={selected.path} />
                ) : (
                  <div className="px-4 py-3 font-mono text-[11px] text-faint">
                    Image could not be read{selected.gitState === 'deleted' ? ' (deleted)' : ''}.
                  </div>
                )
              ) : content === null ? (
                <div className="px-4 py-3 font-mono text-[11px] text-faint">
                  File could not be read{selected.gitState === 'deleted' ? ' (deleted)' : ''}.
                </div>
              ) : mode === 'preview' && kind ? (
                // Preview renders the draft, so unsaved edits show up live.
                <Preview
                  kind={kind}
                  source={draft}
                  path={selected.path}
                  worktreeId={worktreeId}
                  onLink={onPreviewLink}
                />
              ) : (
                <CodeEditor path={selected.path} value={draft} onChange={setDraft} />
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
  changedDirs,
  lazyChildren,
  loadDir,
  onContextMenu
}: {
  node: FileNode
  depth: number
  expanded: Record<string, boolean>
  toggle: (path: string) => void
  onSelect: (node: FileNode) => void
  selectedPath: string | null
  changedDirs: Set<string>
  lazyChildren: Record<string, FileNode[]>
  loadDir: (path: string) => void
  /** Right-click on this row — opens the file operations menu for its node. */
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void
}): JSX.Element {
  const pad = { paddingLeft: depth * 12 + 8 }
  const open = node.type === 'dir' && !!expanded[node.path]
  // Ignored dirs arrive without children — fetch their contents when expanded
  // (and again after a manual refresh clears the lazy cache).
  const needsLoad = open && !!node.ignored && !node.children && !lazyChildren[node.path]
  useEffect(() => {
    if (needsLoad) loadDir(node.path)
  }, [needsLoad, node.path, loadDir])
  const dim = node.ignored ? 'opacity-60' : ''

  if (node.type === 'dir') {
    const dirty = changedDirs.has(node.path)
    const children = node.children ?? lazyChildren[node.path]
    return (
      <>
        <button
          onClick={() => toggle(node.path)}
          onContextMenu={(e) => onContextMenu(e, node)}
          style={pad}
          className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12px] text-text-3 hover:bg-hover ${dim} ${FOCUS}`}
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
        {open && children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            onSelect={onSelect}
            selectedPath={selectedPath}
            changedDirs={changedDirs}
            lazyChildren={lazyChildren}
            loadDir={loadDir}
            onContextMenu={onContextMenu}
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
      onContextMenu={(e) => onContextMenu(e, node)}
      style={pad}
      className={`flex w-full items-center gap-2 py-1 pr-2 text-left text-[12px] hover:bg-hover ${
        isSelected ? 'bg-accent/10 text-text' : 'text-text-3'
      } ${dim} ${FOCUS}`}
    >
      {badge ? (
        <span
          className={`flex size-3.5 flex-none items-center justify-center rounded-[3px] font-mono text-[9px] font-bold ${badge.cls}`}
        >
          {badge.letter}
        </span>
      ) : imageMime(node.path) || extOf(node.path) === 'svg' ? (
        <ImageIcon size={13} strokeWidth={1.5} className="flex-none text-faint" />
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

/** A shiki-themed token line: colored spans reassembled per diff line. */
type TokenLine = { content: string; color?: string }[]

/**
 * Tokenize the diff's code lines in one shiki pass (hunk/meta lines become
 * blank placeholders so indices stay aligned). Null while loading, for unknown
 * grammars, and for oversized diffs — callers fall back to flat coloring.
 */
function useDiffTokens(diff: FileDiff, path: string): TokenLine[] | null {
  const [tokens, setTokens] = useState<TokenLine[] | null>(null)
  const theme = useResolvedTheme()

  const code = useMemo(
    () =>
      diff.lines
        .map((l) => (l.type === 'add' || l.type === 'del' || l.type === 'context' ? stripSign(l) : ''))
        .join('\n'),
    [diff]
  )

  useEffect(() => {
    let alive = true
    setTokens(null)
    const lang = langFor(path)
    if (!lang || diff.binary || code.length > HIGHLIGHT_MAX) return
    void import('shiki')
      .then(({ codeToTokens }) => codeToTokens(code, { lang: lang as BundledLanguage, theme: shikiTheme(theme) }))
      .then((r) => {
        if (alive) setTokens(r.tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color }))))
      })
      .catch((err) => {
        // Unknown grammar / load failure — flat coloring stays up.
        console.warn(`shiki diff highlight failed for ${path}:`, err)
      })
    return () => {
      alive = false
    }
    // theme is a dep so diff syntax colors follow the app theme.
  }, [code, path, diff.binary, theme])

  return tokens
}

function DiffView({ diff, path }: { diff: FileDiff; path: string }): JSX.Element {
  const tokens = useDiffTokens(diff, path)

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
        const signCls =
          line.type === 'add'
            ? 'text-diff-add'
            : line.type === 'del'
              ? 'text-diff-del'
              : line.type === 'meta'
                ? 'text-faint'
                : 'text-text-3'
        const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '
        const isCode = line.type === 'add' || line.type === 'del' || line.type === 'context'
        const lineTokens = isCode && tokens ? tokens[i] : null
        return (
          <div key={i} className={`flex ${rowBg}`}>
            <span className="w-[30px] flex-none pr-1.5 text-right text-faint">{line.oldNo ?? ''}</span>
            <span className="w-[30px] flex-none pr-3 text-right text-faint">{line.newNo ?? ''}</span>
            <span className={`whitespace-pre ${signCls}`}>
              {sign}{' '}
              {lineTokens && lineTokens.length > 0 ? (
                lineTokens.map((t, j) => (
                  <span key={j} style={t.color ? { color: t.color } : undefined}>
                    {t.content}
                  </span>
                ))
              ) : (
                stripSign(line)
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
