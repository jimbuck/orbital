import { useEffect, useRef, useState } from 'react'
import type { FC, HTMLAttributes, Ref } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink } from 'lucide-react'
import type { Tab } from '@shared/types'

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

// `webview` is a built-in Electron tag with no JSX typings — cast it loosely.
const WebView = 'webview' as unknown as FC<
  HTMLAttributes<HTMLElement> & { src?: string; ref?: Ref<HTMLElement> }
>

/** Add a scheme if the user typed a bare host/path. */
function normalizeUrl(value: string): string {
  const v = value.trim()
  if (!v) return v
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.startsWith('about:')) return v
  return `https://${v}`
}

/**
 * An embedded Electron <webview> with a minimal navigation toolbar:
 * back / forward / reload, an editable address bar, and "open externally".
 */
export default function BrowserTab({ tab }: { tab: Tab }): JSX.Element {
  const initial = tab.config.url ?? ''
  const [url, setUrl] = useState(initial)
  const [input, setInput] = useState(initial)
  // Electron's <webview> exposes goBack/goForward/reload at runtime; type loosely.
  const webviewRef = useRef<any>(null)

  // Keep the address bar in sync as the webview navigates on its own.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onNav = (e: { url?: string }): void => {
      if (e.url) setInput(e.url)
    }
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    return () => {
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
    }
    // Re-bind when the webview first mounts (url goes '' -> non-empty).
  }, [url])

  const navigate = (): void => {
    const next = normalizeUrl(input)
    if (!next) return
    setInput(next)
    setUrl(next)
  }

  const btn = `flex size-7 items-center justify-center rounded text-text-3 hover:bg-hover hover:text-text ${FOCUS}`

  return (
    <div className="flex h-full w-full flex-col bg-pane">
      <div className="flex h-9 flex-none items-center gap-1.5 border-b border-line bg-bar px-2">
        <button onClick={() => webviewRef.current?.goBack()} aria-label="Back" className={btn}>
          <ArrowLeft size={15} strokeWidth={1.5} />
        </button>
        <button onClick={() => webviewRef.current?.goForward()} aria-label="Forward" className={btn}>
          <ArrowRight size={15} strokeWidth={1.5} />
        </button>
        <button onClick={() => webviewRef.current?.reload()} aria-label="Reload" className={btn}>
          <RotateCw size={14} strokeWidth={1.5} />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate()
          }}
          spellCheck={false}
          placeholder="Enter a URL…"
          className={`mx-1 h-6 flex-1 rounded-btn border border-line-2 bg-bg px-2.5 font-mono text-[11.5px] text-text-2 placeholder:text-faint ${FOCUS}`}
        />
        <button
          onClick={() => url && window.orbital.openExternal(url)}
          aria-label="Open externally"
          title="Open externally"
          className={btn}
        >
          <ExternalLink size={14} strokeWidth={1.5} />
        </button>
      </div>
      {url ? (
        <WebView ref={webviewRef} src={url} className="min-h-0 w-full flex-1" />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-faint">
          Enter a URL to start browsing
        </div>
      )}
    </div>
  )
}
