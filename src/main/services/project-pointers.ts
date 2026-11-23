/**
 * The Orbital-managed repo list in a project's home repo.
 *
 * The home repo pattern keeps one-line pointers to sibling repos in the home
 * repo's AGENTS.md, so any agent started there (in Orbital or not, by you or a
 * teammate) knows where the other repos are. Orbital writes that list for a
 * project with a home repo, between two markers, and keeps it in step with the
 * project's membership. Only things that rarely change go in (names, relative
 * paths, remotes, which steering file to read), never branches or status, so
 * the file does not churn. The change is left uncommitted for the user.
 *
 * The rest of the file is never touched: the block is replaced in place,
 * appended after one blank line when it is new, and cut out (with that blank
 * line) when it is turned off. An unchanged block is not rewritten at all.
 *
 * Off switch: `Project.managedBlock`. Clearing the home or turning it off
 * removes the block from the home it was written to.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, Repo } from '@shared/types'
import { tables } from '../runtime'
import { logger } from './logger'
import { originUrl, relativePath, samePath, steeringFiles } from './project-map'

export const BLOCK_START = '<!-- orbital:repos:start -->'
export const BLOCK_END = '<!-- orbital:repos:end -->'

/** One sibling repo as the block lists it. */
export interface PointerEntry {
  name: string
  /** Path from the home repo, forward slashes (or absolute when there is no relative one). */
  path: string
  remote: string | null
  /** The steering file to point at (AGENTS.md, else CLAUDE.md), or null. */
  steering: string | null
}

/** The block's lines, markers included, without line endings. */
export function renderBlock(entries: PointerEntry[]): string[] {
  const lines = [
    BLOCK_START,
    '## Repos in this project',
    '',
    '<!-- Managed by Orbital: edits inside this block are overwritten. Turn it off per project in Orbital. -->',
    ''
  ]
  for (const e of entries) {
    let line = `- ${e.name}: ${e.path}.`
    if (e.remote) line += ` Clone from ${e.remote} if missing.`
    if (e.steering) line += ` Read its ${e.steering} before changing it.`
    lines.push(line)
  }
  lines.push(BLOCK_END)
  return lines
}

/** The line ending a file already uses (CRLF if it has any), LF for a new one. */
export function eolOf(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

/** Where the block sits in `content`, or null; `broken` when the end marker is missing. */
function findBlock(content: string): { start: number; end: number } | 'broken' | null {
  const start = content.indexOf(BLOCK_START)
  if (start === -1) return null
  const end = content.indexOf(BLOCK_END, start)
  if (end === -1) return 'broken'
  return { start, end: end + BLOCK_END.length }
}

/**
 * `content` with the block put in or refreshed. Returns `content` itself when
 * nothing changes, and null when the block is half there (a start marker with
 * no end): rewriting that would mean guessing where the user's text resumes.
 */
export function upsertBlock(content: string, blockLines: string[]): string | null {
  const eol = eolOf(content)
  const block = blockLines.join(eol)
  const at = findBlock(content)
  if (at === 'broken') return null
  if (at) return content.slice(0, at.start) + block + content.slice(at.end)
  if (content === '') return block + eol
  let prefix = content
  if (!prefix.endsWith('\n')) prefix += eol
  if (!/\r?\n\r?\n$/.test(prefix)) prefix += eol
  return prefix + block + eol
}

/**
 * `content` without the block: the markers, everything between them, the line
 * ending after the end marker, and one blank line before the start marker if
 * there is one (the one an append adds). Unchanged when there is no complete block.
 */
export function removeBlock(content: string): string {
  const at = findBlock(content)
  if (!at || at === 'broken') return content
  let { start, end } = at
  if (content.startsWith('\r\n', end)) end += 2
  else if (content.startsWith('\n', end)) end += 1
  // `…text<eol><eol><block>`: the second line ending is the blank line an append added.
  const blank = /\r?\n(\r?\n)$/.exec(content.slice(0, start))
  if (blank) start -= blank[1].length
  return content.slice(0, start) + content.slice(end)
}

/** Whether a CLAUDE.md does nothing but import AGENTS.md (`@AGENTS.md`). */
export function importsOnlyAgents(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length > 0 && lines.every((l) => /^@(\.\/)?AGENTS\.md$/i.test(l))
}

/** Read a file, '' when it does not exist. Other errors propagate. */
function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/** Write through a temp file, so a crash cannot leave the user's file half-written. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.orbital-${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/**
 * The file in `homePath` the block belongs in. One that already holds it
 * keeps it; otherwise AGENTS.md if it exists, else CLAUDE.md if it exists and
 * is more than an import of AGENTS.md, else a new AGENTS.md.
 */
export function targetFile(homePath: string): string {
  const agents = join(homePath, 'AGENTS.md')
  const claude = join(homePath, 'CLAUDE.md')
  const agentsText = existsSync(agents) ? readOrEmpty(agents) : null
  const claudeText = existsSync(claude) ? readOrEmpty(claude) : null
  if (agentsText?.includes(BLOCK_START)) return agents
  if (claudeText?.includes(BLOCK_START)) return claude
  if (agentsText !== null) return agents
  if (claudeText !== null && !importsOnlyAgents(claudeText)) return claude
  return agents
}

/** Put the block into the home repo, writing only when it changed. Returns the file written, or null. */
export function writePointers(homePath: string, entries: PointerEntry[]): string | null {
  const file = targetFile(homePath)
  const before = readOrEmpty(file)
  const after = upsertBlock(before, renderBlock(entries))
  if (after === null) {
    logger.warn('managed block in home repo has no end marker; leaving it alone', { file })
    return null
  }
  if (after === before) return null
  writeAtomic(file, after)
  return file
}

/** Take the block out of the home repo's AGENTS.md and CLAUDE.md. A file that only held the block goes. */
export function erasePointers(homePath: string): string[] {
  const changed: string[] = []
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = join(homePath, name)
    if (!existsSync(file)) continue
    const before = readOrEmpty(file)
    const after = removeBlock(before)
    if (after === before) continue
    if (after.trim() === '') rmSync(file, { force: true })
    else writeAtomic(file, after)
    changed.push(file)
  }
  return changed
}

