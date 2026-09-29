/**
 * The open-file strip's preview rules, VS Code's model: a single click shows a
 * file as THE preview (one at a time, drawn in italics), and the next single
 * click on another file replaces it rather than piling up pills. Committing to
 * a file — double-clicking it, editing it, saving it — promotes the preview to
 * an ordinary open file that stays until it is closed.
 *
 * Pure functions over the editor's buffer list so the rules can be tested
 * without mounting the editor. Each returns the SAME array when nothing
 * changed, so a React state setter that uses them bails out of the re-render.
 */

export interface PreviewableFile {
  path: string
  /** The single, replaceable preview pill (italic label). */
  preview: boolean
}

export interface ShowResult<T> {
  files: T[]
  /** The preview this call pushed out of the strip, if it replaced one. */
  replaced: string | null
}

/**
 * Show `path` in the strip, either as the preview or as a permanent file.
 *
 * - Already open: a permanent ask promotes it if it was the preview; a preview
 *   ask leaves it be (a click on an open file just selects it).
 * - Not open, as the preview: takes the old preview's slot, replacing it, or
 *   goes on the end when there is no preview yet.
 * - Not open, permanent: goes on the end, and any preview stays where it is.
 *
 * `make` builds the new buffer; `preview` is set on it here.
 */
export function showFile<T extends PreviewableFile>(
  files: T[],
  path: string,
  make: () => T,
  preview: boolean
): ShowResult<T> {
  if (files.some((f) => f.path === path)) {
    return { files: preview ? files : promoteFile(files, path), replaced: null }
  }
  const fresh = { ...make(), path, preview }
  if (!preview) return { files: [...files, fresh], replaced: null }
  const slot = files.findIndex((f) => f.preview)
  if (slot === -1) return { files: [...files, fresh], replaced: null }
  const next = files.slice()
  const replaced = next[slot].path
  next[slot] = fresh
  return { files: next, replaced }
}

/** Make `path` a permanent open file. A no-op unless it is the preview. */
export function promoteFile<T extends PreviewableFile>(files: T[], path: string): T[] {
  if (!files.some((f) => f.path === path && f.preview)) return files
  return files.map((f) => (f.path === path ? { ...f, preview: false } : f))
}
