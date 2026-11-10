/**
 * The editor's open files: which buffers are in the strip, which one is showing,
 * and every way that set changes.
 *
 * One value, `OpenFiles`, holds all of it, and each thing that can happen to it
 * — a click in the tree, a request from the git panel, a pill closing, a file
 * renamed or deleted under an open buffer, a load or a save finishing — is a
 * function from that value to the next. Several facts here are keyed by path
 * and have to move together (rename a file and the buffer, the selection, a
 * pending close and a pending reveal all follow it); keeping them in one value
 * with one function per event is what makes that hold. The editor component
 * owns the I/O and renders the result.
 *
 * The strip follows VS Code's preview model: a single click shows a file as THE
 * preview (one at a time, drawn in italics), and the next single click on
 * another file replaces it rather than piling up pills. Committing to a file —
 * double-clicking it, editing it, saving it, asking for it by name — makes it
 * an ordinary open file that stays until it is closed.
 *
 * Every transition returns the SAME value when nothing changed, so a React
 * state setter that uses one bails out of the re-render.
 */
import type { FileDiff, GitFileState } from '@shared/types'
import { imageMime } from './markdownAssets'

export type ViewMode = 'file' | 'diff' | 'preview'

/**
 * One open buffer: the file's identity plus everything fetched or typed for
 * it. A buffer lives as long as its pill is in the strip, so switching between
 * files is instant and an unsaved draft survives a trip to another file.
 * Everything is per file, view mode included: peeking at one file's Diff must
 * not flip another's editor.
 */
export interface OpenFile {
  path: string
  /** The one replaceable, italic preview pill. */
  preview: boolean
  gitState?: GitFileState
  /** Viewing the staged (index) side of the diff. */
  staged: boolean
  mode: ViewMode
  diff: FileDiff | null
  content: string | null
  imageData: string | null
  draft: string
  loading: boolean
  /** The fetch whose results this buffer is waiting for (see `loadStarted`). */
  loadId: number | null
  /** Why the last content/diff/image fetch failed (main's message, e.g. the size cap), if it did. */
  loadError: string | null
  /** Why the last save failed, if it did. The draft is kept; the message sits by the path. */
  saveError: string | null
}

/** What a file is opened from: its path, and what git says about it if known. */
export interface FileRef {
  path: string
  gitState?: GitFileState
}

export interface OpenFiles {
  /** Open buffers, in pill order. */
  readonly files: readonly OpenFile[]
  /** The buffer that is showing (or would be, behind a folder view). */
  readonly activePath: string | null
  /**
   * The folder whose tiles fill the content area, or null when it shows the
   * active file. Opening or selecting any file clears it.
   */
  readonly folder: string | null
  /** The file with unsaved edits whose close is waiting on the save / discard prompt. */
  readonly closing: string | null
  /**
   * A line someone asked to be taken to. Held here, not acted on at once: the
   * file may still be loading, and scrolling to line 400 of an empty buffer
   * just pins it at the top.
   */
  readonly reveal: { path: string; line: number; seq: number } | null
}

export const NOTHING_OPEN: OpenFiles = { files: [], activePath: null, folder: null, closing: null, reveal: null }

/* ---- Reading it ---------------------------------------------------------- */

/** Edits not yet written to disk. */
export const isDirty = (f: OpenFile): boolean => f.content !== null && f.draft !== f.content

export const fileAt = (s: OpenFiles, path: string | null): OpenFile | null =>
  path === null ? null : (s.files.find((f) => f.path === path) ?? null)

export const activeFile = (s: OpenFiles): OpenFile | null => fileAt(s, s.activePath)

/** What a buffer still has to fetch before its current mode can be shown. */
export function loadNeeds(f: OpenFile): { diff: boolean; image: boolean; content: boolean } {
  const image = !!imageMime(f.path)
  return {
    diff: f.mode === 'diff' && f.diff === null,
    image: f.mode !== 'diff' && image && f.imageData === null,
    content: f.mode !== 'diff' && !image && f.content === null
  }
}

/** Where `path` ends up when `from` is renamed to `to`: itself or anything under it moves; null otherwise. */
export function movedPath(path: string, from: string, to: string): string | null {
  return path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null
}

/** Whether `path` is `dir` or lies under it. */
export const isWithin = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

/* ---- Showing files -------------------------------------------------------- */

function freshFile(ref: FileRef, staged: boolean, preview: boolean): OpenFile {
  return {
    path: ref.path,
    preview,
    gitState: ref.gitState,
    staged,
    // Images open on the rendered image — their "diff" is just a binary notice.
    mode: !imageMime(ref.path) && (staged || ref.gitState) ? 'diff' : 'file',
    diff: null,
    content: null,
    imageData: null,
    draft: '',
    loading: false,
    loadId: null,
    loadError: null,
    saveError: null
  }
}

/** Change one buffer, leaving the value alone when there is no such buffer or `fn` changes nothing. */
function patch(s: OpenFiles, match: (f: OpenFile) => boolean, fn: (f: OpenFile) => OpenFile): OpenFiles {
  let changed = false
  const files = s.files.map((f) => {
    if (!match(f)) return f
    const next = fn(f)
    if (next !== f) changed = true
    return next
  })
  return changed ? { ...s, files } : s
}

