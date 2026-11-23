/**
 * Where a project that holds several repos is rooted, worked out from its
 * repos' paths alone. Plain string work, no filesystem: the paths are the
 * ones Orbital stored, and the answer only has to be a sensible folder to
 * name the project after and open a session in.
 *
 * Paths compare case-insensitively and either slash separates, because they
 * are Windows paths first. The answer keeps the first path's own spelling.
 */

/** A path split into its segments, with the separators kept so it can be rebuilt as written. */
function tokens(path: string): string[] {
  // Trailing separators say nothing about the folder; a bare root keeps its own.
  const trimmed = path.replace(/[\\/]+$/, '') || path
  return trimmed.split(/([\\/]+)/)
}

/** The segments of a path (every other token), the first being a drive, '' for a leading slash, or a name. */
function segments(path: string): string[] {
  return tokens(path).filter((_, i) => i % 2 === 0)
}

/** The first `count` segments of `path`, spelled as `path` spells them. */
function prefix(path: string, count: number): string {
  return tokens(path)
    .slice(0, count * 2 - 1)
    .join('')
}

/**
 * The deepest folder every path is inside (or is), or null when they share
 * nothing below a root: different drives, or only `C:\` in common. A drive
 * root is not offered as a project's root, since nothing would be named after
 * it and every repo on the drive would be "inside" it.
 */
export function nearestCommonDir(paths: string[]): string | null {
  if (paths.length === 0) return null
  const all = paths.map(segments)
  let count = 0
  for (;;) {
    const seg = all[0][count]
    if (seg === undefined) break
    if (!all.every((s) => s[count] !== undefined && s[count].toLowerCase() === seg.toLowerCase())) break
    count++
  }
  return count <= 1 ? null : prefix(paths[0], count)
}

/** The folder `path` is in, or `path` itself when it is already a root. */
export function parentDir(path: string): string {
  const all = tokens(path)
  const count = Math.ceil(all.length / 2)
  if (count <= 1) return path
  // Up to a root, keep its separator: `C:\`, not the drive-relative `C:`; `/`, not ''.
  return count === 2 ? all.slice(0, 2).join('') : prefix(path, count - 1)
}

/** The last segment of a path: what a folder is called. */
export function baseName(path: string): string {
  const all = segments(path)
  return all[all.length - 1] ?? ''
}

/**
 * The root for a project holding repos at `paths` (in member order): their
 * nearest common folder or, when they have none, the folder the first one is
 * in.
 */
export function projectRootFor(paths: string[]): string {
  return nearestCommonDir(paths) ?? parentDir(paths[0] ?? '')
}
