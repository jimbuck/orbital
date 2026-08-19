import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Tab } from '@shared/types'
import { useStore, activeWorktree } from '@renderer/store'
import { useResolvedTheme, type ResolvedTheme } from '@renderer/lib/theme'
import { registerTerminal } from '@renderer/lib/editActions'
import { decodeOsc52 } from '@renderer/lib/terminalClipboard'

/** xterm color palettes, keyed by resolved theme — mirror the app's design tokens. */
const XTERM_THEMES: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: '#0d1118',
    foreground: '#cfd6e2',
    cursor: '#4f8cff',
    selectionBackground: 'rgba(79,140,255,0.3)',
    black: '#0a0d12',
    brightBlack: '#5b6473',
    red: '#ff6b6b',
    green: '#3ddc97',
    yellow: '#e8b54a',
    blue: '#4f8cff',
    magenta: '#9cc0ff',
    cyan: '#6fe6b3',
    white: '#cfd6e2'
  },
  light: {
    background: '#ffffff',
    foreground: '#17202e',
    cursor: '#2f6fe0',
    selectionBackground: 'rgba(47,111,224,0.22)',
    black: '#17202e',
    brightBlack: '#98a2b3',
    red: '#dc2626',
    green: '#12915a',
    yellow: '#b7791f',
    blue: '#2563eb',
    magenta: '#7c3aed',
    cyan: '#0e7490',
    white: '#47515f'
  }
}

/**
 * True when focus sits in something the user is plainly typing into that ISN'T a
 * terminal — a rename field, the editor's draft textarea, a modal input. xterm's
 * own caret lives in a textarea too (`.xterm-helper-textarea`), and stealing
 * focus from one terminal for the one the user just selected is exactly right,
 * so that one doesn't count.
 */
function typingOutsideATerminal(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false
  return !el.classList.contains('xterm-helper-textarea')
}

/**
 * At most one terminal may take focus per effect flush. A single tab opening or
 * being selected is the only claimant, so it always wins — but a bulk mount (app
 * boot, switching worktrees) brings up every visible pane at once, and without
 * this the winner would be whichever pane's effects happened to run last. React
 * runs sibling effects in tree order, so the first pane in the layout wins
 * instead. The claimant is remembered by tab id so StrictMode's mount / unmount /
 * remount pass can re-claim rather than lock itself out.
 */
let focusClaimant: string | null = null
function claimFocus(tabId: string): boolean {
  if (focusClaimant !== null && focusClaimant !== tabId) return false
  focusClaimant = tabId
  // Effects for a commit all flush within one task, so this releases the claim
  // just after that flush — well before any later user-driven commit.
  queueMicrotask(() => {
    focusClaimant = null
  })
  return true
}

/**
 * A live terminal surface backed by xterm.js. The PTY itself lives in main —
 * this component only renders it. On mount it replays the existing scrollback
 * buffer, then streams live data; on unmount it tears down xterm WITHOUT
 * killing the PTY so the session survives tab switches and remounts.
 *
 * `active` is this tab's pane-visibility: an inactive PTY tab stays mounted but
 * `display:none`. It also drives auto-focus (see the effect at the bottom).
 */
