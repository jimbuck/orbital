import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Tab } from '@shared/types'
import { useStore, activeWorktree } from '@renderer/store'
import { useResolvedTheme, type ResolvedTheme } from '@renderer/lib/theme'
import { registerTerminal } from '@renderer/lib/editActions'

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
 * A live terminal surface backed by xterm.js. The PTY itself lives in main —
 * this component only renders it. On mount it replays the existing scrollback
 * buffer, then streams live data; on unmount it tears down xterm WITHOUT
 * killing the PTY so the session survives tab switches and remounts.
 */
export default function TerminalTab({ tab }: { tab: Tab }): JSX.Element {
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

    // Copy the current selection to the system clipboard, then clear it (so the
    // next right-click pastes rather than re-copying). Terminals are read-only
    // output, so copy never mutates the buffer.
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

    // Keyboard paste: Ctrl/Cmd+V and the terminal-standard Ctrl+Shift+V.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyV') {
        e.preventDefault()
        pasteClipboard()
        return false // paste ourselves (above) and stop xterm sending a literal 'v'
      }
      return true
    })

    // Mouse copy/paste (PuTTY model): right-click with a selection copies it
    // (then clears it), otherwise right-click pastes. hasSelection() is read once,
    // up front, so exactly one of copy/paste runs — and with the native paste
    // suppressed above, a copy can no longer be raced by a stray second paste.
    // Suppresses the browser's default context menu.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (term.hasSelection()) copySelection()
      else pasteClipboard()
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

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-pane" />
}
