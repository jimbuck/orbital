import { describe, expect, it } from 'vitest'
import type { FileDiff } from '@shared/types'
import {
  NOTHING_OPEN,
  activeFile,
  cancelClose,
  close,
  edit,
  fileAt,
  followGit,
  isDirty,
  isWithin,
  keep,
  loadFailed,
  loadNeeds,
  loadSettled,
  loadStarted,
  loaded,
  movedPath,
  remove,
  rename,
  request,
  requestClose,
  saveFailed,
  saved,
  select,
  setMode,
  show,
  showFolder,
  type OpenFiles
} from './openFiles'

/** The strip as text: `~` marks the preview, `*` the showing file. */
const strip = (s: OpenFiles): string[] =>
  s.files.map((f) => `${f.preview ? '~' : ''}${f.path}${f.path === s.activePath ? '*' : ''}`)

const preview = (s: OpenFiles, path: string): OpenFiles => show(s, { path }, { preview: true })
const open = (s: OpenFiles, ...paths: string[]): OpenFiles =>
  paths.reduce((acc, path) => show(acc, { path }, { preview: false }), s)

let nextLoad = 100
/** `s` with `path` loaded as `text`, the way the editor does it. */
function withContent(s: OpenFiles, path: string, text: string): OpenFiles {
  const id = nextLoad++
  return loadSettled(loaded(loadStarted(s, path, id), id, { content: text }), id)
}

const DIFF = { additions: 1, deletions: 0 } as unknown as FileDiff

describe('showing files: the preview rules', () => {
  it('opens a preview on the end when there is none', () => {
    expect(strip(preview(open(NOTHING_OPEN, 'a'), 'b'))).toEqual(['a', '~b*'])
  })

  it('replaces the existing preview in its own slot', () => {
    const s = open(preview(open(NOTHING_OPEN, 'a'), 'b'), 'c')
    expect(strip(preview(s, 'd'))).toEqual(['a', '~d*', 'c'])
  })

  it('never holds more than one preview', () => {
    const s = ['a', 'b', 'c'].reduce(preview, NOTHING_OPEN)
    expect(strip(s)).toEqual(['~c*'])
  })

  it('opens a permanent file on the end and keeps the preview', () => {
    expect(strip(open(preview(NOTHING_OPEN, 'a'), 'b'))).toEqual(['~a', 'b*'])
  })

  it('a preview ask for an already-open file just brings it to the front', () => {
    const s = preview(open(NOTHING_OPEN, 'a'), 'b')
    expect(strip(preview(s, 'a'))).toEqual(['a*', '~b'])
    // Already showing: nothing changes at all.
    expect(preview(s, 'b')).toBe(s)
  })

  it('a permanent ask for the preview promotes it in place', () => {
    const s = open(preview(NOTHING_OPEN, 'a'), 'b')
    expect(strip(open(s, 'a'))).toEqual(['a*', 'b'])
  })

  it('keeping the preview makes it permanent; keeping anything else is a no-op', () => {
    const s = preview(open(NOTHING_OPEN, 'a'), 'b')
    expect(strip(keep(s, 'b'))).toEqual(['a', 'b*'])
    expect(keep(s, 'a')).toBe(s)
    expect(keep(s, 'zzz')).toBe(s)
  })

  it('a kept file is no longer replaced by the next preview', () => {
    expect(strip(preview(keep(preview(NOTHING_OPEN, 'a'), 'a'), 'b'))).toEqual(['a', '~b*'])
  })

  it('opens a changed file on its diff, an image or an unchanged file on the file', () => {
    const changed = show(NOTHING_OPEN, { path: 'a.ts', gitState: 'modified' }, { preview: false })
    expect(activeFile(changed)?.mode).toBe('diff')
    expect(activeFile(open(NOTHING_OPEN, 'a.ts'))?.mode).toBe('file')
    expect(activeFile(show(NOTHING_OPEN, { path: 'a.ts' }, { preview: false, staged: true }))?.mode).toBe('diff')
    // An image's "diff" is only a binary notice.
    expect(activeFile(show(NOTHING_OPEN, { path: 'a.png', gitState: 'modified' }, { preview: false }))?.mode).toBe('file')
  })
})