const at = (path: string) => (f: OpenFile): boolean => f.path === path

/** Bring a file to the front, leaving the folder view. */
function fronted(s: OpenFiles, files: readonly OpenFile[], path: string): OpenFiles {
  return files === s.files && s.activePath === path && s.folder === null ? s : { ...s, files, activePath: path, folder: null }
}

/**
 * Show a file: as the single replaceable preview (a click), or as a file that
 * stays open (a double-click, a file just created, the tab's own file).
 *
 * - Already open: comes to the front; a permanent ask promotes it if it was
 *   the preview, a preview ask leaves it as it is.
 * - Not open, as the preview: takes the old preview's slot, replacing it, or
 *   goes on the end when there is no preview yet.
 * - Not open, permanent: goes on the end, and any preview stays where it is.
 */
export function show(s: OpenFiles, ref: FileRef, opts: { preview: boolean; staged?: boolean }): OpenFiles {
  if (s.files.some(at(ref.path))) {
    const kept = opts.preview ? s : keep(s, ref.path)
    return fronted(kept, kept.files, ref.path)
  }
  const fresh = freshFile(ref, opts.staged ?? false, opts.preview)
  const slot = opts.preview ? s.files.findIndex((f) => f.preview) : -1
  const files = slot === -1 ? [...s.files, fresh] : s.files.map((f, i) => (i === slot ? fresh : f))
  return fronted(s, files, ref.path)
}

/** Make `path` a permanent open file. A no-op unless it is the preview. */
export function keep(s: OpenFiles, path: string): OpenFiles {
  return patch(s, at(path), (f) => (f.preview ? { ...f, preview: false } : f))
}

/** Bring an open file to the front (a click on its pill). */
export function select(s: OpenFiles, path: string): OpenFiles {
  return fronted(s, s.files, path)
}

/** Fill the content area with a folder's tiles; the open files stay as they are. */
export function showFolder(s: OpenFiles, folder: string): OpenFiles {
  return s.folder === folder ? s : { ...s, folder }
}

/**
 * Something outside the editor asked for a file by name: the git panel's change
 * list, the command palette's file search, a content-search hit.
 *
 * What the request carries says which. The git panel names a side (`staged`)
 * and the file's git state, because it is asking for a DIFF — and that travels
 * with the request so the file opens straight onto its diff even if the tree
 * (`ref`) has not caught up with the change yet. The palette sends neither,
 * because it is asking for the file; for one already open, forcing diff mode
 * would answer "go to file" on an unchanged file with an empty diff. A search
 * hit sends a line, which is a working-tree line: a diff renumbers everything
 * around its hunks, so a request with a line always means the file view.
 *
 * A file asked for by name stays: it is never a replaceable preview.
 */
export function request(
  s: OpenFiles,
  ask: { path: string; staged: boolean; gitState?: GitFileState; line?: number; seq: number },
  ref: FileRef
): OpenFiles {
  const { path, staged, gitState, line } = ask
  const wantsDiff = line === undefined && (staged || gitState !== undefined)
  const files = s.files.some(at(path))
    ? s.files.map((f) =>
        f.path === path
          ? {
              ...f,
              preview: false,
              staged,
              gitState: f.gitState ?? gitState,
              // Drop the cached diff only when one was asked for: the panel's
              // row is fresher than anything cached here.
              diff: wantsDiff ? null : f.diff,
              mode: wantsDiff && !imageMime(path) ? ('diff' as const) : line !== undefined ? ('file' as const) : f.mode
            }
          : f
      )
    : [...s.files, freshFile({ path, gitState: ref.gitState ?? gitState }, staged, false)]
  return {
    files,
    activePath: path,
    folder: null,
    closing: null,
    reveal: line === undefined ? null : { path, line, seq: ask.seq }
  }
}

/* ---- Closing -------------------------------------------------------------- */

/**
 * Close every open file matching `gone`. If the active one goes, the pill
 * after it takes over (or the one before, at the end of the strip).
 */
export function close(s: OpenFiles, gone: (path: string) => boolean): OpenFiles {
  if (!s.files.some((f) => gone(f.path))) return s
  let activePath = s.activePath
  if (activePath !== null && gone(activePath)) {
    const i = s.files.findIndex(at(activePath))
    const after = s.files.slice(i + 1).find((f) => !gone(f.path))
    const before = s.files
      .slice(0, Math.max(i, 0))
      .reverse()
      .find((f) => !gone(f.path))
    activePath = (after ?? before)?.path ?? null
  }
  return {
    ...s,
    files: s.files.filter((f) => !gone(f.path)),
    activePath,
    closing: s.closing !== null && gone(s.closing) ? null : s.closing
  }
}

/** Close a pill — straight away when clean, via the prompt when it has edits. */
export function requestClose(s: OpenFiles, path: string): OpenFiles {
  const f = fileAt(s, path)
  if (!f) return s
  return isDirty(f) ? (s.closing === path ? s : { ...s, closing: path }) : close(s, (p) => p === path)
}

