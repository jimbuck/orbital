import type { FileSearchHit } from '@shared/types'
import { fuzzyMatchPath } from '@shared/fuzzy'
import { git } from './git'
import * as repo from '../db/repositories'

/**
 * The command palette's cross-Worktree file search.
 *
 * Every keystroke in the palette asks for the best matches across every
 * checkout in the workspace, so the per-checkout path list is cached rather
 * than re-shelled. Two things keep the cache honest:
 *
 *  - **Invalidation on change.** `invalidate()` is called from the same
 *    coalesced git-changed signal the git panel and file tree refresh on (see
 *    runtime.broadcastGitChanged), so a file an agent just created is
 *    searchable as soon as the rest of the UI knows about it.
 *  - **A TTL backstop.** The watcher can miss things (a checkout on a network
 *    share, a watcher that failed to start), and a palette that cannot find a
 *    file that plainly exists is worse than an occasional extra `git ls-files`.
 *
 * Entries are built lazily — the first search after launch pays for the
 * checkouts it touches — and a checkout whose listing fails (a repo mid-rebase,
 * a worktree whose directory is gone) yields an empty list rather than failing
 * the whole search.
 */

/** How long a cached listing is trusted without a change signal. */
const TTL_MS = 30_000

/** Hits returned when the caller does not ask for a specific number. */
const DEFAULT_LIMIT = 40

interface Entry {
  paths: string[]
  /** When the listing was taken (Date.now). */
  at: number
  /** An in-flight listing, so concurrent searches share one `git ls-files`. */
  pending: Promise<string[]> | null
}

const cache = new Map<string, Entry>()

/** Drop cached listings for these Worktrees (their checkout moved). */
export function invalidate(worktreeIds: Iterable<string>): void {
  for (const id of worktreeIds) cache.delete(id)
}

/** Drop everything (workspace teardown, tests). */
export function clear(): void {
  cache.clear()
}

/** This Worktree's path list, from cache when fresh. Never rejects. */
async function pathsFor(worktreeId: string, repoPath: string): Promise<string[]> {
  const entry = cache.get(worktreeId)
  if (entry) {
    if (entry.pending) return entry.pending
    if (Date.now() - entry.at < TTL_MS) return entry.paths
  }
  const fresh: Entry = { paths: entry?.paths ?? [], at: entry?.at ?? 0, pending: null }
  fresh.pending = git
    .filePaths(repoPath)
    .catch(() => [] as string[])
    .then((paths) => {
      // Only publish if this entry is still the live one. An invalidate() while
      // the listing was in flight means the checkout moved AFTER `git ls-files`
      // read it, so storing the result now would cache a listing that is
      // already known to be stale — and the TTL would keep it for 30 seconds.
      if (cache.get(worktreeId) === fresh) {
        fresh.paths = paths
        fresh.at = Date.now()
        fresh.pending = null
      }
      return paths
    })
  cache.set(worktreeId, fresh)
  return fresh.pending
}

/**
 * The best `limit` file matches for `query` across the workspace's Worktrees.
 *
 * An empty query returns nothing rather than "the first N files of whichever
 * Worktree sorted first" — a list nobody asked for, in an order that means
 * nothing. The palette shows its own suggestions in that state.
 */
export async function searchFiles(query: string, limit = DEFAULT_LIMIT): Promise<FileSearchHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const worktrees = repo.worktrees.listPaths()
  const listings = await Promise.all(
    worktrees.map(async (w) => ({ worktreeId: w.id, paths: await pathsFor(w.id, w.path) }))
  )

  // Ranking is a bounded insertion into a list of at most `limit` entries
  // rather than scoring everything and sorting: a large workspace produces
  // hundreds of thousands of candidates per keystroke, and sorting all of them
  // to show twenty is the one part of this that would actually hurt.
  const best: FileSearchHit[] = []
  let floor = -Infinity
  const consider = (hit: FileSearchHit): void => {
    if (best.length === limit && hit.score <= floor) return
    let i = best.length
    while (i > 0 && best[i - 1].score < hit.score) i--
    best.splice(i, 0, hit)
    if (best.length > limit) best.pop()
    if (best.length === limit) floor = best[best.length - 1].score
  }

  for (const { worktreeId, paths } of listings) {
    for (const path of paths) {
      const m = fuzzyMatchPath(trimmed, path)
      if (m) consider({ worktreeId, path, score: m.score })
    }
  }
  return best
}