describe('selecting and the folder view', () => {
  it('selects an open pill', () => {
    const s = open(NOTHING_OPEN, 'a', 'b')
    expect(strip(select(s, 'a'))).toEqual(['a*', 'b'])
    expect(select(s, 'b')).toBe(s)
  })

  it('shows a folder over the files, and any file shown or selected leaves it', () => {
    const s = showFolder(open(NOTHING_OPEN, 'a', 'b'), 'src')
    expect(s.folder).toBe('src')
    expect(strip(s)).toEqual(['a', 'b*'])
    expect(showFolder(s, 'src')).toBe(s)
    expect(select(s, 'b').folder).toBeNull()
    expect(open(s, 'c').folder).toBeNull()
    expect(preview(s, 'a').folder).toBeNull()
  })
})

describe('requests from outside the editor', () => {
  const ask = (path: string, extra: object = {}, seq = 1): Parameters<typeof request>[1] => ({
    path,
    staged: false,
    seq,
    ...extra
  })

  it('opens a file the git panel asks for straight onto its diff, to stay', () => {
    const s = request(preview(NOTHING_OPEN, 'p'), ask('a.ts', { gitState: 'modified' }), { path: 'a.ts' })
    expect(strip(s)).toEqual(['~p', 'a.ts*'])
    expect(activeFile(s)).toMatchObject({ mode: 'diff', gitState: 'modified', staged: false, preview: false })
  })

  it('takes git state from the tree when it knows, from the request when it does not', () => {
    const fromTree = request(NOTHING_OPEN, ask('a.ts', { gitState: 'modified' }), { path: 'a.ts', gitState: 'added' })
    expect(activeFile(fromTree)?.gitState).toBe('added')
  })

  it('opens the staged side when asked', () => {
    const s = request(NOTHING_OPEN, ask('a.ts', { staged: true }), { path: 'a.ts' })
    expect(activeFile(s)).toMatchObject({ mode: 'diff', staged: true })
  })

  it('brings an already-open file back and refetches its diff, keeping its draft', () => {
    let s = show(NOTHING_OPEN, { path: 'a.ts', gitState: 'modified' }, { preview: true })
    s = setMode(s, 'a.ts', 'file')
    s = edit(withContent(s, 'a.ts', 'one'), 'a.ts', 'one two')
    const id = nextLoad++
    s = setMode(loadSettled(loaded(loadStarted(setMode(s, 'a.ts', 'diff'), 'a.ts', id), id, { diff: DIFF }), id), 'a.ts', 'file')
    s = open(s, 'b.ts')

    const back = request(s, ask('a.ts', { gitState: 'modified' }), { path: 'a.ts', gitState: 'modified' })
    expect(strip(back)).toEqual(['a.ts*', 'b.ts'])
    expect(activeFile(back)).toMatchObject({ mode: 'diff', diff: null, draft: 'one two', content: 'one' })
  })

  it('leaves an open file in whatever mode it was when only the file is asked for', () => {
    let s = show(NOTHING_OPEN, { path: 'a.md' }, { preview: true })
    s = setMode(s, 'a.md', 'preview')
    const back = request(open(s, 'b'), ask('a.md'), { path: 'a.md' })
    expect(activeFile(back)).toMatchObject({ mode: 'preview', preview: false })
  })

  it('takes an open file to the file view when a line is asked for, and remembers the line', () => {
    let s = show(NOTHING_OPEN, { path: 'a.ts', gitState: 'modified' }, { preview: false })
    expect(activeFile(s)?.mode).toBe('diff')
    s = request(s, ask('a.ts', { line: 40 }, 7), { path: 'a.ts', gitState: 'modified' })
    expect(activeFile(s)?.mode).toBe('file')
    expect(s.reveal).toEqual({ path: 'a.ts', line: 40, seq: 7 })
    // A later request without a line clears it.
    expect(request(s, ask('a.ts', {}, 8), { path: 'a.ts' }).reveal).toBeNull()
  })

  it('opens a file it did not have on the file view when a line is asked for, changed or not', () => {
    const s = request(NOTHING_OPEN, ask('a.ts', { line: 12 }, 3), { path: 'a.ts', gitState: 'modified' })
    // Git still knows it changed (the Diff toggle is offered); the line wins the mode.
    expect(activeFile(s)).toMatchObject({ mode: 'file', gitState: 'modified', preview: false })
    expect(s.reveal).toEqual({ path: 'a.ts', line: 12, seq: 3 })
  })

  it('leaves the folder view and drops a pending close prompt', () => {
    let s = edit(withContent(open(NOTHING_OPEN, 'a'), 'a', 'x'), 'a', 'xy')
    s = showFolder(requestClose(s, 'a'), 'src')
    expect(s.closing).toBe('a')
    const next = request(s, ask('b'), { path: 'b' })
    expect(next).toMatchObject({ folder: null, closing: null, activePath: 'b' })
  })
})

