import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { FileNode, Tab, Worktree } from '@shared/types'
import { useStore } from '@renderer/store'
import { __resetFileTreeRegistry, __setFileTreeBridge } from '@renderer/lib/fileTree'
import {
  __resetMarkdownAssetCache,
  __setMarkdownAssetBridge,
  __setMarkdownAssetCacheTtl
} from '@renderer/lib/markdownAssets'
import EditorTab, { CodeEditor, PREVIEW_TYPING_DEBOUNCE_MS, Preview } from './EditorTab'

/**
 * A readFileBase64 bridge whose reads stay in flight until the test settles
 * them. Image resolution is what makes the preview's `srcDoc` update async, so
 * holding it open is the only way to observe what the frame shows *during* that
 * window — which is exactly the behaviour under test.
 */
function makeDeferredBridge(): {
  bridge: { readFileBase64: (worktreeId: string, path: string) => Promise<string> }
  settle: () => Promise<void>
  /** Every read issued so far, in order — a render that never started reads nothing. */
  reads: string[]
} {
  const pending: (() => void)[] = []
  const reads: string[] = []
  return {
    reads,
    bridge: {
      readFileBase64: (_worktreeId: string, path: string): Promise<string> =>
        new Promise<string>((resolve) => {
          reads.push(path)
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

/** Let the preview's typing debounce elapse, inside act(). */
async function typingPause(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, PREVIEW_TYPING_DEBOUNCE_MS + 20))
  })
}

/** A Preview of one.md in w1 with the given markdown. */
function md(source: string, path = 'one.md'): JSX.Element {
  return <Preview kind="markdown" source={source} path={path} worktreeId="w1" onLink={noop} />
}

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

    await typingPause()
    await d.settle()
    expect(frameDoc(container)).toContain('typing')
  })

  it('coalesces a burst of keystrokes into one render after typing pauses', async () => {
    const d = makeDeferredBridge()
    __setMarkdownAssetBridge(d.bridge)

    const { container, rerender } = render(md('![a](a.png)'))
    await d.settle()
    expect(d.reads).toEqual(['a.png'])

    // Three keystrokes in quick succession. None of them starts a render —
    // the old behaviour re-parsed and re-inlined every image on each one.
    rerender(md('![a](a.png) burst-one'))
    rerender(md('![a](a.png) burst-two'))
    rerender(md('![a](a.png) burst-three'))
    expect(d.reads).toEqual(['a.png'])
    expect(frameDoc(container)).not.toContain('burst-')

    // Typing pauses: exactly one render, of the latest source.
    await typingPause()
    expect(d.reads).toEqual(['a.png', 'a.png'])
    await d.settle()
    expect(frameDoc(container)).toContain('burst-three')
    expect(frameDoc(container)).not.toContain('burst-two')
  })

  it('renders a file switch at once, without waiting out the debounce', async () => {
    const d = makeDeferredBridge()
    __setMarkdownAssetBridge(d.bridge)

    const { container, rerender } = render(md('![a](a.png)'))
    await d.settle()

    rerender(md('![b](b.png)', 'two.md'))
    // The read for the new file is already in flight and the stale frame is
    // blanked — neither waited 150 ms.
    expect(d.reads).toEqual(['a.png', 'b.png'])
    expect(frameDoc(container)).toBe('')
  })

  it('renders the first keystroke at once while nothing is on screen yet', async () => {
    // Before the first render lands there is no "last good render" to hold,
    // so typing during a cold load must not be held back behind the debounce.
    const d = makeDeferredBridge()
    __setMarkdownAssetBridge(d.bridge)

    const { rerender } = render(md('![a](a.png)'))
    rerender(md('![a](a.png) t'))
    expect(d.reads).toEqual(['a.png', 'a.png'])
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

/* ---- Worktree binding ----------------------------------------------------- */

/** Let every queued microtask + timer-0 continuation land, inside act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function worktree(id: string): Worktree {
  return {
    id,
    projectId: 'p1',
    kind: 'root',
    name: id,
    path: `/tmp/${id}`,
    branch: 'main',
    status: 'idle',
    taskId: null,
    layout: null,
    createdAt: 0,
    panes: []
  }
}

/** An editor tab belonging to `worktreeId`, auto-opening README.md. */
function editorTab(worktreeId: string): Tab {
  return {
    id: 'E1',
    worktreeId,
    paneId: 'pane1',
    type: 'editor',
    status: null,
    position: 0,
    config: { filePath: 'README.md' }
  }
}

describe('EditorTab worktree binding', () => {
  let treeReads: string[]
  let fileReads: string[]
  let assetReads: string[]

  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
    treeReads = []
    fileReads = []
    assetReads = []

    __resetFileTreeRegistry()
    __setFileTreeBridge({
      fileTree: async (id: string) => {
        treeReads.push(id)
        return [{ name: 'README.md', path: 'README.md', type: 'file' as const }]
      },
      onStateChanged: () => () => {}
    })

    __resetMarkdownAssetCache()
    __setMarkdownAssetCacheTtl(30_000)
    __setMarkdownAssetBridge({
      readFileBase64: async (worktreeId: string, path: string) => {
        assetReads.push(`${worktreeId}:${path}`)
        return b64(path)
      }
    })

    // Only the methods the editor tab reaches for — anything else it starts
    // calling should fail loudly rather than silently no-op.
    vi.stubGlobal('orbital', {
      readFile: async (id: string, path: string) => {
        fileReads.push(`${id}:${path}`)
        return '# hi\n\n![logo](logo.png)\n'
      },
      readFileBase64: async () => '',
      gitDiff: async () => null,
      listDir: async () => [],
      writeFile: async () => undefined,
      createTab: () => undefined,
      openExternal: () => undefined
    })

    // Two worktrees exist and w1 is the active one — the cockpit's starting state.
    useStore.setState({
      projects: [{ id: 'p1' }],
      worktrees: [worktree('w1'), worktree('w2')],
      activeProjectId: 'p1',
      activeWorktreeId: 'w1'
    } as unknown as Parameters<typeof useStore.setState>[0])
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __setFileTreeBridge(null)
    __resetFileTreeRegistry()
    __setMarkdownAssetBridge(null)
    __setMarkdownAssetCacheTtl(30_000)
    __resetMarkdownAssetCache()
  })

  it('keeps reading its own worktree after the cockpit switches to another one', async () => {
    const tab = editorTab('w1')
    const { rerender } = render(<EditorTab tab={tab} active />)
    await flush()

    // The tab opened its configured file and previewed it, so the file tree, the
    // file itself and the preview's inlined image have all been read — from w1.
    fireEvent.click(screen.getByText('Preview'))
    await flush()
    expect(treeReads).toEqual(['w1'])
    expect(fileReads).toEqual(['w1:README.md'])
    expect(assetReads).toEqual(['w1:logo.png'])

    // The user switches to another tab (this editor stays mounted, just hidden —
    // see PaneGroup) and then switches the cockpit to the other worktree.
    rerender(<EditorTab tab={tab} active={false} />)
    act(() => {
      useStore.setState({ activeWorktreeId: 'w2' } as unknown as Parameters<typeof useStore.setState>[0])
    })
    await flush()

    // Nothing about this tab changed, so nothing may be read against w2. Reading
    // the globally active worktree instead of the tab's own made every one of
    // these fire again against the wrong repo — burning IPC on files nobody
    // asked for, and seeding the shared markdown asset cache with w2's bytes
    // while `content`/`draft` still held w1's text.
    expect(treeReads).toEqual(['w1'])
    expect(fileReads).toEqual(['w1:README.md'])
    expect(assetReads).toEqual(['w1:logo.png'])
  })

  it('reads the tab own worktree even when it is not the active one', async () => {
    // A tab whose worktree is not the cockpit's selection at any point: every
    // read must still name w2, never the active w1.
    render(<EditorTab tab={editorTab('w2')} active />)
    await flush()
    fireEvent.click(screen.getByText('Preview'))
    await flush()

    expect(treeReads).toEqual(['w2'])
    expect(fileReads).toEqual(['w2:README.md'])
    expect(assetReads).toEqual(['w2:logo.png'])
  })
})

