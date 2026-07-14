import fs from 'node:fs'
import { mkdir, copyFile, cp } from 'node:fs/promises'
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
 * Bulk-copy the root checkout's `node_modules` into a fresh worktree, recursively
 * and asynchronously. Deliberately separate from syncEnvFiles's file-by-file
 * walk: node_modules holds hundreds of thousands of files, so a synchronous walk
 * + per-file copy would freeze the main process for minutes. `fs.cp` yields
 * between operations, so the caller runs this in the BACKGROUND while the
 * Worktree is already usable. No-op when the root has no node_modules.
 */
export async function copyNodeModulesTree(rootPath: string, worktreePath: string): Promise<void> {
  const src = path.join(rootPath, 'node_modules')
  if (!fs.existsSync(src)) return
  const dest = path.join(worktreePath, 'node_modules')
  await cp(src, dest, { recursive: true, force: true, errorOnExist: false })
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
