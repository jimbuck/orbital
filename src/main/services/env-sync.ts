import fs from 'node:fs'
import { mkdir, copyFile, readdir, readlink, rm, stat, lstat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import picomatch from 'picomatch'

// `.git` is never walked or watched. `node_modules` is only walked when a
// pattern explicitly targets it (the one-shot sync at worktree creation), and
// is never live-watched — mirroring dependency churn would melt the watcher;
// a package-manager install in the worktree handles later drift.
// `.orbital-worktrees` is excluded defensively: worktrees normally live
// beside the repo (see worktree.ts), but if a project root happens to
// enclose one, recursive globs like `**/.env` must never sync files out of
// sibling worktrees.
// The recursive fs.watch delivers every descendant path, so these are filtered
// per-event by segment (see WATCH_IGNORED_SEGMENTS) rather than by pruning the
// walk as the glob-based watcher once did.
const WATCH_IGNORED_SEGMENTS = ['.git', 'node_modules', '.orbital-worktrees']

/** Directory names the sync walk never descends into (see WATCH_IGNORED_SEGMENTS). */
const ALWAYS_SKIPPED_DIRS = ['.git', '.orbital-worktrees']

/** True when any pattern targets `node_modules`, so it should be bulk-copied (see copyNodeModulesTree). */
export function targetsNodeModules(patterns: string[]): boolean {
  return patterns.some((p) => p === 'node_modules' || p.startsWith('node_modules/'))
}

/**
 * Recursively collect every file under `dir`, returning paths relative to
 * `root` using forward slashes. Directories named in `skip` are skipped
 * entirely. Read failures are swallowed so a single unreadable directory
 * can't abort the whole walk.
 */
function walkFiles(root: string, dir: string, out: string[], skip: Set<string>): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue
      walkFiles(root, abs, out, skip)
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join('/'))
    }
  }
}

/**
 * Copy a single relative file from root -> worktree, creating parent dirs.
 *
 * Conflict rule: the root checkout is the source of truth, so an existing
 * worktree copy is always OVERWRITTEN (never skipped, no prompt). Synced
 * files are gitignored — nothing committed can be lost — and mirroring the
 * root's latest state is the whole point of the sync; skipping would leave
 * stale secrets/config behind silently. Users edit synced files at the root.
 */
async function copyRel(rootPath: string, worktreePath: string, rel: string): Promise<void> {
  const src = path.join(rootPath, rel)
  const dest = path.join(worktreePath, rel)
  await mkdir(path.dirname(dest), { recursive: true })
  await copyFile(src, dest)
}

/**
 * One-shot sync: walk `rootPath`, match files against `patterns`, and copy each
 * match into `worktreePath` at the same relative location. Returns the list of
 * copied relative paths. Per-file copy failures are caught so the remainder
 * still sync.
 */
export async function syncEnvFiles(
  rootPath: string,
  worktreePath: string,
  patterns: string[]
): Promise<string[]> {
  if (patterns.length === 0) return []

  const isMatch = picomatch(patterns, { dot: true })
  const rels: string[] = []
  // node_modules is ALWAYS skipped by this file-by-file walk — it is copied in
  // one bulk async pass by copyNodeModulesTree instead. A synchronous walk +
  // per-file copy of node_modules (hundreds of thousands of files) would block
  // the main process for minutes, so it must never ride on this path. A
  // `node_modules/**` pattern therefore matches nothing here; it only signals
  // the bulk copy (see targetsNodeModules / worktree.ts).
  const skip = new Set([...ALWAYS_SKIPPED_DIRS, 'node_modules'])
  walkFiles(rootPath, rootPath, rels, skip)

  const copied: string[] = []
  for (const rel of rels) {
    if (!isMatch(rel)) continue
    try {
      await copyRel(rootPath, worktreePath, rel)
      copied.push(rel)
    } catch {
      // Skip files that fail to copy (permissions, races, etc.).
    }
  }
  return copied
}

/**
 * Left inside a worktree's `node_modules` from the moment a bulk copy starts
 * until it finishes, so a copy that never finished — the app quit, crashed, or
 * the copy itself stalled — is recognisable on the next launch and resumed
 * rather than left half-done with nothing to say so. Lives inside
 * `node_modules` because that is gitignored by definition.
 */
export const COPY_IN_PROGRESS_MARKER = '.orbital-copy-in-progress'

/** What one bulk copy did — logged by the caller, and the tests' whole view. */
export interface CopyReport {
  /** Files written. */
  copied: number
  /** Files left alone because the worktree already had an up-to-date copy. */
  skipped: number
  /** Links recreated. */
  links: number
  /** Bytes written. */
  bytes: number
  /** Every failure is counted; the first few are kept with their paths. */
  errorCount: number
  errors: { path: string; message: string }[]
  ms: number
}