describe('CodeEditor', () => {
  const writeClipboard = vi.fn()
  const readClipboard = vi.fn((): string => '')
  const execCommand = vi.fn((): boolean => true)

  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
    vi.stubGlobal('orbital', { writeClipboard, readClipboard })
    writeClipboard.mockReset()
    readClipboard.mockReset()
    readClipboard.mockReturnValue('')
    execCommand.mockReset()
    // jsdom has no execCommand; the editor routes every mutating action
    // through it so the native undo stack stays intact.
    document.execCommand = execCommand as unknown as typeof document.execCommand
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  /** A path with no known grammar, so no shiki load is kicked off. */
  const PATH = 'notes.txt'

  function renderEditor(value: string): { ta: HTMLTextAreaElement; gutter: HTMLElement } {
    render(<CodeEditor path={PATH} value={value} onChange={noop} />)
    return {
      ta: screen.getByRole('textbox') as HTMLTextAreaElement,
      gutter: screen.getByTestId('line-gutter')
    }
  }

  it('numbers every line, including a trailing empty one', () => {
    const { gutter } = renderEditor('a\nb\nc\n')
    expect(gutter.textContent).toBe('1\n2\n3\n4')
  })

  it('widens the gutter with the digit count and shifts the text by the same amount', () => {
    const { gutter, ta } = renderEditor(Array.from({ length: 120 }, () => 'x').join('\n'))
    expect(gutter.style.width).toBe('calc(3ch + 20px)')
    expect(ta.style.paddingLeft).toBe('calc(3ch + 32px)')
  })

  it('opens the editing menu on right-click with Cut/Copy inert when nothing is selected', () => {
    const { ta } = renderEditor('hello world')
    ta.setSelectionRange(0, 0)
    fireEvent.contextMenu(ta, { clientX: 40, clientY: 40 })

    expect(screen.getByRole('menu')).toBeTruthy()
    expect((screen.getByRole('menuitem', { name: /cut/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: /copy/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: /paste/i }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('menuitem', { name: /select all/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('copies the selection to the clipboard and closes the menu', () => {
    const { ta } = renderEditor('hello world')
    ta.focus()
    ta.setSelectionRange(6, 11)
    fireEvent.contextMenu(ta, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: /copy/i }))

    expect(writeClipboard).toHaveBeenCalledWith('world')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('cuts by copying the selection and deleting it through execCommand', () => {
    const { ta } = renderEditor('hello world')
    ta.focus()
    ta.setSelectionRange(0, 5)
    fireEvent.contextMenu(ta, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: /cut/i }))

    expect(writeClipboard).toHaveBeenCalledWith('hello')
    expect(execCommand).toHaveBeenCalledWith('delete')
  })

  it('pastes the clipboard through insertText so the draft observes it', () => {
    readClipboard.mockReturnValue('pasted')
    const { ta } = renderEditor('hello')
    fireEvent.contextMenu(ta, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: /paste/i }))

    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'pasted')
  })

  it('selects the whole buffer', () => {
    const { ta } = renderEditor('hello world')
    fireEvent.contextMenu(ta, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: /select all/i }))

    expect(ta.selectionStart).toBe(0)
    expect(ta.selectionEnd).toBe('hello world'.length)
  })

  it('routes undo and redo to the native stack', () => {
    const { ta } = renderEditor('hello')
    fireEvent.contextMenu(ta, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: /undo/i }))
    expect(execCommand).toHaveBeenCalledWith('undo')

    fireEvent.contextMenu(ta, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: /redo/i }))
    expect(execCommand).toHaveBeenCalledWith('redo')
  })
})

