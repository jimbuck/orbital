import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, FileText, Image as ImageIcon, RefreshCw, X } from 'lucide-react'
import { marked } from 'marked'
import type { Tab, FileNode, FileDiff, GitFileState } from '@shared/types'
import { useResolvedTheme, type ResolvedTheme } from '@renderer/lib/theme'
import { useFileTree } from '@renderer/lib/fileTree'
import { extOf, imageMime, resolveMarkdownImages } from '@renderer/lib/markdownAssets'
import { editCopy, editCut, editPaste, editSelectAll } from '@renderer/lib/editActions'
import { clampMenuPos, type MenuPos } from '../rail/menu'
import FileContextMenu, { FILE_MENU_WIDTH, type FileMutation } from './FileContextMenu'
import EditorContextMenu, { EDITOR_MENU_HEIGHT, EDITOR_MENU_WIDTH, type EditorAction } from './EditorContextMenu'
import { fireAndForget } from '@renderer/lib/bridge'
import { useStore } from '@renderer/store'
import { cleanIpcError } from '@renderer/lib/ipcError'
import { Spinner } from '@renderer/lib/status'
import { HIGHLIGHT_MAX, highlightHtml, langFor } from '@renderer/lib/highlight'
import DiffView from './DiffView'

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

/**
 * Editable source view with live syntax highlighting: a transparent-text
 * textarea (caret + input) stacked over a shiki-rendered mirror of the draft,
 * scroll-synced, with a line-number gutter down the left. All three layers
 * share the exact font metrics, padding and line height, so the glyphs and
 * numbers line up. Falls back to a plain visible textarea when the grammar is
 * unknown or the file is too large to highlight.
 *
 * The gutter is painted LAST (on top) with an opaque background: padding
 * scrolls with content in a textarea, so on a horizontal scroll the text would
 * otherwise slide out under the numbers. It ignores the pointer, so clicks
 * there still land in the textarea.
 */
