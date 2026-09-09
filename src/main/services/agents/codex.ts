/**
 * OpenAI Codex CLI agent provider.
 *
 * Boots `codex` directly in the Worktree's checkout. The Codex CLI has no
 * --append-system-prompt-file equivalent, so the briefing file is not passed.
 *
 * Sessions: Codex assigns its own thread id and offers no flag to choose one,
 * but it records every session as a rollout file named after that id —
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`,
 * whose first line is `{"type":"session_meta","payload":{"id","cwd",…}}`. So
 * the id is discovered after launch by watching for the rollout that appeared
 * in this worktree, and a respawn runs `codex resume <id>`.
 */
import { join } from 'node:path'
import type { AgentContext, AgentProvider, ResolvedCommand, SessionLookup } from './provider'
import { resolveExecutable } from './executable'
import { UUID_RE, files, mtimeMs, readHead, samePath, subdirs } from './sessions'

/** Where Codex files its (unarchived) sessions under the profile dir. */
const SESSIONS_SUBDIR = 'sessions'

/**
 * A rollout filename: `rollout-<YYYY-MM-DDThh-mm-ss>-<thread-id>[_<rollout-id>].jsonl`,
 * optionally `.zst`-compressed once Codex has archived it in place. The thread
 * id (before any `_` suffix, which a `thread/revert` adds) is what `codex resume` takes.
 */
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i

/** Thread id encoded in a rollout filename, or null for anything else. */
export function codexThreadIdFromFilename(name: string): string | null {
  const m = ROLLOUT_RE.exec(name)
  return m && UUID_RE.test(m[1]) ? m[1].toLowerCase() : null
}

/**
 * The working directory a rollout was started in, read from its session_meta
 * line. Reads only the head of the file — the meta line is the first record.
 * Compressed rollouts are opaque here (null), which only matters for sessions
 * old enough to have been compacted, never for one that just started.
 */
export function codexRolloutCwd(path: string): string | null {
  if (path.endsWith('.zst')) return null
  let seen = 0
  for (const line of readHead(path).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (++seen > HEAD_RECORDS) break
    let rec: { type?: string; payload?: { cwd?: unknown }; cwd?: unknown }
    try {
      rec = JSON.parse(trimmed)
    } catch {
      continue // not JSON — keep scanning
    }
    // Current format nests the meta under `payload`; the 2025 format wrote the
    // meta object itself as the first line, with the cwd only inside the
    // <environment_context> of the first user message a record or two later.
    const cwd = rec.type === 'session_meta' ? rec.payload?.cwd : rec.cwd
    if (typeof cwd === 'string') return cwd
    const tagged = findTaggedCwd(rec)
    if (tagged) return tagged
  }
  return null
}

/** How many leading records of a rollout are worth inspecting for the cwd. */
const HEAD_RECORDS = 5

/** A `<cwd>…</cwd>` tag inside any string of a parsed record, or null. */
function findTaggedCwd(value: unknown): string | null {
  if (typeof value === 'string') {
    const m = /<cwd>([^<]+)<\/cwd>/.exec(value)
    return m ? m[1].trim() : null
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findTaggedCwd(v)
      if (hit) return hit
    }
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const hit = findTaggedCwd(v)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Every date directory under `sessions`, newest first, as absolute paths.
 * `since` (ms epoch) prunes days that ended before it — a day is kept when
 * its local date is on or after that of `since`.
 */
function dayDirs(profileDir: string, since = 0): string[] {
  const root = join(profileDir, SESSIONS_SUBDIR)
  const floor = since ? localDate(new Date(since)) : ''
  const out: string[] = []
  for (const y of subdirs(root).sort().reverse()) {
    if (!/^\d{4}$/.test(y)) continue
    for (const m of subdirs(join(root, y)).sort().reverse()) {
      if (!/^\d{2}$/.test(m)) continue
      for (const d of subdirs(join(root, y, m)).sort().reverse()) {
        if (!/^\d{2}$/.test(d)) continue
        if (`${y}-${m}-${d}` < floor) continue
        out.push(join(root, y, m, d))
      }
    }
  }
  return out
}

function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The newest rollout file owned by `threadId`, or null when Codex no longer has one. */
export function codexRolloutPath(profileDir: string, threadId: string): string | null {
  const wanted = threadId.toLowerCase()
  for (const dir of dayDirs(profileDir)) {
    const hits = files(dir)
      .filter((f) => codexThreadIdFromFilename(f) === wanted)
      .sort()
    if (hits.length) return join(dir, hits[hits.length - 1])
  }
  return null
}

/**
 * The thread that started in `cwd` at or after `since`, ignoring ids other tabs
 * own. Among several (two tabs launched together in one worktree) the oldest
 * wins — the discovery for the tab launched first runs first.
 */
export function codexDiscoverThread(
  profileDir: string,
  cwd: string,
  since: number,
  taken: ReadonlySet<string>
): string | null {
  // A little slack: the file's mtime is the last write, but the clock that
  // stamped `since` and the one the filesystem uses need not agree exactly.
  const floor = since - 5_000
  const candidates: { id: string; mtime: number }[] = []
  for (const dir of dayDirs(profileDir, floor)) {
    for (const name of files(dir)) {
      const id = codexThreadIdFromFilename(name)
      if (!id || taken.has(id)) continue
      const path = join(dir, name)
      const mtime = mtimeMs(path)
      if (mtime < floor) continue
      const rolloutCwd = codexRolloutCwd(path)
      if (!rolloutCwd || !samePath(rolloutCwd, cwd)) continue
      candidates.push({ id, mtime })
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime)
  return candidates[0]?.id ?? null
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',
  // Used later to auto-suggest a provider per project; defined now, unused for now.
  detectFiles: ['AGENTS.md', '.codex'],
  // No --append-system-prompt-file equivalent: Codex reads its instructions from
  // AGENTS.md, so Orbital's go in the profile's global one (codex-instructions.ts).
  acceptsBriefingFile: false,

  sessions: {
    // Codex picks the thread id itself; it is read back from the rollout file.
    async mint(): Promise<null> {
      return null
    },
    async find({ profileDir }: SessionLookup, id: string): Promise<string | null> {
      return codexRolloutPath(profileDir, id)
    },
    async discover({ profileDir, cwd }: SessionLookup, since, taken): Promise<string | null> {
      return codexDiscoverThread(profileDir, cwd, since, taken)
    }
  },

  async resolveCommand(ctx: AgentContext): Promise<ResolvedCommand> {
    const { file, prefixArgs } = await resolveExecutable(ctx.execPath, 'codex')
    const args = [...prefixArgs]
    // `resume` is a subcommand, so it leads; a fresh session has no id to pass.
    if (ctx.session?.resume) args.push('resume', ctx.session.id)
    return { file, args }
  }
}
