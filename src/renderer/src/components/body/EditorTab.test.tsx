import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  __resetMarkdownAssetCache,
  __setMarkdownAssetBridge,
  __setMarkdownAssetCacheTtl
} from '@renderer/lib/markdownAssets'
import { Preview } from './EditorTab'

/**
 * A readFileBase64 bridge whose reads stay in flight until the test settles
 * them. Image resolution is what makes the preview's `srcDoc` update async, so
 * holding it open is the only way to observe what the frame shows *during* that
 * window — which is exactly the behaviour under test.
 */
function makeDeferredBridge(): {
  bridge: { readFileBase64: (worktreeId: string, path: string) => Promise<string> }
  settle: () => Promise<void>
} {
  const pending: (() => void)[] = []
  return {
    bridge: {
      readFileBase64: (_worktreeId: string, path: string): Promise<string> =>
        new Promise<string>((resolve) => {
          pending.push(() => resolve(Buffer.from(path).toString('base64')))
        })
    },
    settle: async (): Promise<void> => {
      const jobs = pending.splice(0)
      await act(async () => {
        for (const job of jobs) job()
        // A macrotask turn: enough for Promise.all + the .then that calls setDoc.
        await new Promise((r) => setTimeout(r, 0))
      })
    }
  }
}

/**
 * The same idea, but settleable *per path*. `makeDeferredBridge` releases every
 * pending read at once, which can only ever produce in-order resolutions — so it
 * cannot express the race the request-id guard exists for: a slow read for the
 * previously selected file landing *after* a newer file has already rendered.
 */
function makePerPathBridge(): {
  bridge: { readFileBase64: (worktreeId: string, path: string) => Promise<string> }
  settle: (path: string) => Promise<void>
} {
  const pending = new Map<string, (() => void)[]>()
  return {
    bridge: {
      readFileBase64: (_worktreeId: string, path: string): Promise<string> =>
        new Promise<string>((resolve) => {
          const waiting = pending.get(path) ?? []
          waiting.push(() => resolve(Buffer.from(path).toString('base64')))
          pending.set(path, waiting)
        })
    },
    settle: async (path: string): Promise<void> => {
      const jobs = pending.get(path) ?? []
      pending.delete(path)
      await act(async () => {
        for (const job of jobs) job()
        await new Promise((r) => setTimeout(r, 0))
      })
    }
  }
}

const b64 = (s: string): string => Buffer.from(s).toString('base64')

/** Whatever document the preview iframe is currently holding. */
function frameDoc(container: HTMLElement): string {
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
}

const noop = (): void => {}

describe('Preview markdown staleness', () => {
  beforeEach(() => {
    // jsdom has no matchMedia; useResolvedTheme seeds from it on every mount.
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
    __resetMarkdownAssetCache()
    // Every render re-reads, so each one has an observable in-flight window.
    __setMarkdownAssetCacheTtl(0)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __setMarkdownAssetBridge(null)
    __setMarkdownAssetCacheTtl(30_000)
    __resetMarkdownAssetCache()
  })

  it('blanks the frame while a different file resolves', async () => {
    const d = makeDeferredBridge()
    __setMarkdownAssetBridge(d.bridge)

    const { container, rerender } = render(
      <Preview kind="markdown" source="![a](a.png)" path="one.md" worktreeId="w1" onLink={noop} />
    )
    await d.settle()
    expect(frameDoc(container)).toContain(`data:image/png;base64,${b64('a.png')}`)

    // Switching files: the old document belongs to one.md and must not sit under
    // two.md's header while two.md's images are still being read.
    rerender(
      <Preview kind="markdown" source="![b](b.png)" path="two.md" worktreeId="w1" onLink={noop} />
    )
    expect(frameDoc(container)).toBe('')

    await d.settle()
    expect(frameDoc(container)).toContain(`data:image/png;base64,${b64('b.png')}`)
  })

  it('blanks the frame when the worktree changes under the same path', async () => {
    const d = makeDeferredBridge()
    __setMarkdownAssetBridge(d.bridge)

    const { container, rerender } = render(
      <Preview kind="markdown" source="![a](a.png)" path="one.md" worktreeId="w1" onLink={noop} />
    )
    await d.settle()
    expect(frameDoc(container)).not.toBe('')

    rerender(
      <Preview kind="markdown" source="![a](a.png)" path="one.md" worktreeId="w2" onLink={noop} />
    )
    expect(frameDoc(container)).toBe('')
  })

  it('holds the last good render while the same file re-resolves', async () => {
    const d = makeDeferredBridge()
    __setMarkdownAssetBridge(d.bridge)

    const { container, rerender } = render(
      <Preview kind="markdown" source="![a](a.png)" path="one.md" worktreeId="w1" onLink={noop} />
    )
    await d.settle()
    const first = frameDoc(container)
    expect(first).toContain(`data:image/png;base64,${b64('a.png')}`)

    // A keystroke in the editor. The file is the same, so the previous render is
    // still an honest picture of it — blanking here would strobe on every key.
    rerender(
      <Preview
        kind="markdown"
        source="![a](a.png) typing"
        path="one.md"
        worktreeId="w1"
        onLink={noop}
      />
    )
    expect(frameDoc(container)).toBe(first)

    await d.settle()
    expect(frameDoc(container)).toContain('typing')
  })

  it('drops a resolve that lands after a newer file was selected', async () => {
    const d = makePerPathBridge()
    __setMarkdownAssetBridge(d.bridge)

    const { container, rerender } = render(
      <Preview kind="markdown" source="![a](a.png)" path="one.md" worktreeId="w1" onLink={noop} />
    )

    // one.md's image is still being read when the user clicks two.md.
    rerender(
      <Preview kind="markdown" source="![b](b.png)" path="two.md" worktreeId="w1" onLink={noop} />
    )
    await d.settle('b.png')
    expect(frameDoc(container)).toContain(`data:image/png;base64,${b64('b.png')}`)

    // one.md's read finally comes back — for a render that is a whole file out
    // of date. Without the request-id guard its `setDoc` wins purely by
    // arriving last, replacing two.md's preview with one.md's content under
    // two.md's header.
    await d.settle('a.png')
    expect(frameDoc(container)).toContain(`data:image/png;base64,${b64('b.png')}`)
    expect(frameDoc(container)).not.toContain(b64('a.png'))
  })

  it('renders non-markdown sources synchronously', () => {
    const d = makeDeferredBridge()
    __setMarkdownAssetBridge(d.bridge)

    const { container } = render(
      <Preview kind="html" source="<p>hi</p>" path="a.html" worktreeId="w1" onLink={noop} />
    )
    expect(frameDoc(container)).toBe('<p>hi</p>')
  })
})