export function CodeEditor({
  path,
  value,
  onChange
}: {
  path: string
  value: string
  onChange: (next: string) => void
}): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ pos: MenuPos; hasSelection: boolean } | null>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const theme = useResolvedTheme()

  // One number per line. wrap="off" on the textarea means a source line is
  // exactly one visual line, so a plain count is all the gutter needs.
  const lineCount = useMemo(() => value.split('\n').length, [value])
  const lineNumbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount])
  // Widths are in `ch` of the shared monospace font, so the gutter grows with
  // the digit count and the text columns move over by exactly the same amount.
  const digits = Math.max(2, String(lineCount).length)
  const gutterWidth = `calc(${digits}ch + 20px)`
  const textPadLeft = `calc(${digits}ch + 32px)`

  useEffect(() => {
    const lang = langFor(path)
    if (!lang || value.length > HIGHLIGHT_MAX) {
      setHtml(null)
      return
    }
    let alive = true
    // Tiny debounce so fast typing doesn't queue a highlight per keystroke.
    const t = setTimeout(() => {
      // The trailing newline keeps the mirror's height in step with the
      // textarea when the draft ends mid-newline.
      void highlightHtml(value + '\n', lang, theme)
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
    const ta = taRef.current
    if (!ta) return
    const mirror = mirrorRef.current
    if (mirror) {
      mirror.scrollTop = ta.scrollTop
      mirror.scrollLeft = ta.scrollLeft
    }
    const gutter = gutterRef.current
    if (gutter) gutter.scrollTop = ta.scrollTop
  }

  useEffect(syncScroll, [html, lineCount])

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const ta = taRef.current
    if (!ta) return
    setMenu({
      pos: clampMenuPos(e, EDITOR_MENU_WIDTH, EDITOR_MENU_HEIGHT),
      hasSelection: ta.selectionStart !== ta.selectionEnd
    })
  }

  /**
   * The menu's buttons don't take focus, so the textarea is normally still the
   * active element; focus() is belt-and-braces (it keeps the selection range
   * either way) so the focus-dispatched edit helpers can't miss.
   */
  const runAction = (action: EditorAction): void => {
    setMenu(null)
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    switch (action) {
      case 'undo':
        document.execCommand('undo')
        break
      case 'redo':
        document.execCommand('redo')
        break
      case 'cut':
        editCut()
        break
      case 'copy':
        editCopy()
        break
      case 'paste':
        editPaste()
        break
      case 'selectAll':
        editSelectAll()
        break
    }
  }

  return (
    <div className="relative h-full w-full font-mono text-[12px] leading-[1.6]">
      {html !== null && (
        <div
          ref={mirrorRef}
          aria-hidden
          className="shiki-view pointer-events-none absolute inset-0 overflow-hidden whitespace-pre py-3 pr-4"
          style={{ paddingLeft: textPadLeft }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onContextMenu={openMenu}
        onKeyDown={(e) => {
          // Tab indents instead of moving focus; execCommand keeps native undo.
          if (e.key === 'Tab') {
            e.preventDefault()
            document.execCommand('insertText', false, '  ')
          }
        }}
        spellCheck={false}
        wrap="off"
        style={{ paddingLeft: textPadLeft }}
        className={`allow-select absolute inset-0 h-full w-full resize-none whitespace-pre bg-transparent py-3 pr-4 font-mono text-[12px] leading-[1.6] ${
          html !== null
            ? `text-transparent ${theme === 'light' ? 'caret-[#17202e]' : 'caret-[#e6ebf2]'}`
            : 'text-text-2'
        } ${FOCUS}`}
      />
      <div
        ref={gutterRef}
        aria-hidden
        data-testid="line-gutter"
        style={{ width: gutterWidth }}
        className="pointer-events-none absolute inset-y-0 left-0 z-10 select-none overflow-hidden whitespace-pre border-r border-line bg-pane py-3 pr-2 text-right text-faint"
      >
        {lineNumbers}
      </div>

      {menu && (
        <EditorContextMenu
          pos={menu.pos}
          hasSelection={menu.hasSelection}
          onAction={runAction}
          onClose={() => setMenu(null)}
        />
      )}
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
/**
 * How long typing has to pause before the preview re-renders.
 *
 * Every keystroke used to rebuild the whole document: `marked.parse`, a
 * template parse/serialise that re-inlines every image's base64 into a fresh
 * `srcDoc`, and then the iframe re-decoding every one of those images. Measured
 * at roughly 1 ms of main-thread JS per MiB of `srcDoc` per keystroke before the
 * frame does anything — and nobody reads the preview mid-word. Waiting for a
 * pause collapses a burst of keystrokes into one render; a file switch or a
 * theme flip is not typing and still renders at once.
 */
export const PREVIEW_TYPING_DEBOUNCE_MS = 150

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
  // The theme that document was rendered with, so a theme flip is told apart
  // from a keystroke (see the debounce below).
  const shownThemeRef = useRef<ResolvedTheme | null>(null)

  useEffect(() => {
    // Identity of the thing being previewed: a file (or worktree) switch changes
    // it, a keystroke or a theme flip does not.
    const docId = JSON.stringify([worktreeId ?? '', kind, path])

    const render = (): void => {
      const id = ++reqRef.current
      const show = (html: string): void => {
        if (reqRef.current !== id) return
        shownRef.current = docId
        shownThemeRef.current = theme
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
    }

    // The same document, in the same theme, is already on screen: the only
    // thing that can have changed is the source, i.e. the user is typing.
    // Hold the last good render (see above) and re-render once typing pauses;
    // a further keystroke inside the window restarts it via the cleanup.
    // Anything else — first render, file switch, theme flip — shows at once.
    const typing = shownRef.current === docId && shownThemeRef.current === theme
    if (!typing) {
      render()
      return
    }
    const timer = setTimeout(render, PREVIEW_TYPING_DEBOUNCE_MS)
    return () => clearTimeout(timer)
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

/* ---- Open files ---------------------------------------------------------- */

/**
 * One open buffer: the file's identity plus everything fetched or typed for
 * it. A buffer lives as long as its pill is in the strip, so switching between
 * files is instant and an unsaved draft survives a trip to another file — the
 * VS Code tab model, in miniature. Everything is per file, view mode included:
 * peeking at one file's Diff must not flip another's editor.
 */
interface OpenFile {
  path: string
  gitState?: GitFileState
  /** Viewing the staged (index) side of the diff (from tab config). */
  staged: boolean
  mode: ViewMode
  diff: FileDiff | null
  content: string | null
  imageData: string | null
  draft: string
  loading: boolean
  /** Why the last content/diff/image fetch failed (main's message, e.g. the size cap), if it did. */
  loadError: string | null
  /** Why the last save failed, if it did. The draft is kept; the message sits by the path. */
  saveError: string | null
}

function freshFile(node: FileNode, staged: boolean): OpenFile {
  return {
    path: node.path,
    gitState: node.gitState,
    staged,
    // Images open on the rendered image — their "diff" is just a binary notice.
    mode: !imageMime(node.path) && (staged || node.gitState) ? 'diff' : 'file',
    diff: null,
    content: null,
    imageData: null,
    draft: '',
    loading: false,
    loadError: null,
    saveError: null
  }
}

/** Edits not yet written to disk. */
const isDirty = (f: OpenFile): boolean => f.content !== null && f.draft !== f.content

const baseName = (path: string): string => path.split('/').pop() || path

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
 * One open file in the strip: icon, name, and a close control that doubles as
 * the unsaved marker — a dot while the file has edits, which becomes the X as
 * soon as the pointer is over the pill (VS Code's convention, so the dot never
 * has to be aimed at). Middle-click closes, like a browser tab. The whole pill
 * is the tab; the X inside it is its own button, so the two never fight.
 */
function FilePill({
  file,
  active,
  onSelect,
  onClose
}: {
  file: OpenFile
  active: boolean
  onSelect: () => void
  onClose: () => void
}): JSX.Element {
  const dirty = isDirty(file)
  const name = baseName(file.path)
  const Icon = imageMime(file.path) || extOf(file.path) === 'svg' ? ImageIcon : FileText
  const ref = useRef<HTMLDivElement>(null)
  // A strip that overflows scrolls the newly active pill into view, so opening
  // a sixth file never lands on a pill you can't see. (jsdom has no scrollIntoView.)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      aria-label={file.path}
      title={file.path}
      tabIndex={0}
      data-dirty={dirty || undefined}
      onClick={onSelect}
      onMouseDown={(e) => {
        // Middle button: no autoscroll cursor while we close the pill.
        if (e.button === 1) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button === 1) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        } else if (e.key === 'Delete') {
          e.preventDefault()
          onClose()
        }
      }}
      className={`group flex h-[26px] flex-none cursor-pointer select-none items-center gap-1.5 rounded-chip pl-2 pr-1 text-[11.5px] ${
        active ? 'bg-accent/12 text-text' : 'text-muted hover:bg-hover hover:text-text-2'
      } ${FOCUS}`}
    >
      <Icon size={12} strokeWidth={1.5} className={`flex-none ${active ? 'text-text-3' : 'text-faint'}`} />
      <span className="max-w-[180px] truncate font-mono">{name}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={dirty ? `Close ${name} (unsaved changes)` : `Close ${name}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className={`grid size-4 flex-none place-items-center rounded-[4px] hover:bg-line-strong hover:text-text ${FOCUS}`}
      >
        {dirty && <span aria-hidden className="size-[7px] rounded-full bg-current group-hover:hidden" />}
        <X
          size={12}
          strokeWidth={1.5}
          className={
            dirty
              ? 'hidden group-hover:block'
              : active
                ? ''
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          }
        />
      </button>
    </div>
  )
}

/**
 * The save / discard / cancel prompt for closing a file with unsaved edits.
 * Drawn over the editor's own content column rather than through the app
 * modal hub: the question is about this pane, and the pills behind it stay in
 * view so it's obvious which file is being asked about. Save is the default;
 * Escape (or clicking the scrim) is Cancel, so a stray key can't lose work.
 */
function UnsavedPrompt({
  name,
  busy,
  error,
  onSave,
  onDiscard,
  onCancel
}: {
  name: string
  busy: boolean
  error: string | null
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}): JSX.Element {
  const saveRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    saveRef.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const btn = `rounded-btn px-3 py-[6px] text-[12px] font-semibold transition-colors disabled:cursor-default disabled:opacity-60 ${FOCUS}`
  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-scrim p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        style={{ animation: 'panelIn .16s ease-out' }}
        className="w-[360px] max-w-full rounded-modal border border-line-strong bg-panel p-[18px] elev-modal"
      >
        <div id="unsaved-title" className="text-[13.5px] font-bold text-text">
          Save changes to <span className="font-mono">{name}</span>?
        </div>
        <div className="mt-1.5 text-[12px] leading-relaxed text-dim">
          Your changes will be lost if you close it without saving.
        </div>
        {error && <div className="allow-select mt-2 text-[11.5px] leading-snug text-red-2">{error}</div>}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onDiscard}
            className={`${btn} mr-auto bg-red/15 text-red-2 hover:bg-red/25 disabled:hover:bg-red/15`}
          >
            Don&apos;t Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={`${btn} border border-line-2 bg-hover text-text-2 hover:bg-panel-2 disabled:hover:bg-hover`}
          >
            Cancel
          </button>
          <button
            ref={saveRef}
            type="button"
            disabled={busy}
            onClick={onSave}
            className={`${btn} flex items-center gap-1.5 bg-accent text-on-accent hover:bg-accent-hover disabled:hover:bg-accent`}
          >
            {busy && <Spinner className="text-[10px]" />}
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The editor tab: a recursive file tree on the left (git-state badges on files,
 * change dots on directories) and, on the right, the open files as a strip of
 * pills over the active one's content, with a File / Diff / Preview mode
 * toggle — Diff when the file has changes, Preview for markdown and HTML.
 * Ctrl+S saves the active file; closing a file with unsaved edits asks first.
 */
export default function EditorTab({ tab, active }: { tab: Tab; active: boolean }): JSX.Element {
  // The tab's OWN worktree, never the globally active one. Every read this
  // component makes — the file tree, file contents, diffs, and the preview's
  // inlined images — has to be against the repo whose file the tab is showing.
  // Reading `activeWorktree(store)` instead coupled all of that to a value the
  // cockpit's worktree switcher changes underneath a still-mounted tab: the load
  // effects re-ran against the *other* repo while the buffers still held this
  // repo's text, spending IPC on files nobody asked for and seeding the
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
  /** Open buffers, in pill order. */
  const [files, setFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  /** Path of the dirty file whose close is waiting on the save / discard prompt. */
  const [closing, setClosing] = useState<string | null>(null)
  const [closeBusy, setCloseBusy] = useState(false)
  const [menu, setMenu] = useState<{ node: FileNode; pos: MenuPos } | null>(null)
  // Latest fetch id per path, so a slow response for a buffer that has since
  // been closed (or closed and reopened) is dropped rather than applied.
  const reqRef = useRef(new Map<string, number>())
  const bumpReq = (path: string): number => {
    const id = (reqRef.current.get(path) ?? 0) + 1
    reqRef.current.set(path, id)
    return id
  }

  const patch = useCallback((path: string, fn: (f: OpenFile) => OpenFile): void => {
    setFiles((fs) => fs.map((f) => (f.path === path ? fn(f) : f)))
  }, [])

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

  /** Open a file in a new pill, or bring its existing pill to the front. */
  const openFile = useCallback((node: FileNode, staged = false): void => {
    setFiles((fs) => (fs.some((f) => f.path === node.path) ? fs : [...fs, freshFile(node, staged)]))
    setActivePath(node.path)
  }, [])

  /**
   * The git panel asked this editor to show a file's diff (store.editorOpen).
   * A file that is already open is pointed at the requested side and its diff
   * refetched — the panel's row is fresher than whatever was cached. The git
   * state travels with the request so the file opens straight onto its diff
   * even if the tree has not caught up with the change yet.
   */
  const editorOpen = useStore((s) => s.editorOpen)
  // Requests made before this tab mounted were for some other editor.
  const handledSeqRef = useRef(editorOpen?.seq ?? 0)
  useEffect(() => {
    if (!editorOpen || editorOpen.tabId !== tab.id || editorOpen.seq === handledSeqRef.current) return
    handledSeqRef.current = editorOpen.seq
    const { path, staged, gitState } = editorOpen
    const node = findNode(tree, path) ?? { name: baseName(path), path, type: 'file' as const }
    setFiles((fs) => {
      if (!fs.some((f) => f.path === path)) {
        return [...fs, freshFile({ ...node, gitState: node.gitState ?? gitState }, staged)]
      }
      return fs.map((f) =>
        f.path === path
          ? {
              ...f,
              staged,
              gitState: f.gitState ?? gitState,
              diff: null,
              mode: imageMime(path) ? f.mode : 'diff'
            }
          : f
      )
    })
    setActivePath(path)
    setClosing(null)
  }, [editorOpen, tab.id, tree])

  /**
   * Close every open file matching `gone`. If the active one goes, the pill
   * after it takes over (or the one before, at the end of the strip).
   */
  const dropFiles = (gone: (path: string) => boolean): void => {
    for (const f of files) if (gone(f.path)) bumpReq(f.path)
    setFiles((fs) => fs.filter((f) => !gone(f.path)))
    if (closing !== null && gone(closing)) setClosing(null)
    if (activePath !== null && gone(activePath)) {
      const i = files.findIndex((f) => f.path === activePath)
      const after = files.slice(i + 1).find((f) => !gone(f.path))
      const before = files
        .slice(0, Math.max(i, 0))
        .reverse()
        .find((f) => !gone(f.path))
      setActivePath((after ?? before)?.path ?? null)
    }
  }

  /** Close a pill — straight away when clean, via the prompt when it has edits. */
  const requestClose = (path: string): void => {
    const f = files.find((x) => x.path === path)
    if (!f) return
    if (isDirty(f)) setClosing(path)
    else dropFiles((p) => p === path)
  }

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
   * The open files then have to be kept pointed at things that still exist.
   */
  const onFileMutated = (m: FileMutation): void => {
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
      // Follow every open file to its new path — including the case where an
      // ANCESTOR directory was what got renamed.
      const moved = (p: string): string | null =>
        p === m.from ? m.to : p.startsWith(`${m.from}/`) ? m.to + p.slice(m.from.length) : null
      setFiles((fs) => fs.map((f) => ({ ...f, path: moved(f.path) ?? f.path })))
      setActivePath((p) => (p && moved(p)) || p)
      setClosing((p) => (p && moved(p)) || p)
      // Expansion is keyed by path, so a renamed directory (or one under it)
      // has to carry its open/closed state across to the new key — otherwise
      // renaming an expanded folder snaps it shut in the user's face.
      setExpanded((e) => {
        let changed = false
        const out: Record<string, boolean> = {}
        for (const [key, open] of Object.entries(e)) {
          const next = moved(key)
          if (next !== null) changed = true
          out[next ?? key] = open
        }
        return changed ? out : e
      })
    } else {
      // Deleted. Keeping a binned file open in an editable buffer would invite
      // saving it back into existence, so close it.
      dropFiles((p) => p === m.path || p.startsWith(`${m.path}/`))
    }
  }

  const activeFile = files.find((f) => f.path === activePath) ?? null

  // Fetch whatever the active file's mode needs and doesn't have yet. The
  // effect keys on the fields that decide that, not on the buffer object:
  // patching `loading` or an error onto it must not start a second fetch (or,
  // after a failure, loop forever).
  const aPath = activeFile?.path ?? null
  const aStaged = !!activeFile?.staged
  const aMode = activeFile?.mode ?? 'file'
  const hasDiff = !!activeFile && activeFile.diff !== null
  const hasImage = !!activeFile && activeFile.imageData !== null
  const hasContent = !!activeFile && activeFile.content !== null
  useEffect(() => {
    if (!aPath) return
    const path = aPath
    const mime = imageMime(path)
    const needDiff = aMode === 'diff' && !hasDiff
    const needImage = aMode !== 'diff' && !!mime && !hasImage
    const needContent = aMode !== 'diff' && !mime && !hasContent
    if (!needDiff && !needImage && !needContent) return
    const id = (reqRef.current.get(path) ?? 0) + 1
    reqRef.current.set(path, id)
    const current = (): boolean => reqRef.current.get(path) === id
    patch(path, (f) => ({ ...f, loading: true, loadError: null }))
    void (async () => {
      try {
        if (needDiff) {
          const d = await window.orbital.gitDiff(worktreeId, path, aStaged)
          if (current()) patch(path, (f) => ({ ...f, diff: d }))
        }
        if (needImage) {
          const b64 = await window.orbital.readFileBase64(worktreeId, path)
          if (current()) patch(path, (f) => ({ ...f, imageData: `data:${mime};base64,${b64}` }))
        }
        if (needContent) {
          const c = await window.orbital.readFile(worktreeId, path)
          if (current()) patch(path, (f) => ({ ...f, content: c, draft: c }))
        }
      } catch (err) {
        // Unreadable (deleted since the tree was fetched, over the size cap,
        // ...) — the body shows the reason; content stays null and this effect
        // doesn't re-run.
        if (current()) patch(path, (f) => ({ ...f, loadError: cleanIpcError(err) }))
      } finally {
        if (current()) patch(path, (f) => ({ ...f, loading: false }))
      }
    })()
  }, [worktreeId, aPath, aStaged, aMode, hasDiff, hasImage, hasContent, patch])

  // When a tree refresh changes an open file's git state, follow it: the Diff
  // toggle appears/disappears and a stale diff is refetched. File contents
  // (possibly mid-edit) are left alone.
  useEffect(() => {
    setFiles((fs) => {
      let changed = false
      const out = fs.map((f) => {
        const gs = findNode(tree, f.path)?.gitState
        if (gs === f.gitState) return f
        changed = true
        return { ...f, gitState: gs, diff: null, mode: !gs && !f.staged && f.mode === 'diff' ? 'file' : f.mode }
      })
      return changed ? out : fs
    })
  }, [tree])

  // Auto-open the tab's configured file once the tree is available.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    const fp = tab.config.filePath
    if (!fp || autoOpenedRef.current || tree.length === 0) return
    autoOpenedRef.current = true
    openFile(findNode(tree, fp) ?? { name: baseName(fp), path: fp, type: 'file' }, !!tab.config.diffStaged)
  }, [tab.config.filePath, tab.config.diffStaged, tree, openFile])

  /** Write a buffer's draft to disk. Resolves false (and records why) if the write failed. */
  const save = async (f: OpenFile): Promise<boolean> => {
    if (!isDirty(f)) return true
    const written = f.draft
    try {
      await window.orbital.writeFile(worktreeId, f.path, written)
      const c = await window.orbital.readFile(worktreeId, f.path)
      patch(f.path, (x) => ({
        ...x,
        content: c,
        // Keystrokes that landed during the write stay ahead of what was saved.
        draft: x.draft === written ? c : x.draft,
        diff: null, // saved content invalidates any cached diff
        saveError: null
      }))
      return true
    } catch (err) {
      patch(f.path, (x) => ({ ...x, saveError: cleanIpcError(err) }))
      return false
    }
  }

  const closingFile = closing !== null ? (files.find((f) => f.path === closing) ?? null) : null
  const cancelClose = useCallback(() => setClosing(null), [])
  const saveAndClose = async (): Promise<void> => {
    if (!closingFile) return
    setCloseBusy(true)
    const ok = await save(closingFile)
    setCloseBusy(false)
    if (ok) dropFiles((p) => p === closingFile.path)
  }

  // Ctrl+S / Cmd+S saves the active file from anywhere in the tab — the
  // textarea, the pills, the tree. Nothing else in the window claims it (there
  // is no application menu), so this is the whole binding.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (activeFile) void save(activeFile)
    }
  }

  // Link clicks in the markdown preview: Ctrl/Cmd → OS external browser; a plain
  // click → a new internal browser tab in this pane (per the link-handling spec).
  const onPreviewLink = useCallback(
    (href: string, external: boolean): void => {
      if (external) fireAndForget(window.orbital.openExternal(href))
      else fireAndForget(window.orbital.createTab(worktreeId, tab.paneId, 'browser', { url: href }))
    },
    [worktreeId, tab.paneId]
  )

  const kind = activeFile ? previewKind(activeFile.path) : null
  const isImage = !!activeFile && !!imageMime(activeFile.path)
  const canDiff = !!activeFile && (!!activeFile.gitState || activeFile.staged)
  const modes: { id: ViewMode; label: string }[] = [
    { id: 'file', label: 'File' },
    ...(canDiff ? [{ id: 'diff' as const, label: 'Diff' }] : []),
    ...(kind ? [{ id: 'preview' as const, label: 'Preview' }] : [])
  ]
  const crumbs = activeFile ? activeFile.path.split('/') : []

  return (
    <div className="flex h-full w-full bg-pane" onKeyDown={onKeyDown}>
      {/* File tree */}
      <div data-testid="file-tree" className="flex w-56 flex-none flex-col border-r border-line bg-rail/40 py-1.5">
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
                selectedPath={activePath}
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
          unsavedPaths={files.filter(isDirty).map((f) => f.path)}
          onClose={() => setMenu(null)}
          onMutated={onFileMutated}
        />
      )}

      {/* Content */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {!activeFile ? (
          <div className="flex flex-1 items-center justify-center text-sm text-faint">
            Select a file
          </div>
        ) : (
          <>
            {/* Open-file strip: pills on the left (scrolls sideways when it
                overflows, the wheel doing the scrolling), the active file's
                controls pinned on the right. */}
            <div className="flex h-9 flex-none items-center gap-3 border-b border-line bg-bar pr-3">
              <div
                role="tablist"
                aria-label="Open files"
                onWheel={(e) => {
                  if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY
                }}
                className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {files.map((f) => (
                  <FilePill
                    key={f.path}
                    file={f}
                    active={f.path === activePath}
                    onSelect={() => setActivePath(f.path)}
                    onClose={() => requestClose(f.path)}
                  />
                ))}
              </div>

              <div className="flex flex-none items-center gap-2">
                {activeFile.mode === 'diff' && activeFile.diff && (
                  <span className="flex items-center gap-2 font-mono text-[10px]">
                    <span className="text-diff-add">+{activeFile.diff.additions}</span>
                    <span className="text-diff-del">−{activeFile.diff.deletions}</span>
                  </span>
                )}

                {modes.length > 1 && (
                  <div className="flex items-center rounded-[7px] border border-line-2 bg-bg p-[2px]">
                    {modes.map((m) => (
                      <button
                        key={m.id}
                        // The draft survives mode switches — unsaved edits are
                        // not discarded by peeking at the Diff or Preview.
                        onClick={() => patch(activeFile.path, (f) => ({ ...f, mode: m.id }))}
                        className={`rounded-[5px] px-2 py-[3px] text-[10.5px] font-semibold ${
                          activeFile.mode === m.id ? 'bg-accent/15 text-blue' : 'text-muted hover:text-text-2'
                        } ${FOCUS}`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Breadcrumb: where the active file lives, since the pill only has its name. */}
            <div className="flex h-[22px] flex-none items-center gap-3 border-b border-line px-3 text-[11px]">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden whitespace-nowrap font-mono text-dim">
                {crumbs.map((seg, i) => (
                  <span key={i} className="flex items-center gap-0.5">
                    {i > 0 && <ChevronRight size={11} strokeWidth={1.5} className="flex-none text-faint" />}
                    <span className={i === crumbs.length - 1 ? 'text-text-3' : ''}>{seg}</span>
                  </span>
                ))}
              </div>
              {activeFile.saveError && (
                <span className="allow-select truncate text-red-2" title={activeFile.saveError}>
                  Save failed: {activeFile.saveError}
                </span>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {activeFile.loading ? (
                <div className="px-4 py-3 font-mono text-[11px] text-faint">Loading…</div>
              ) : activeFile.loadError ? (
                <div className="allow-select px-4 py-3 font-mono text-[11px] leading-relaxed text-faint">
                  {isImage ? 'Image' : activeFile.mode === 'diff' ? 'Diff' : 'File'} could not be read
                  {activeFile.gitState === 'deleted' ? ' (deleted)' : ''}.
                  <div className="mt-1 break-words text-red-2">{activeFile.loadError}</div>
                </div>
              ) : activeFile.mode === 'diff' ? (
                activeFile.diff && <DiffView diff={activeFile.diff} path={activeFile.path} />
              ) : isImage ? (
                activeFile.imageData ? (
                  <ImageView src={activeFile.imageData} alt={activeFile.path} />
                ) : (
                  <div className="px-4 py-3 font-mono text-[11px] text-faint">
                    Image could not be read{activeFile.gitState === 'deleted' ? ' (deleted)' : ''}.
                  </div>
                )
              ) : activeFile.content === null ? (
                <div className="px-4 py-3 font-mono text-[11px] text-faint">
                  File could not be read{activeFile.gitState === 'deleted' ? ' (deleted)' : ''}.
                </div>
              ) : activeFile.mode === 'preview' && kind ? (
                // Preview renders the draft, so unsaved edits show up live.
                <Preview
                  kind={kind}
                  source={activeFile.draft}
                  path={activeFile.path}
                  worktreeId={worktreeId}
                  onLink={onPreviewLink}
                />
              ) : (
                <CodeEditor
                  path={activeFile.path}
                  value={activeFile.draft}
                  onChange={(next) => patch(activeFile.path, (f) => ({ ...f, draft: next }))}
                />
              )}
            </div>
          </>
        )}

        {closingFile && (
          <UnsavedPrompt
            name={baseName(closingFile.path)}
            busy={closeBusy}
            error={closingFile.saveError}
            onSave={() => void saveAndClose()}
            onDiscard={() => dropFiles((p) => p === closingFile.path)}
            onCancel={cancelClose}
          />
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
