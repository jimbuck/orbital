import { EventEmitter } from 'node:events'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Project, Worktree } from '@shared/types'
import { git, type GitWorktreeEntry } from './git'

/**
 * Git-worktree auto-discovery. Orbital is a worktree dashboard: EVERY checkout
 * of a project's repo should appear under the project, whether it was created
 * in Orbital or with `git worktree add` in some terminal. `git worktree list`
 * is the source of truth; the DB rows only carry Orbital's per-worktree UI
 * state (tabs/panes/layout/status) for checkouts that actually exist.
 *
 * {@link planWorktreeSync} computes the diff between git's list and the DB rows
 * (pure — the caller applies it), and {@link WorktreesWatcher} watches the
 * repo's `.git/worktrees` administrative directory so external add/remove is
 * reflected live, not just on relaunch.
 */

/** Normalize a path for identity comparison (Windows: case- and slash-insensitive). */
export function normPath(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export interface WorktreeSyncPlan {
  /**
   * Create the project's `root` Worktree row on this branch. Set when the rows
   * have no root yet — a project that entered via the workspace YAML (rather
   * than the Add Project picker) starts as a bare `projects` row.
   */
  createRoot: { branch: string } | null
  /** Checkouts git knows about that have no DB row yet — create rows for them. */
  adopt: Array<{ path: string; name: string; branch: string }>
  /** DB rows whose checkout no longer exists in git — tear down and delete. */
  remove: Worktree[]
  /** Rows whose checked-out branch moved (per git, cheaper than re-asking HEAD). */
  branchUpdates: Array<{ path: string; branch: string }>
}

/**
 * Diff git's worktree list against the project's DB rows.
 *
 * - The main checkout maps to the project's `root` row (never adopted/removed).
 * - Bare/prunable entries and directories that don't exist are not adoptable.
 * - `skipPaths` (other projects' repo roots) are never adopted here — a checkout
 *   that IS another project belongs to that project's rail entry.
 * - A linked row survives only while git still lists its path AND the directory
 *   exists; otherwise it is removed (its tabs/layout go with it — UI state is
 *   keyed to a live checkout).
 */
export function planWorktreeSync(
  project: Project,
  rows: Worktree[],
  entries: GitWorktreeEntry[],
  skipPaths: string[]
): WorktreeSyncPlan {
  const rootKey = normPath(project.repoPath)
  const skip = new Set(skipPaths.map(normPath))
  const rowByPath = new Map(rows.map((w) => [normPath(w.path), w]))

  const live = new Map<string, GitWorktreeEntry>()
  for (const e of entries) {
    if (e.bare || e.prunable) continue
    live.set(normPath(e.path), e)
  }

  const plan: WorktreeSyncPlan = { createRoot: null, adopt: [], remove: [], branchUpdates: [] }

  // A YAML-authored project has no root row yet — create it on the checkout's
  // current branch so the rail header (and its git panel) work immediately.
  if (!rows.some((w) => w.kind === 'root')) {
    plan.createRoot = { branch: live.get(rootKey)?.branch ?? '(detached)' }
  }

  for (const [key, entry] of live) {
    const branch = entry.branch ?? '(detached)'
    const row = rowByPath.get(key)
    if (row) {
      if (row.branch !== branch) plan.branchUpdates.push({ path: row.path, branch })
      continue
    }
    if (key === rootKey || skip.has(key)) continue
    if (!existsSync(entry.path)) continue
    // Store the OS-native form; git reports forward slashes even on Windows.
    plan.adopt.push({ path: resolve(entry.path), name: basename(entry.path), branch })
  }

  for (const row of rows) {
    if (row.kind !== 'linked') continue // the root row lives and dies with the project
    if (!live.has(normPath(row.path)) || !existsSync(row.path)) plan.remove.push(row)
  }

  return plan
}

/** Coalesce bursts of FS events (a worktree add touches several entries). */
const DEBOUNCE_MS = 500

/**
 * Watches one repo's `.git/worktrees` administrative directory and emits
 * `('changed')` (debounced) when checkouts are added or removed — including the
 * directory itself appearing when the repo's first worktree is created (the
 * parent git dir is watched for exactly that transition). Watch failures are
 * tolerated; a `rearm()` after each event re-attaches whatever now exists.
 */
export class WorktreesWatcher extends EventEmitter {
  private handles: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private gitDir: string | null = null

  constructor(private readonly repoPath: string) {
    super()
  }

  async start(): Promise<void> {
    try {
      this.gitDir = await git.commonGitDir(this.repoPath)
    } catch {
      return // not a repo (or git missing) — nothing to watch
    }
    this.attach()
  }

  private attach(): void {
    if (this.stopped || !this.gitDir) return
    for (const h of this.handles) h.close()
    this.handles = []

    const fire = (): void => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        // Re-attach first: the worktrees dir may have just been created (first
        // worktree) or removed, changing what needs watching.
        this.attach()
        this.emit('changed')
      }, DEBOUNCE_MS)
    }

    const tryWatch = (dir: string, filter?: (filename: string | null) => boolean): void => {
      try {
        const h = watch(dir, (_event, filename) => {
          if (filter && !filter(filename)) return
          fire()
        })
        h.on('error', () => {
          // Directory vanished mid-watch (e.g. last worktree pruned) — re-arm
          // so the fallback git-dir watch takes over and catches re-creation.
          try {
            h.close()
          } catch {
            /* already closed */
          }
          fire()
        })
        this.handles.push(h)
      } catch {
        // Can't watch (missing dir) — the fallback below still covers us.
      }
    }

    const adminDir = join(this.gitDir, 'worktrees')
    if (existsSync(adminDir)) {
      // The admin dir itself: fires on every worktree add/remove.
      tryWatch(adminDir)
    } else {
      // No worktrees yet: watch the git dir ONLY for `worktrees/` appearing —
      // an unfiltered watch here would fire on every commit (HEAD/index churn).
      tryWatch(this.gitDir, (f) => f === null || f === 'worktrees')
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const h of this.handles) h.close()
    this.handles = []
  }
}