/** The block's entries for a project: every member but the home, in project order. */
export async function pointerEntries(project: Project, repos: Repo[]): Promise<PointerEntry[]> {
  const home = repos.find((r) => r.id === project.homeRepoId)
  if (!home) return []
  const siblings = project.repoIds
    .map((id) => repos.find((r) => r.id === id))
    .filter((r): r is Repo => !!r && r.id !== home.id)
  const remotes = await Promise.all(siblings.map((r) => originUrl(r.repoPath).catch(() => null)))
  return siblings.map((r, i) => ({
    name: r.name,
    path: relativePath(home.repoPath, r.repoPath) ?? r.repoPath.replace(/\\/g, '/'),
    remote: remotes[i],
    steering: steeringFiles(r.repoPath)[0] ?? null
  }))
}

/* ---- keeping every project's block in step ------------------------------------ */

/** Home paths this instance wrote a block into, by project: where to remove it from later. */
const written = new Map<string, string>()

let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null
let again = false

/** How long a burst of project changes is let settle before the files are touched. */
const DEBOUNCE_MS = 250

/**
 * Bring every project's block in line with its state: written for a project
 * with a home and the flag on (and another repo to list), removed everywhere
 * else it was written. Called after any change to a project's membership,
 * home, root, names or flag, and once at boot. Never throws: a failure is
 * logged and the UI carries on.
 */
export function scheduleProjectPointers(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (running) {
      again = true
      return
    }
    running = syncProjectPointers()
      .catch((err: unknown) => logger.warn('managed block sync failed', { error: String(err) }))
      .finally(() => {
        running = null
        if (again) {
          again = false
          scheduleProjectPointers()
        }
      })
  }, DEBOUNCE_MS)
}

/** One pass of {@link scheduleProjectPointers}; exported for tests and boot. */
export async function syncProjectPointers(): Promise<void> {
  const projects = tables.projects.list()
  const repos = tables.repos.list()
  const want = new Map<string, { project: Project; homePath: string }>()
  for (const p of projects) {
    const home = p.homeRepoId ? repos.find((r) => r.id === p.homeRepoId) : undefined
    if (home && p.managedBlock && p.repoIds.length > 1) want.set(p.id, { project: p, homePath: home.repoPath })
  }
  // Out first, so a home that moved between projects ends up with the right block.
  const stale: string[] = []
  for (const [pid, homePath] of written) {
    const now = want.get(pid)
    if (!now || !samePath(now.homePath, homePath)) stale.push(homePath)
  }
  // A home with the flag off, or with nothing to list, may still hold a block
  // from an earlier session; removing an absent block writes nothing.
  for (const p of projects) {
    const home = p.homeRepoId ? repos.find((r) => r.id === p.homeRepoId) : undefined
    if (home && !want.has(p.id)) stale.push(home.repoPath)
  }
  for (const homePath of stale) {
    if ([...want.values()].some((w) => samePath(w.homePath, homePath))) continue
    try {
      const changed = erasePointers(homePath)
      if (changed.length) logger.info('removed managed repo block', { files: changed })
    } catch (err) {
      logger.warn('could not remove managed repo block', { home: homePath, error: String(err) })
    }
  }
  for (const pid of [...written.keys()]) if (!want.has(pid)) written.delete(pid)
  for (const [pid, { project, homePath }] of want) {
    try {
      const file = writePointers(homePath, await pointerEntries(project, repos))
      written.set(pid, homePath)
      if (file) logger.info('wrote managed repo block', { project: project.name, file })
    } catch (err) {
      logger.warn('could not write managed repo block', { project: project.name, home: homePath, error: String(err) })
    }
  }
}

/** Test hook: forget what this instance wrote. */
export function resetPointerMemory(): void {
  written.clear()
}