export default function TerminalTab({ tab, active }: { tab: Tab; active: boolean }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Keep the latest paneId available to the (long-lived) web-links handler.
  const paneIdRef = useRef(tab.paneId)
  paneIdRef.current = tab.paneId

  const theme = useResolvedTheme()
  // The terminal is created in a mount-only effect, so read the initial palette
  // through a ref (avoids re-running the effect — and dropping scrollback — on
  // theme change); a separate effect below repaints an already-open terminal.
  const themeRef = useRef(theme)
  themeRef.current = theme
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false

    const term = new Terminal({
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 12,
      theme: XTERM_THEMES[themeRef.current],
      cursorBlink: true,
      allowProposedApi: true
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Ctrl/Cmd-click opens externally; a plain click opens an in-app browser tab.
        if (event.ctrlKey || event.metaKey) {
          void window.orbital.openExternal(uri)
        } else {
          const w = activeWorktree(useStore.getState())
          if (w) void window.orbital.createTab(w.id, paneIdRef.current, 'browser', { url: uri })
        }
      })
    )

    term.open(container)

    let webgl: WebglAddon | null = null
    try {
      webgl = new WebglAddon()
      term.loadAddon(webgl)
    } catch {
      // WebGL unavailable (e.g. blacklisted GPU) — fall back to the canvas renderer.
      webgl = null
    }

    // Replay safely without duplication: queue live chunks (each tagged with a
    // cumulative seq) while we fetch the scrollback snapshot, write the snapshot,
    // then flush ONLY queued chunks past the snapshot's seq cut-point, then go live.
    const queue: { data: string; seq: number }[] = []
    let live = false
    const unsubscribe = window.orbital.onTerminalData((evt) => {
      if (evt.tabId !== tab.id) return
      if (live) term.write(evt.data)
      else queue.push({ data: evt.data, seq: evt.seq })
    })
    const exitUnsub = window.orbital.onTerminalExit((evt) => {
      if (evt.tabId !== tab.id) return
      term.write(`\r\n\x1b[2m[process exited${evt.exitCode ? ` with code ${evt.exitCode}` : ''}]\x1b[0m\r\n`)
    })

    void window.orbital.terminalBuffer(tab.id).then((buffer) => {
      if (disposed) return
      if (buffer.data) term.write(buffer.data)
      for (const chunk of queue) {
        if (chunk.seq > buffer.seq) term.write(chunk.data)
      }
      queue.length = 0
      live = true
    })

    // Copy the current selection to the system clipboard, then clear it, so a
    // following Ctrl+C is an interrupt again rather than a second identical copy
    // — that is what makes copy-then-kill two presses of the same key. Terminals
    // are read-only output, so copy never mutates the buffer.
    const copySelection = (): void => {
      const sel = term.getSelection()
      if (sel) {
        window.orbital.writeClipboard(sel)
        term.clearSelection()
      }
    }

    // Electron exposes no Edit-menu Paste role and navigator.clipboard.readText is
    // permission-blocked, so wire paste ourselves. xterm's paste() honors
    // bracketed-paste mode, so multi-line pastes into TUIs stay intact. A text-less
    // clipboard image (screenshot) is saved to a scratch PNG and its path pasted
    // instead — agent CLIs like Claude Code attach pasted image paths.
    const pasteClipboard = (): void => {
      const text = window.orbital.readClipboard()
      if (text) {
        term.paste(text)
      } else {
        void window.orbital.pasteClipboardImage().then((path) => {
          if (path) term.paste(path.includes(' ') ? `"${path}"` : path)
        })
      }
    }

    // xterm.js installs its OWN `paste` DOM listener (on both its textarea and
    // screen element) that writes the clipboard straight to the PTY. Our Ctrl+V
    // key handler and the right-click / Edit-menu paths ALSO paste via
    // pasteClipboard(), so every keyboard paste used to land twice —
    // preventDefault() on the keydown does not cancel the browser's follow-up
    // `paste` event. Swallow that native paste in the capture phase, before it
    // descends to xterm's listeners, making pasteClipboard() the single code
    // path that ever writes a paste to the PTY. (term.paste() drives the PTY
    // directly and never dispatches a DOM `paste` event, so it is unaffected.)
    const suppressNativePaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    container.addEventListener('paste', suppressNativePaste, true)

    // Keyboard copy/paste. Paste is Ctrl/Cmd+V (and the terminal-standard
    // Ctrl+Shift+V, which lands here too). Copy is Ctrl+C alone, and only with a
    // selection: Ctrl+C is overloaded — the OS-wide copy accelerator AND the only
    // way to interrupt a running process — so with nothing selected it must fall
    // through to xterm as SIGINT. copySelection() clears the selection, so
    // copy-then-interrupt is just Ctrl+C twice. Ctrl+Shift+C and Cmd+C are
    // deliberately NOT bound: xterm turns the former into 0x03 anyway, and the
    // latter is macOS-only on a Windows cockpit. `e.code` (not `e.key`) keeps both
    // bindings layout-independent; Alt+Ctrl+C is left alone because TUIs bind it.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyV') {
        e.preventDefault()
        pasteClipboard()
        return false // paste ourselves (above) and stop xterm sending a literal 'v'
      }
      const copyChord = e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyC'
      if (e.type === 'keydown' && copyChord && term.hasSelection()) {
        e.preventDefault()
        copySelection()
        return false // never let a copy also reach the PTY as ^C
      }
      return true
    })

    // OSC 52 (`ESC ] 52 ; <targets> ; <base64> BEL`) is how a TUI running in the
    // terminal — Claude Code, vim, tmux — asks the terminal to put text on the
    // SYSTEM clipboard, which is the only clipboard the program itself cannot
    // reach. xterm.js parses the sequence but ships no handler for it, so
    // unhandled it is silently discarded and the user's copy just never arrives.
    // Decoding lives in decodeOsc52(), which returns null for anything we should
    // not write (read requests, malformed base64, oversized payloads).
    const osc52Disposable = term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data)
      if (text !== null) window.orbital.writeClipboard(text)
      // Handled either way: there is no fallback handler that could do better,
      // and reporting it unhandled would only re-run the same dead end.
      return true
    })

    // Mouse paste (PuTTY model): right-click ALWAYS pastes, and suppresses the
    // browser's default context menu. It used to copy whenever a selection was
    // live, which made sense while right-click was the ONLY way to copy at all.
    // Now that Ctrl+C copies, that branch only bites: a right-click meant as a
    // paste silently copies instead whenever a stray selection happens to be
    // active, quietly overwriting the clipboard. One button, one meaning.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      pasteClipboard()
    }
    container.addEventListener('contextmenu', onContextMenu)

    // Expose copy/paste/select-all to the Edit menu, dispatched by focus.
    const unregisterEdit = registerTerminal(container, {
      copy: copySelection,
      paste: pasteClipboard,
      selectAll: () => term.selectAll()
    })

    const inputDisposable = term.onData((data) => window.orbital.terminalInput(tab.id, data))

    const fitAndReport = (): void => {
      if (disposed) return
      // Skip while hidden (display:none) — clientWidth/Height collapse to 0.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      window.orbital.terminalResize(tab.id, term.cols, term.rows)
    }

    const resizeObserver = new ResizeObserver(() => fitAndReport())
    resizeObserver.observe(container)
    // First fit after the pane has laid out.
    const raf = requestAnimationFrame(fitAndReport)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      unsubscribe()
      exitUnsub()
      container.removeEventListener('paste', suppressNativePaste, true)
      container.removeEventListener('contextmenu', onContextMenu)
      unregisterEdit()
      resizeObserver.disconnect()
      inputDisposable.dispose()
      osc52Disposable.dispose()
      try {
        webgl?.dispose()
      } catch {
        // ignore — the GL context may already be gone.
      }
      term.dispose()
      termRef.current = null
    }
    // Re-create only when the tab identity changes; paneId moves use the ref above.
  }, [tab.id])

  // Repaint an already-open terminal when the theme changes — updating
  // .options.theme keeps scrollback intact (recreating the Terminal would drop it).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = XTERM_THEMES[theme]
  }, [theme])

  // Auto-focus, so a terminal is typeable the moment it shows without a click
  // into the body. Fires on mount (a freshly created tab renders active) and
  // whenever this tab becomes its pane's active tab — selecting a tab is the
  // user asking to use it. Declared after the mount effect above so the Terminal
  // exists by now; React has already dropped the `hidden` class in this commit,
  // so the helper textarea is focusable.
  useEffect(() => {
    if (!active || typingOutsideATerminal() || !claimFocus(tab.id)) return
    termRef.current?.focus()
  }, [active, tab.id])

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-pane" />
}
