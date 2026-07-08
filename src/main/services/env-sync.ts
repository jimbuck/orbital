import fs from 'node:fs'
import { mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import picomatch from 'picomatch'
import chokidar, { type FSWatcher, type WatchOptions } from 'chokidar'

// `.git` is never walked or watched. `node_modules` is only walked when a
// pattern explicitly targets it (the one-shot sync at worktree creation), and
// is never live-watched — mirroring dependency churn would melt the watcher;
// a package-manager install in the worktree handles later drift.
// `.orbital-worktrees` is excluded defensively: worktrees normally live
// beside the repo (see worktree.ts), but if a workspace root happens to
// enclose one, recursive globs like `**/.env` must never sync files out of
// sibling worktrees.
const WATCH_IGNORED = ['**/.git/**', '**/node_modules/**', '**/.orbital-worktrees/**']

/** Directory names the sync walk never descends into (see WATCH_IGNORED). */
const ALWAYS_SKIPPED_DIRS = ['.git', '.orbital-worktrees']

/** True when any pattern targets `node_modules`, so the walk must descend into it. */
function targetsNodeModules(patterns: string[]): boolean {
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
  const skip = new Set(
    targetsNodeModules(patterns) ? ALWAYS_SKIPPED_DIRS : [...ALWAYS_SKIPPED_DIRS, 'node_modules']
  )
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
 * Watches a root checkout for changes to env files matching `patterns` and
 * mirrors add/change events into every registered worktree. Designed to never
 * throw out of the watcher callbacks.
 */
export class EnvSyncWatcher {
  private readonly rootPath: string
  private patterns: string[]
  private readonly worktrees = new Set<string>()
  private watcher: FSWatcher | null = null

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
    // `dot: true` is honored by chokidar's matcher but absent from its public
    // WatchOptions type, so we assert the literal to keep strict mode happy.
    const watcher = chokidar.watch(this.patterns, {
      cwd: this.rootPath,
      dot: true,
      ignoreInitial: true,
      ignored: WATCH_IGNORED
    } as WatchOptions)
    const onChange = (rel: string): void => {
      void this.fanOut(rel)
    }
    watcher.on('add', onChange)
    watcher.on('change', onChange)
    watcher.on('error', () => {
      // Swallow watcher errors; never throw out of the watcher.
    })
    this.watcher = watcher
  }

  /** Stop watching and release the underlying FSWatcher. */
  stop(): void {
    if (!this.watcher) return
    const watcher = this.watcher
    this.watcher = null
    void watcher.close().catch(() => {
      // Ignore close failures.
    })
  }

  /** Copy a changed relative path into each registered worktree. */
  private async fanOut(rel: string): Promise<void> {
    const normalized = rel.split(path.sep).join('/')
    for (const worktree of this.worktrees) {
      try {
        await copyRel(this.rootPath, worktree, normalized)
      } catch {
        // Resilient: a failed copy to one worktree must not affect others.
      }
    }
  }
}
