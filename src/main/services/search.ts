import type {
  SearchFileResult,
  SearchMatch,
  SearchQuery,
  SearchResults,
  SearchScope
} from '@shared/types'
import { git } from './git'
import * as repo from '../db/repositories'

/**
 * Content search across the workspace's checkouts, served by `git grep`.
 *
 * **Why a grep and not an index.** Every alternative worth considering builds
 * an inverted index, and an index has to be kept current. Orbital exists to run
 * coding agents, which rewrite files continuously and in bursts — so the index
 * would be stale most of the time and would spend the rest of it competing with
 * the agents for disk. `git grep` has nothing to invalidate. It is also already
 * here: every Worktree is a git checkout by definition, the git service already
 * owns process spawning, and `--untracked` covers exactly the tracked plus
 * untracked-but-not-ignored set that the file-name index uses, so the two
 * searches agree on which files exist. Ripgrep would be faster on a very large
 * repo and is the obvious upgrade, which is why the query and result shapes
 * here say nothing about git.
 *
 * **Cancellation is the feature that makes it usable.** The box searches as you
 * type, so most searches are obsolete before they finish. Each caller owns a
 * `searchId` slot; starting a search in a slot kills whatever was running in
 * it. Without that, a burst of keystrokes on a big repo queues a grep per
 * character and the last one lands seconds late.
 */

/** Interactive, so a much tighter bound than the git service's default. */
const SEARCH_TIMEOUT_MS = 20_000

/** Matches listed per file before the file is marked truncated. */
const PER_FILE_CAP = 50

/** Total matches returned when the caller names no limit. */
const DEFAULT_LIMIT = 2000

/** Files listed before the whole result is marked truncated. */
const FILE_CAP = 400

/**
 * Longest line returned intact. A minified bundle or a generated lockfile has
 * single lines in the hundreds of kilobytes; sending one to the renderer to
 * display forty characters of is pure waste, so a long line is clipped around
 * its first match.
 */
const MAX_LINE = 400

/** Characters of lead-in kept before the first match when clipping. */
const CLIP_LEAD = 60

/** Live searches by slot id, each holding the cancels of its running greps. */
const active = new Map<string, (() => void)[]>()

/** Kill everything running in a slot. Safe to call for an unknown slot. */
export function cancelSearch(searchId: string): void {
  const cancels = active.get(searchId)
  if (!cancels) return
  active.delete(searchId)
  for (const cancel of cancels) cancel()
}

/** Which checkouts a query covers. */
function checkoutsFor(
  scope: SearchScope,
  worktreeId: string | undefined
): { id: string; path: string }[] {
  const all = repo.worktrees.listPaths()
  if (scope === 'workspace' || !worktreeId) return all
  if (scope === 'worktree') return all.filter((w) => w.id === worktreeId)
  const projectId = all.find((w) => w.id === worktreeId)?.projectId
  return projectId ? all.filter((w) => w.projectId === projectId) : []
}

/** Escape a literal so it can go into a JS RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A JS RegExp equivalent to what git was asked to match, for highlighting the
 * matches inside a returned line. Null when the pattern cannot be expressed —
 * a PCRE construct JS does not have, say — in which case the line is shown
 * without highlights rather than not shown at all.
 *
 * git does the matching; this only decides which characters to paint. The two
 * can in principle disagree on an exotic pattern, and the failure mode of that
 * is a missing highlight on a line git correctly found, which is the right way
 * round.
 */
