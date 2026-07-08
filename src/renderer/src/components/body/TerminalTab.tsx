import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Tab } from '@shared/types'
import { useStore, activeFlight } from '@renderer/store'

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

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false

    const term = new Terminal({
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 12,
      theme: {
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
      cursorBlink: true,
      allowProposedApi: true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Ctrl/Cmd-click opens externally; a plain click opens an in-app browser tab.
        if (event.ctrlKey || event.metaKey) {
          void window.orbital.openExternal(uri)
        } else {
          const f = activeFlight(useStore.getState())
          if (f) void window.orbital.createTab(f.id, paneIdRef.current, 'browser', { url: uri })
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

    // Electron exposes no Edit-menu Paste role and navigator.clipboard.readText is
    // permission-blocked, so wire paste ourselves: Ctrl/Cmd+V and the terminal-
    // standard Ctrl+Shift+V read the system clipboard and paste via xterm (which
    // honors bracketed-paste mode, so multi-line pastes into TUIs stay intact).
    // A text-less clipboard image (screenshot) is saved to a scratch PNG and its
    // path pasted instead — agent CLIs like Claude Code attach pasted image paths.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyV') {
        e.preventDefault() // stop the browser's own (often no-op) paste → no double paste
        const text = window.orbital.readClipboard()
        if (text) {
          term.paste(text)
        } else {
          void window.orbital.pasteClipboardImage().then((path) => {
            if (path) term.paste(path.includes(' ') ? `"${path}"` : path)
          })
        }
        return false // and stop xterm from also sending a literal 'v'
      }
      return true
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
      resizeObserver.disconnect()
      inputDisposable.dispose()
      try {
        webgl?.dispose()
      } catch {
        // ignore — the GL context may already be gone.
      }
      term.dispose()
    }
    // Re-create only when the tab identity changes; paneId moves use the ref above.
  }, [tab.id])

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-pane" />
}