const ERRORS_KEPT = 20

export interface CopyOptions {
  /** File copies in flight at once. */
  concurrency?: number
  /** Called after every file is copied or skipped, with the running total. */
  onProgress?: (done: number) => void
}

/** Bound how many async operations run at once, without a queue of closures. */
class Limiter {
  private active = 0
  private readonly waiters: (() => void)[] = []
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}

/**
 * One copy at a time per SOURCE tree. Creating several worktrees in a row
 * used to start that many full copies of the same node_modules at once, and
 * the observed result was every one of them stalled part-way with nothing
 * reported. Serialising them costs nothing in wall-clock (the disk is the
 * bottleneck either way) and turns "four copies fighting over one tree" into
 * four copies, each of which either finishes or fails on its own.
 */
const copyQueues = new Map<string, Promise<unknown>>()

/**
 * Bulk-copy the root checkout's `node_modules` into a worktree. Deliberately
 * separate from syncEnvFiles's file-by-file walk: node_modules holds tens or
 * hundreds of thousands of files, so a synchronous walk + per-file copy would
 * freeze the main process for minutes. Everything here is async and bounded,
 * so the caller runs it in the BACKGROUND while the Worktree is already usable.
 *
 * What it does that `fs.cp` did not:
 *
 *  - Reports. Per-file failures are counted and the first few kept with their
 *    paths, and the copy carries on past them; the caller logs the report. The
 *    old call resolved with nothing and, when it stalled, never resolved at all.
 *  - Resumes. A file the worktree already has, at the same size and no older
 *    than the source, is skipped — so running the copy again finishes what an
 *    interrupted one started instead of rewriting everything.
 *  - Serialises. See {@link copyQueues}.
 *  - Marks. {@link COPY_IN_PROGRESS_MARKER} is written first and removed last.
 *  - Rebases links. A link whose target is inside the ROOT checkout (an npm
 *    workspace package, `node_modules/foo -> <root>/packages/foo`) is pointed at
 *    the same path inside the worktree, so the worktree's copy refers to its own
 *    source rather than the root's.
 *
 * No-op when the root has no node_modules.
 */
export function copyNodeModulesTree(
  rootPath: string,
  worktreePath: string,
  opts: CopyOptions = {}
): Promise<CopyReport> {
  const key = path.resolve(rootPath).toLowerCase()
  const prev = copyQueues.get(key) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(() => copyTree(rootPath, worktreePath, opts))
  copyQueues.set(key, run)
  run
    .catch(() => undefined)
    .finally(() => {
      if (copyQueues.get(key) === run) copyQueues.delete(key)
    })
  return run
}

async function copyTree(rootPath: string, worktreePath: string, opts: CopyOptions): Promise<CopyReport> {
  const started = Date.now()
  const report: CopyReport = { copied: 0, skipped: 0, links: 0, bytes: 0, errorCount: 0, errors: [], ms: 0 }
  const src = path.join(rootPath, 'node_modules')
  const dest = path.join(worktreePath, 'node_modules')
  if (!fs.existsSync(src)) return report

  const limiter = new Limiter(opts.concurrency ?? 16)
  let done = 0
  const fail = (p: string, err: unknown): void => {
    report.errorCount++
    if (report.errors.length < ERRORS_KEPT) {
      report.errors.push({ path: p, message: err instanceof Error ? err.message : String(err) })
    }
  }
  const tick = (): void => {
    done++
    opts.onProgress?.(done)
  }

  const copyOne = async (from: string, to: string): Promise<void> => {
    try {
      const st = await stat(from)
      const existing = await stat(to).catch(() => null)
      if (existing && existing.isFile() && existing.size === st.size && existing.mtimeMs >= st.mtimeMs) {
        report.skipped++
        return
      }
      await copyFile(from, to)
      report.copied++
      report.bytes += st.size
    } catch (err) {
      fail(from, err)
    } finally {
      tick()
    }
  }

  const copyLink = async (from: string, to: string): Promise<void> => {
    try {
      if (await lstat(to).catch(() => null)) {
        report.skipped++
        return
      }
      let target = await readlink(from)
      if (path.isAbsolute(target)) {
        const rel = path.relative(rootPath, target)
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) target = path.join(worktreePath, rel)
      }
      // A junction is what a directory link is on Windows without elevation;
      // 'file'/'junction' are ignored elsewhere. Decide by the SOURCE target's
      // type, since the rebased target may not exist yet.
      const isDir = await stat(from)
        .then((st) => st.isDirectory())
        .catch(() => false)
      await symlink(target, to, isDir ? 'junction' : 'file')
      report.links++
    } catch (err) {
      fail(from, err)
    } finally {
      tick()
    }
  }

  const jobs: Promise<void>[] = []
  const walk = async (from: string, to: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      await mkdir(to, { recursive: true })
      entries = await readdir(from, { withFileTypes: true })
    } catch (err) {
      fail(from, err)
      return
    }
    for (const e of entries) {
      const f = path.join(from, e.name)
      const t = path.join(to, e.name)
      if (e.isSymbolicLink()) jobs.push(limiter.run(() => copyLink(f, t)))
      else if (e.isDirectory()) await walk(f, t)
      else if (e.isFile()) jobs.push(limiter.run(() => copyOne(f, t)))
    }
  }

  const marker = path.join(dest, COPY_IN_PROGRESS_MARKER)
  await mkdir(dest, { recursive: true })
  await writeFile(marker, '').catch(() => undefined)
  await walk(src, dest)
  await Promise.all(jobs)
  await rm(marker, { force: true }).catch(() => undefined)
  report.ms = Date.now() - started
  return report
}