/* ---- File mutations -------------------------------------------------------
 *
 * The tree's context menu reports what it did and EditorTab has to react: the
 * tree refetches, the open file follows a rename (its own, or an ancestor's),
 * a deleted file stops being shown, and a just-created file opens. Driven
 * through the real FileContextMenu so the wiring is covered too.
 * -------------------------------------------------------------------------- */

describe('EditorTab file mutations', () => {
  /** The tree the bridge hands back; tests reshape it to mirror a mutation. */
  let tree: FileNode[]
  let bridge: Record<string, ReturnType<typeof vi.fn>>

  const dirWith = (name: string, files: string[]): FileNode => ({
    name,
    path: name,
    type: 'dir',
    children: files.map((f) => ({ name: f, path: `${name}/${f}`, type: 'file' as const }))
  })

  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
    // `.txt` throughout: no known grammar, so no shiki load is kicked off.
    tree = [dirWith('src', ['notes.txt'])]
    __resetFileTreeRegistry()
    __setFileTreeBridge({
      fileTree: async () => tree,
      onStateChanged: () => () => {}
    })
    bridge = {
      readFile: vi.fn(async () => 'hello\n'),
      readFileBase64: vi.fn(async () => ''),
      gitDiff: vi.fn(async () => null),
      listDir: vi.fn(async () => []),
      writeFile: vi.fn(async () => undefined),
      createFile: vi.fn(async (_w: string, parent: string, name: string) => `${parent}/${name}`),
      createDirectory: vi.fn(async (_w: string, parent: string, name: string) => `${parent}/${name}`),
      renamePath: vi.fn(async () => ''),
      trashPath: vi.fn(async () => undefined)
    }
    vi.stubGlobal('orbital', bridge)
    useStore.setState({
      projects: [{ id: 'p1' }],
      worktrees: [worktree('w1')],
      activeProjectId: 'p1',
      activeWorktreeId: 'w1'
    } as unknown as Parameters<typeof useStore.setState>[0])
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __setFileTreeBridge(null)
    __resetFileTreeRegistry()
  })

  /** Mount with no configured file. */
  async function mount(): Promise<void> {
    render(<EditorTab tab={{ ...editorTab('w1'), config: {} }} active />)
    await flush()
  }

  /** Mount, expand `src`, and open src/notes.txt. */
  async function openNotes(): Promise<void> {
    await mount()
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(screen.getByText('notes.txt'))
    await flush()
    expect(screen.getByText('src/notes.txt')).toBeTruthy() // the header
  }

  /** Right-click a tree row and pick a menu item. */
  function menu(row: string, item: string): void {
    fireEvent.contextMenu(screen.getByText(row))
    fireEvent.click(screen.getByText(item))
  }

  /** Type into the open prompt and submit it. */
  function submitPrompt(label: string, value: string): void {
    const input = screen.getByRole('textbox', { name: label })
    fireEvent.change(input, { target: { value } })
    fireEvent.keyDown(input, { key: 'Enter' })
  }

  it('follows the open file to its new name', async () => {
    await openNotes()
    bridge.renamePath.mockResolvedValueOnce('src/renamed.txt')
    tree = [dirWith('src', ['renamed.txt'])]

    menu('notes.txt', 'Rename…')
    submitPrompt('Rename file', 'renamed.txt')
    await flush()

    expect(bridge.renamePath).toHaveBeenCalledWith('w1', 'src/notes.txt', 'renamed.txt')
    expect(screen.getByText('src/renamed.txt')).toBeTruthy()
    expect(screen.queryByText('src/notes.txt')).toBeNull()
  })

  it('follows the open file when an ancestor folder is renamed, and keeps that folder open', async () => {
    await openNotes()
    bridge.renamePath.mockResolvedValueOnce('lib')
    tree = [dirWith('lib', ['notes.txt'])]

    menu('src', 'Rename…')
    submitPrompt('Rename folder', 'lib')
    await flush()

    expect(screen.getByText('lib/notes.txt')).toBeTruthy()
    // The folder was expanded under its old key; the key moved with it. Before
    // this, a renamed folder snapped shut and its children vanished from view.
    expect(screen.getByText('notes.txt')).toBeTruthy()
  })

  it('closes the open file when it is deleted', async () => {
    await openNotes()
    tree = [dirWith('src', [])]

    menu('notes.txt', 'Delete')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await flush()

    expect(bridge.trashPath).toHaveBeenCalledWith('w1', 'src/notes.txt')
    expect(screen.getByText('Select a file')).toBeTruthy()
  })

  it('closes the open file when a folder containing it is deleted', async () => {
    await openNotes()
    tree = []

    menu('src', 'Delete')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await flush()

    expect(screen.getByText('Select a file')).toBeTruthy()
  })

  it('leaves an unrelated open file alone when something else is deleted', async () => {
    tree = [dirWith('src', ['notes.txt', 'other.txt'])]
    await openNotes()
    tree = [dirWith('src', ['notes.txt'])]

    menu('other.txt', 'Delete')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await flush()

    expect(screen.getByText('src/notes.txt')).toBeTruthy()
  })

  it('opens a file it just created and expands the folder it landed in', async () => {
    await mount()
    // `src` is collapsed: its child is not in the document yet.
    expect(screen.queryByText('notes.txt')).toBeNull()

    tree = [dirWith('src', ['fresh.txt', 'notes.txt'])]
    menu('src', 'New File…')
    submitPrompt('New file in src', 'fresh.txt')
    await flush()

    expect(bridge.createFile).toHaveBeenCalledWith('w1', 'src', 'fresh.txt')
    expect(screen.getByText('src/fresh.txt')).toBeTruthy() // opened
    expect(screen.getByText('notes.txt')).toBeTruthy() // folder expanded
    expect(bridge.readFile).toHaveBeenCalledWith('w1', 'src/fresh.txt')
  })

  it('expands the folder a new folder landed in, without opening anything', async () => {
    await mount()
    tree = [{ ...dirWith('src', ['notes.txt']), children: [dirWith('src/sub', []), ...dirWith('src', ['notes.txt']).children!] }]

    menu('src', 'New Folder…')
    submitPrompt('New folder in src', 'sub')
    await flush()

    expect(bridge.createDirectory).toHaveBeenCalledWith('w1', 'src', 'sub')
    expect(screen.getByText('Select a file')).toBeTruthy()
    expect(screen.getByText('notes.txt')).toBeTruthy()
    expect(bridge.readFile).not.toHaveBeenCalled()
  })

  it('warns in the delete confirm when the open file has unsaved edits', async () => {
    await openNotes()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello, edited\n' } })

    menu('notes.txt', 'Delete')
    expect(screen.getByText(/Your unsaved edits will be lost/)).toBeTruthy()
  })

  it('does not warn about edits when the buffer is clean', async () => {
    await openNotes()
    menu('notes.txt', 'Delete')
    expect(screen.queryByText(/unsaved edits/)).toBeNull()
  })
})