function highlighter(q: SearchQuery): RegExp | null {
  const body = q.regex ? q.query : escapeRegExp(q.query)
  const source = q.wholeWord ? `\\b(?:${body})\\b` : body
  try {
    return new RegExp(source, q.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}

/** Every match of `re` in `text`, as `[start, end)` pairs. */
function rangesIn(text: string, re: RegExp | null): [number, number][] {
  if (!re) return []
  const out: [number, number][] = []
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    // A zero-width match (an empty alternation, a lookahead-only pattern) would
    // never advance lastIndex and would spin here forever.
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push([m.index, m.index + m[0].length])
    if (out.length >= 100) break
  }
  return out
}

/** Clip a long line around its first match, shifting the ranges to suit. */
function clip(
  text: string,
  ranges: [number, number][]
): { text: string; ranges: [number, number][]; clippedStart: number } {
  if (text.length <= MAX_LINE) return { text, ranges, clippedStart: 0 }
  const first = ranges[0]?.[0] ?? 0
  const start = Math.max(0, first - CLIP_LEAD)
  const slice = text.slice(start, start + MAX_LINE)
  const shifted = ranges
    .map(([a, b]): [number, number] => [a - start, b - start])
    .filter(([a, b]) => b > 0 && a < slice.length)
    .map(([a, b]): [number, number] => [Math.max(0, a), Math.min(slice.length, b)])
  return { text: slice, ranges: shifted, clippedStart: start }
}

/** The `git grep` argv for a query. */
export function grepArgs(q: SearchQuery): string[] {
  const args = [
    '-c',
    'core.quotePath=false',
    'grep',
    '--no-color',
    // -I skips binaries; -n numbers lines; -z makes the field separator NUL so
    // a path containing a colon cannot be misparsed; --untracked matches the
    // file set the file-name index uses.
    '-I',
    '-n',
    '-z',
    '--untracked',
    '-m',
    String(PER_FILE_CAP)
  ]
  if (!q.caseSensitive) args.push('-i')
  if (q.wholeWord) args.push('-w')
  // PCRE rather than git's default basic regex: it is far closer to what a
  // developer types and to the JS RegExp used for highlighting.
  args.push(q.regex ? '-P' : '-F')
  args.push('-e', q.query, '--')
  const globs = (q.include ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
  // `top` anchors the glob at the checkout root rather than the process cwd,
  // and `glob` makes `**` mean what everyone expects.
  if (globs.length) args.push(...globs.map((g) => `:(top,glob)${g}`))
  else args.push('.')
  return args
}

/**
 * Parse `git grep -z -n` output. Records are newline-separated; within a
 * record the path, the line number and the text are NUL-separated.
 */
export function parseGrep(stdout: string, worktreeId: string, re: RegExp | null): SearchFileResult[] {
  const byPath = new Map<string, SearchFileResult>()
  for (const record of stdout.split('\n')) {
    if (!record) continue
    const firstNul = record.indexOf('\0')
    if (firstNul === -1) continue
    const secondNul = record.indexOf('\0', firstNul + 1)
    if (secondNul === -1) continue
    const path = record.slice(0, firstNul)
    const line = Number(record.slice(firstNul + 1, secondNul))
    if (!Number.isFinite(line)) continue
    let text = record.slice(secondNul + 1)
    // The record separator is the file's own line ending, so a CRLF checkout
    // leaves a carriage return on every line.
    if (text.endsWith('\r')) text = text.slice(0, -1)
    const clipped = clip(text, rangesIn(text, re))
    const match: SearchMatch = {
      line,
      text: clipped.text,
      ranges: clipped.ranges,
      clippedStart: clipped.clippedStart
    }
    const existing = byPath.get(path)
    if (existing) existing.matches.push(match)
    else byPath.set(path, { worktreeId, path, matches: [match], truncated: false })
  }
  for (const file of byPath.values()) {
    if (file.matches.length >= PER_FILE_CAP) file.truncated = true
  }
  return [...byPath.values()]
}

const EMPTY: SearchResults = { files: [], totalMatches: 0, truncated: false, errors: [], cancelled: false }

/**
 * Run `q` across its scoped checkouts. Never rejects: a checkout that fails
 * contributes an entry in `errors` and the rest of the search still answers.
 */
export async function searchContent(q: SearchQuery, searchId: string): Promise<SearchResults> {
  // Whatever this slot was doing is now obsolete.
  cancelSearch(searchId)

  const query = q.query
  // One or two characters match most of the tree; the result is useless and
  // the scan is the most expensive one there is. The caller gates on this too,
  // but main must not be made to do it by a caller that forgets.
  if (query.trim().length < 2) return EMPTY

  const scope: SearchScope = q.scope ?? (q.worktreeId ? 'worktree' : 'workspace')
  const checkouts = checkoutsFor(scope, q.worktreeId)
  if (checkouts.length === 0) return EMPTY

  const args = grepArgs({ ...q, query })
  const runs = checkouts.map((w) => ({
    worktreeId: w.id,
    run: git.captureCancellable(w.path, args, { timeoutMs: SEARCH_TIMEOUT_MS })
  }))
  const cancels = runs.map((r) => r.run.cancel)
  active.set(searchId, cancels)

  const settled = await Promise.all(runs.map((r) => r.run.result.then((res) => ({ worktreeId: r.worktreeId, res }))))

  // A newer search took the slot while this one was running, or it was
  // cancelled outright. Either way nothing here should reach the UI.
  if (active.get(searchId) !== cancels) return { ...EMPTY, cancelled: true }
  active.delete(searchId)
  if (settled.some((s) => s.res.cancelled)) return { ...EMPTY, cancelled: true }

  const re = highlighter(q)
  const limit = q.limit && q.limit > 0 ? q.limit : DEFAULT_LIMIT
  const files: SearchFileResult[] = []
  const errors: { worktreeId: string; message: string }[] = []
  let totalMatches = 0
  let truncated = false

  for (const { worktreeId, res } of settled) {
    // 0 = matches, 1 = none. Anything else is a real failure (a bad regex, a
    // checkout whose directory has gone), and belongs in front of the user
    // rather than silently reported as "no results".
    if (res.code !== 0 && res.code !== 1) {
      const message = (res.stderr || res.stdout || 'search failed').trim().split('\n')[0]
      errors.push({ worktreeId, message: message.replace(/^fatal:\s*/, '') })
      continue
    }
    for (const file of parseGrep(res.stdout, worktreeId, re)) {
      if (files.length >= FILE_CAP || totalMatches >= limit) {
        truncated = true
        break
      }
      const room = limit - totalMatches
      if (file.matches.length > room) {
        file.matches = file.matches.slice(0, room)
        file.truncated = true
        truncated = true
      }
      totalMatches += file.matches.length
      files.push(file)
    }
    if (files.some((f) => f.truncated)) truncated = true
  }

  // Stable, readable order: by checkout, then by path.
  files.sort((a, b) => a.worktreeId.localeCompare(b.worktreeId) || a.path.localeCompare(b.path))
  return { files, totalMatches, truncated, errors, cancelled: false }
}