describe('closing', () => {
  it('closes a clean file at once and moves to the pill after it, then the one before', () => {
    let s = select(open(NOTHING_OPEN, 'a', 'b', 'c'), 'b')
    s = requestClose(s, 'b')
    expect(strip(s)).toEqual(['a', 'c*'])
    s = requestClose(s, 'c')
    expect(strip(s)).toEqual(['a*'])
    s = requestClose(s, 'a')
    expect(strip(s)).toEqual([])
    expect(s.activePath).toBeNull()
  })

  it('leaves the showing file alone when another pill closes', () => {
    const s = open(NOTHING_OPEN, 'a', 'b', 'c')
    expect(strip(requestClose(s, 'a'))).toEqual(['b', 'c*'])
  })

  it('asks before closing a file with unsaved edits, and cancelling keeps it', () => {
    const s = edit(withContent(open(NOTHING_OPEN, 'a', 'b'), 'a', 'x'), 'a', 'xy')
    const asking = requestClose(s, 'a')
    expect(asking.closing).toBe('a')
    expect(strip(asking)).toEqual(['a', 'b*'])
    expect(requestClose(asking, 'a')).toBe(asking)
    expect(cancelClose(asking)).toMatchObject({ closing: null })
    expect(strip(cancelClose(asking))).toEqual(['a', 'b*'])
    expect(cancelClose(s)).toBe(s)
  })

  it('closing the file the prompt is about dismisses the prompt', () => {
    const s = requestClose(edit(withContent(open(NOTHING_OPEN, 'a'), 'a', 'x'), 'a', 'xy'), 'a')
    const closed = close(s, (p) => p === 'a')
    expect(closed).toMatchObject({ closing: null, activePath: null })
    expect(closed.files).toEqual([])
  })

  it('skips over other closing files when choosing what shows next', () => {
    const s = select(open(NOTHING_OPEN, 'a', 'x/b', 'x/c', 'd'), 'x/b')
    expect(strip(close(s, (p) => p.startsWith('x/')))).toEqual(['a', 'd*'])
    const atEnd = select(open(NOTHING_OPEN, 'a', 'x/b', 'x/c'), 'x/c')
    expect(strip(close(atEnd, (p) => p.startsWith('x/')))).toEqual(['a*'])
  })

  it('does nothing for a file that is not open', () => {
    const s = open(NOTHING_OPEN, 'a')
    expect(requestClose(s, 'zzz')).toBe(s)
    expect(close(s, (p) => p === 'zzz')).toBe(s)
  })
})