/** True when a worktree's node_modules copy was started and never finished. */
export function hasIncompleteCopy(worktreePath: string): boolean {
  return fs.existsSync(path.join(worktreePath, 'node_modules', COPY_IN_PROGRESS_MARKER))
}

/**
 * Watches a root checkout for changes to env files matching `patterns` and
 * mirrors add/change events into every registered worktree. Designed to never
 * throw out of the watcher callbacks.
 */
export class EnvSyncWatcher {
  private readonly rootPath: string
  private patterns: string[]
  private readonly worktrees = new Set<string>()
  private watcher: fs.FSWatcher | null = null
  // Coalesce rapid successive events for the same path — editors commonly
  // write-then-rename, firing several events for one logical save.
  private readonly pending = new Map<string, NodeJS.Timeout>()

  constructor(rootPath: string, patterns: string[]) {
    this.rootPath = rootPath
    this.patterns = [...patterns]
  }

  /** Register a worktree to receive future env-file updates. */
  register(worktreePath: string): void {
    this.worktrees.add(worktreePath)
  }

  /** Stop mirroring updates to a worktree. */
  unregister(worktreePath: string): void {
    this.worktrees.delete(worktreePath)
  }

  /**
   * Replace the watched glob patterns and (re)start. Idempotent: stop() no-ops
   * when not running and start() no-ops on empty patterns, so this correctly
   * revives a watcher that was stopped when patterns were temporarily cleared.
   */
  updatePatterns(patterns: string[]): void {
    this.patterns = [...patterns]
    this.stop()
    this.start()
  }

  /** Begin watching. No-op if already running or no patterns configured. */
  start(): void {
    if (this.watcher || this.patterns.length === 0) return
    const isMatch = picomatch(this.patterns, { dot: true })
    // One native recursive handle (ReadDirectoryChangesW on Windows) instead of
    // chokidar's per-directory glob walk, which duplicated the git watcher's
    // full-tree scan and pegged the main process at startup. Events are matched
    // in JS against the same picomatch used by syncEnvFiles.
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(this.rootPath, { recursive: true })
    } catch {
      // Never crash the main process if the watch can't be established.
      return
    }
    watcher.on('change', (_eventType, filename) => {
      // A null filename can't be matched against patterns; the one-shot sync at
      // worktree creation covers files missed here. 'rename' covers both create
      // and delete — fanOut simply attempts the copy.
      if (filename == null) return
      const rel = filename.toString().split(path.sep).join('/')
      if (rel.split('/').some((seg) => WATCH_IGNORED_SEGMENTS.includes(seg))) return
      if (!isMatch(rel)) return
      this.schedule(rel)
    })
    watcher.on('error', () => {
      // Swallow watcher errors; never throw out of the watcher.
    })
    this.watcher = watcher
  }

  /** Stop watching and release the underlying FSWatcher. */
  stop(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    if (!this.watcher) return
    const watcher = this.watcher
    this.watcher = null
    try {
      watcher.close()
    } catch {
      // Ignore close failures.
    }
  }

  /** Debounce per-path so a burst of write/rename events yields one fanOut. */
  private schedule(rel: string): void {
    const existing = this.pending.get(rel)
    if (existing) clearTimeout(existing)
    this.pending.set(
      rel,
      setTimeout(() => {
        this.pending.delete(rel)
        void this.fanOut(rel)
      }, 100)
    )
  }

  /** Copy a changed relative path into each registered worktree. */
  private async fanOut(rel: string): Promise<void> {
    const normalized = rel.split(path.sep).join('/')
    // 'rename' fires for deletes too; skip the fanOut when the source is gone
    // rather than doing pointless per-worktree copies that would all fail.
    if (!fs.existsSync(path.join(this.rootPath, normalized))) return
    for (const worktree of this.worktrees) {
      try {
        await copyRel(this.rootPath, worktree, normalized)
      } catch {
        // Resilient: a failed copy to one worktree must not affect others.
      }
    }
  }
}