export function cancelClose(s: OpenFiles): OpenFiles {
  return s.closing === null ? s : { ...s, closing: null }
}

/* ---- The files changing underneath ---------------------------------------- */

/**
 * `from` was renamed to `to`. Every open file follows it to its new path —
 * including when what was renamed is a directory above it — and so does
 * everything that names a path: the selection, the folder view, a close or a
 * reveal that is still pending.
 */
export function rename(s: OpenFiles, from: string, to: string): OpenFiles {
  const moved = (p: string | null): string | null => (p === null ? null : (movedPath(p, from, to) ?? p))
  const files = patch(s, () => true, (f) => (moved(f.path) === f.path ? f : { ...f, path: moved(f.path)! })).files
  const next: OpenFiles = {
    files,
    activePath: moved(s.activePath),
    folder: moved(s.folder),
    closing: moved(s.closing),
    reveal: s.reveal && moved(s.reveal.path) !== s.reveal.path ? { ...s.reveal, path: moved(s.reveal.path)! } : s.reveal
  }
  const same =
    next.files === s.files &&
    next.activePath === s.activePath &&
    next.folder === s.folder &&
    next.closing === s.closing &&
    next.reveal === s.reveal
  return same ? s : next
}

/**
 * `path` (a file, or a directory and everything in it) was deleted. Keeping a
 * binned file open in an editable buffer would invite saving it back into
 * existence, so its buffers close; a folder view of it goes back to the file.
 */
export function remove(s: OpenFiles, path: string): OpenFiles {
  const closed = close(s, (p) => isWithin(p, path))
  return closed.folder !== null && isWithin(closed.folder, path) ? { ...closed, folder: null } : closed
}

/**
 * The tree was refreshed: follow each open file's git state. The Diff toggle
 * appears or disappears with it and a cached diff is dropped as stale. File
 * contents (possibly mid-edit) are left alone.
 */
export function followGit(s: OpenFiles, gitStateOf: (path: string) => GitFileState | undefined): OpenFiles {
  return patch(
    s,
    () => true,
    (f) => {
      const gs = gitStateOf(f.path)
      if (gs === f.gitState) return f
      return { ...f, gitState: gs, diff: null, mode: !gs && !f.staged && f.mode === 'diff' ? 'file' : f.mode }
    }
  )
}

/* ---- Editing, loading, saving ---------------------------------------------- */

/** The draft changed. Editing commits to the file: it stops being a preview. */
export function edit(s: OpenFiles, path: string, draft: string): OpenFiles {
  return patch(s, at(path), (f) => (f.draft === draft && !f.preview ? f : { ...f, draft, preview: false }))
}

/** Switch a file between File, Diff and Preview. The draft survives: peeking at a diff discards nothing. */
export function setMode(s: OpenFiles, path: string, mode: ViewMode): OpenFiles {
  return patch(s, at(path), (f) => (f.mode === mode ? f : { ...f, mode }))
}

/**
 * A fetch for `path` has started. `loadId` names it — any number not used for
 * a load before — and what it brings back is addressed to that id, so a slow
 * response for a buffer that has since been closed, closed and reopened, or
 * given a newer fetch finds nobody waiting and is dropped. It does still find a
 * buffer that was merely renamed in the meantime.
 */
export function loadStarted(s: OpenFiles, path: string, loadId: number): OpenFiles {
  return patch(s, at(path), (f) => ({ ...f, loadId, loading: true, loadError: null }))
}

const awaiting = (loadId: number) => (f: OpenFile): boolean => f.loadId === loadId

/** Part of what a fetch was for has arrived. Loaded content is also the draft's starting point. */
export function loaded(
  s: OpenFiles,
  loadId: number,
  part: { diff: FileDiff } | { imageData: string } | { content: string }
): OpenFiles {
  return patch(s, awaiting(loadId), (f) => ('content' in part ? { ...f, content: part.content, draft: part.content } : { ...f, ...part }))
}

/**
 * A fetch failed: unreadable, deleted since the tree was fetched, over the
 * size cap. The buffer keeps whatever it had and shows the reason.
 */
export function loadFailed(s: OpenFiles, loadId: number, error: string): OpenFiles {
  return patch(s, awaiting(loadId), (f) => ({ ...f, loadError: error }))
}

/** A fetch is over, however it went. */
export function loadSettled(s: OpenFiles, loadId: number): OpenFiles {
  return patch(s, awaiting(loadId), (f) => ({ ...f, loading: false, loadId: null }))
}

/**
 * `written` reached the disk and reads back as `content`. Keystrokes that
 * landed during the write stay ahead of what was saved, and any cached diff is
 * now out of date.
 */
export function saved(s: OpenFiles, path: string, written: string, content: string): OpenFiles {
  return patch(s, at(path), (f) => ({
    ...f,
    content,
    draft: f.draft === written ? content : f.draft,
    diff: null,
    saveError: null
  }))
}

/** The write failed. The draft is kept. */
export function saveFailed(s: OpenFiles, path: string, error: string): OpenFiles {
  return patch(s, at(path), (f) => ({ ...f, saveError: error }))
}