describe('files renamed or deleted underneath', () => {
  it('follows a renamed file, along with everything that named it', () => {
    let s = edit(withContent(open(NOTHING_OPEN, 'src/a.ts', 'b'), 'src/a.ts', 'x'), 'src/a.ts', 'xy')
    s = requestClose(s, 'src/a.ts')
    s = { ...request(s, { path: 'src/a.ts', staged: false, line: 3, seq: 9 }, { path: 'src/a.ts' }), closing: 'src/a.ts' }

    const next = rename(s, 'src/a.ts', 'src/z.ts')
    expect(strip(next)).toEqual(['src/z.ts*', 'b'])
    expect(next.closing).toBe('src/z.ts')
    expect(next.reveal).toEqual({ path: 'src/z.ts', line: 3, seq: 9 })
    // The buffer itself is untouched: same draft, same contents.
    expect(fileAt(next, 'src/z.ts')).toMatchObject({ draft: 'xy', content: 'x' })
  })

  it('follows a file when a directory above it is renamed, and the folder view with it', () => {
    const s = showFolder(open(NOTHING_OPEN, 'src/deep/a.ts', 'other/b.ts'), 'src/deep')
    const next = rename(s, 'src', 'lib')
    expect(next.files.map((f) => f.path)).toEqual(['lib/deep/a.ts', 'other/b.ts'])
    expect(next.folder).toBe('lib/deep')
  })

  it('is not fooled by a name that merely starts the same', () => {
    const s = open(NOTHING_OPEN, 'src2/a.ts', 'srcfile')
    expect(rename(s, 'src', 'lib')).toBe(s)
    expect(movedPath('src/a', 'src', 'lib')).toBe('lib/a')
    expect(movedPath('src', 'src', 'lib')).toBe('lib')
    expect(movedPath('src2/a', 'src', 'lib')).toBeNull()
    expect(isWithin('src2/a', 'src')).toBe(false)
    expect(isWithin('src/a', 'src')).toBe(true)
    expect(isWithin('src', 'src')).toBe(true)
  })

  it('closes a deleted file and whatever was open inside a deleted folder', () => {
    const s = select(open(NOTHING_OPEN, 'a', 'src/b', 'src/deep/c', 'd'), 'src/b')
    expect(strip(remove(s, 'src'))).toEqual(['a', 'd*'])
    expect(strip(remove(s, 'a'))).toEqual(['src/b*', 'src/deep/c', 'd'])
    expect(remove(s, 'unrelated')).toBe(s)
  })

  it('leaves a folder view of something that was deleted', () => {
    const s = showFolder(open(NOTHING_OPEN, 'a'), 'src/deep')
    expect(remove(s, 'src').folder).toBeNull()
    expect(remove(s, 'src/deep').folder).toBeNull()
    expect(remove(s, 'other').folder).toBe('src/deep')
  })

  it('follows what git says after a tree refresh, dropping a stale diff', () => {
    let s = show(NOTHING_OPEN, { path: 'a.ts', gitState: 'modified' }, { preview: false })
    const id = nextLoad++
    s = loadSettled(loaded(loadStarted(s, 'a.ts', id), id, { diff: DIFF }), id)
    expect(followGit(s, () => 'modified')).toBe(s)

    // Committed: no longer changed, so there is no diff to be looking at.
    const clean = followGit(s, () => undefined)
    expect(activeFile(clean)).toMatchObject({ gitState: undefined, diff: null, mode: 'file' })
    // Staged view stays on the diff: the index side can differ even when the tree is clean.
    const staged = followGit(show(NOTHING_OPEN, { path: 'a.ts' }, { preview: false, staged: true }), () => undefined)
    expect(activeFile(staged)?.mode).toBe('diff')
  })
})

describe('editing', () => {
  it('keeps each file own draft, and marks the edited one', () => {
    let s = withContent(withContent(open(NOTHING_OPEN, 'a', 'b'), 'a', 'A'), 'b', 'B')
    s = edit(s, 'a', 'A!')
    expect(fileAt(s, 'a')).toMatchObject({ draft: 'A!', content: 'A' })
    expect(fileAt(s, 'b')).toMatchObject({ draft: 'B', content: 'B' })
    expect(s.files.filter(isDirty).map((f) => f.path)).toEqual(['a'])
  })

  it('makes an edited preview permanent', () => {
    const s = edit(withContent(preview(NOTHING_OPEN, 'a'), 'a', 'x'), 'a', 'xy')
    expect(strip(s)).toEqual(['a*'])
  })

  it('switches mode without touching the draft', () => {
    const s = edit(withContent(open(NOTHING_OPEN, 'a.md'), 'a.md', 'x'), 'a.md', 'xy')
    const p = setMode(s, 'a.md', 'preview')
    expect(fileAt(p, 'a.md')).toMatchObject({ mode: 'preview', draft: 'xy' })
    expect(setMode(p, 'a.md', 'preview')).toBe(p)
  })

  it('is not dirty before its contents have loaded', () => {
    expect(isDirty(activeFile(open(NOTHING_OPEN, 'a'))!)).toBe(false)
  })
})

describe('loading', () => {
  it('knows what a buffer still has to fetch for the mode it is in', () => {
    const file = activeFile(open(NOTHING_OPEN, 'a.ts'))!
    expect(loadNeeds(file)).toEqual({ diff: false, image: false, content: true })
    expect(loadNeeds({ ...file, mode: 'diff' })).toEqual({ diff: true, image: false, content: false })
    expect(loadNeeds({ ...file, content: 'x' })).toEqual({ diff: false, image: false, content: false })
    const image = activeFile(open(NOTHING_OPEN, 'a.png'))!
    expect(loadNeeds(image)).toEqual({ diff: false, image: true, content: false })
    expect(loadNeeds({ ...image, imageData: 'data:' })).toEqual({ diff: false, image: false, content: false })
  })

  it('goes from loading to loaded, with the contents as the draft', () => {
    let s = loadStarted(open(NOTHING_OPEN, 'a'), 'a', 1)
    expect(activeFile(s)).toMatchObject({ loading: true, loadError: null })
    s = loaded(s, 1, { content: 'hello' })
    expect(activeFile(s)).toMatchObject({ loading: true, content: 'hello', draft: 'hello' })
    s = loadSettled(s, 1)
    expect(activeFile(s)).toMatchObject({ loading: false })
  })

  it('records why a load failed and stops loading', () => {
    const s = loadSettled(loadFailed(loadStarted(open(NOTHING_OPEN, 'a'), 'a', 1), 1, 'too big'), 1)
    expect(activeFile(s)).toMatchObject({ loading: false, loadError: 'too big', content: null })
    // Trying again clears the old reason.
    expect(activeFile(loadStarted(s, 'a', 2))).toMatchObject({ loading: true, loadError: null })
  })

  it('drops a response for a buffer that was closed and reopened in the meantime', () => {
    let s = loadStarted(open(NOTHING_OPEN, 'a'), 'a', 1)
    s = open(close(s, (p) => p === 'a'), 'a')
    const late = loadSettled(loaded(s, 1, { content: 'stale' }), 1)
    expect(late).toBe(s)
    expect(activeFile(late)).toMatchObject({ content: null, loading: false })
  })

  it('drops a response that a newer fetch for the same buffer has overtaken', () => {
    let s = loadStarted(open(NOTHING_OPEN, 'a'), 'a', 1)
    s = loadStarted(s, 'a', 2)
    // The first one comes back last, and its "finished" must not clear the spinner either.
    s = loadSettled(loaded(s, 1, { content: 'old' }), 1)
    expect(activeFile(s)).toMatchObject({ content: null, loading: true })
    s = loadSettled(loaded(s, 2, { content: 'new' }), 2)
    expect(activeFile(s)).toMatchObject({ content: 'new', loading: false })
  })

  it('still delivers to a buffer that was renamed while its contents were on the way', () => {
    let s = loadStarted(open(NOTHING_OPEN, 'src/a'), 'src/a', 1)
    s = rename(s, 'src/a', 'src/z')
    s = loadSettled(loaded(s, 1, { content: 'hello' }), 1)
    expect(fileAt(s, 'src/z')).toMatchObject({ content: 'hello', loading: false })
  })

  it('loads a diff or an image without disturbing the draft', () => {
    let s = edit(withContent(open(NOTHING_OPEN, 'a'), 'a', 'x'), 'a', 'xy')
    s = loadSettled(loaded(loadStarted(s, 'a', 5), 5, { diff: DIFF }), 5)
    expect(activeFile(s)).toMatchObject({ diff: DIFF, draft: 'xy', content: 'x' })
  })
})

describe('saving', () => {
  it('takes what was written as the new contents and drops the cached diff', () => {
    let s = edit(withContent(open(NOTHING_OPEN, 'a'), 'a', 'x'), 'a', 'xy')
    s = loadSettled(loaded(loadStarted(s, 'a', 6), 6, { diff: DIFF }), 6)
    s = saved(s, 'a', 'xy', 'xy')
    expect(activeFile(s)).toMatchObject({ content: 'xy', draft: 'xy', diff: null, saveError: null })
    expect(isDirty(activeFile(s)!)).toBe(false)
  })

  it('keeps keystrokes that landed while the write was in flight', () => {
    let s = edit(withContent(open(NOTHING_OPEN, 'a'), 'a', 'x'), 'a', 'xy')
    s = edit(s, 'a', 'xyz') // typed after the save started with "xy"
    s = saved(s, 'a', 'xy', 'xy')
    expect(activeFile(s)).toMatchObject({ content: 'xy', draft: 'xyz' })
    expect(isDirty(activeFile(s)!)).toBe(true)
  })

  it('adopts what the disk gave back when that differs from what was written', () => {
    const s = saved(edit(withContent(open(NOTHING_OPEN, 'a'), 'a', 'x'), 'a', 'xy'), 'a', 'xy', 'xy\n')
    expect(activeFile(s)).toMatchObject({ content: 'xy\n', draft: 'xy\n' })
  })

  it('keeps the draft and says why when the write fails, and clears that on the next good save', () => {
    let s = edit(withContent(open(NOTHING_OPEN, 'a'), 'a', 'x'), 'a', 'xy')
    s = saveFailed(s, 'a', 'disk full')
    expect(activeFile(s)).toMatchObject({ saveError: 'disk full', draft: 'xy', content: 'x' })
    expect(activeFile(saved(s, 'a', 'xy', 'xy'))?.saveError).toBeNull()
  })
})
