/**
 * Orbital — git service.
 *
 * A thin wrapper around the system `git` binary (no native bindings) used by the
 * main process for status, staging, diffing, file-tree and worktree management.
 * Every method shells out with `execFile` (cwd = the repo / worktree path) and
 * rethrows non-zero exits as an `Error` carrying git's stderr.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type {
  GitStatus,
  GitFileStatus,
  GitFileState,
  FileDiff,
  DiffLine,
  FileNode
} from '@shared/types'

const execFileP = promisify(execFile)

/** 64 MB — diffs / `ls-files` on large repos can dwarf the default 1 MB. */
const MAX_BUFFER = 64 * 1024 * 1024

/** Git understands `/dev/null` as the empty file even on Windows. */
const NULL_DEVICE = '/dev/null'

type ExecError = Error & {
  code?: number | string
  stdout?: string
  stderr?: string
}

interface GitResult {
  stdout: string
  stderr: string
  code: number
}

/** Run git, never throwing — the caller inspects `code` (used where non-zero is expected). */
async function capture(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true
    })
    return { stdout: stdout as string, stderr: stderr as string, code: 0 }
  } catch (err) {
    const e = err as ExecError
    const code = typeof e.code === 'number' ? e.code : 1
    const stdout = typeof e.stdout === 'string' ? e.stdout : ''
    let stderr = typeof e.stderr === 'string' ? e.stderr : ''
    if (!stderr && !stdout && e.message) stderr = e.message
    return { stdout, stderr, code }
  }
}

/** Run git, throwing `Error(stderr||stdout)` on any non-zero exit. */
async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr, code } = await capture(cwd, args)
  if (code !== 0) throw new Error(stderr || stdout || `git ${args.join(' ')} failed`)
  return stdout
}

/** Map a porcelain status code character to the contract's GitFileState. */
function mapState(code: string): GitFileState {
  switch (code) {
    case 'M':
    case 'T': // type change — surface as a modification
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'conflicted'
    case '?':
      return 'untracked'
    default:
      return 'modified'
  }
}

/** Split into lines, stripping trailing CR, dropping the trailing empty element. */
function toLines(out: string): string[] {
  return out.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

/* ----------------------------------------------------------------------------
 * Repository queries
 * -------------------------------------------------------------------------- */

async function isRepo(dir: string): Promise<boolean> {
  const { stdout, code } = await capture(dir, ['-C', dir, 'rev-parse', '--is-inside-work-tree'])
  return code === 0 && stdout.trim() === 'true'
}

async function currentBranch(repoPath: string): Promise<string> {
  const out = await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

async function defaultBranch(repoPath: string): Promise<string> {
  // Preferred: whatever origin/HEAD points at (e.g. "origin/main").
  const symbolic = await capture(repoPath, [
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD'
  ])
  if (symbolic.code === 0) {
    const ref = symbolic.stdout.trim()
    const slash = ref.indexOf('/')
    return slash === -1 ? ref : ref.slice(slash + 1)
  }
  // Fallbacks: a conventional local branch, then the current branch.
  for (const candidate of ['main', 'master']) {
    const r = await capture(repoPath, ['rev-parse', '--verify', '--quiet', candidate])
    if (r.code === 0) return candidate
  }
  return currentBranch(repoPath)
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await capture(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return r.code === 0
}

async function status(repoPath: string): Promise<GitStatus> {
  // `-c core.quotePath=false` keeps non-ASCII/special filenames literal (not C-quoted),
  // so the paths we hand back can be staged/diffed/opened verbatim.
  const out = await run(repoPath, ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch'])
  let branch = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const staged: GitFileStatus[] = []
  const unstaged: GitFileStatus[] = []

  for (const line of toLines(out)) {
    if (line === '') continue

    // Branch headers: "# branch.head main", "# branch.ab +1 -2", etc.
    if (line.startsWith('# ')) {
      const header = line.slice(2)
      if (header.startsWith('branch.head ')) {
        branch = header.slice('branch.head '.length).trim()
      } else if (header.startsWith('branch.upstream ')) {
        upstream = header.slice('branch.upstream '.length).trim()
      } else if (header.startsWith('branch.ab ')) {
        const m = header.slice('branch.ab '.length).match(/\+(-?\d+)\s+-(-?\d+)/)
        if (m) {
          ahead = parseInt(m[1], 10)
          behind = parseInt(m[2], 10)
        }
      }
      continue
    }

    const kind = line[0]
    const parts = line.split(' ')

    if (kind === '1' || kind === '2') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<orig>
      const xy = parts[1] ?? '..'
      const tail = kind === '1' ? parts.slice(8) : parts.slice(9)
      // For renames the path field is "<new>\t<orig>"; we report the new path.
      const path = tail.join(' ').split('\t')[0]
      if (xy[0] && xy[0] !== '.') {
        staged.push({ path, state: mapState(xy[0]), staged: true })
      }
      if (xy[1] && xy[1] !== '.') {
        unstaged.push({ path, state: mapState(xy[1]), staged: false })
      }
    } else if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const path = parts.slice(10).join(' ')
      unstaged.push({ path, state: 'conflicted', staged: false })
    } else if (kind === '?') {
      unstaged.push({ path: line.slice(2), state: 'untracked', staged: false })
    }
    // '!' (ignored) entries are dropped.
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    clean: staged.length === 0 && unstaged.length === 0,
    staged,
    unstaged
  }
}

/* ----------------------------------------------------------------------------
 * Index / commit / remote mutations
 * -------------------------------------------------------------------------- */

async function stage(repoPath: string, path: string): Promise<void> {
  await run(repoPath, ['add', '--', path])
}

async function unstage(repoPath: string, path: string): Promise<void> {
  await run(repoPath, ['reset', '-q', 'HEAD', '--', path])
}

async function stageAll(repoPath: string): Promise<void> {
  await run(repoPath, ['add', '-A'])
}

async function commit(repoPath: string, message: string): Promise<void> {
  await run(repoPath, ['commit', '-m', message])
}

async function push(repoPath: string): Promise<void> {
  // If the branch has no upstream, establish one against origin.
  const upstream = await capture(repoPath, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}'
  ])
  if (upstream.code !== 0) {
    await run(repoPath, ['push', '-u', 'origin', 'HEAD'])
  } else {
    await run(repoPath, ['push'])
  }
}

async function pull(repoPath: string): Promise<void> {
  await run(repoPath, ['pull'])
}

async function fetch(repoPath: string): Promise<void> {
  await run(repoPath, ['fetch'])
}

/* ----------------------------------------------------------------------------
 * Diff
 * -------------------------------------------------------------------------- */

/** Parse unified-diff text into a structured FileDiff, tracking old/new line numbers. */
function parseDiff(path: string, raw: string): FileDiff {
  const lines: DiffLine[] = []
  let additions = 0
  let deletions = 0
  let binary = false
  let oldNo = 0
  let newNo = 0
  let inHunk = false

  for (const text of toLines(raw)) {
    if (text === '') continue

    if (text.startsWith('Binary files') || text.startsWith('GIT binary patch')) {
      binary = true
      lines.push({ type: 'meta', oldNo: null, newNo: null, text })
      continue
    }

    if (text.startsWith('@@')) {
      const m = text.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldNo = parseInt(m[1], 10)
        newNo = parseInt(m[2], 10)
        inHunk = true
      }
      lines.push({ type: 'hunk', oldNo: null, newNo: null, text })
      continue
    }

    if (!inHunk) {
      // diff --git / index / mode / ---/+++ header lines.
      lines.push({ type: 'meta', oldNo: null, newNo: null, text })
      continue
    }

    const sign = text[0]
    if (sign === '+') {
      additions++
      lines.push({ type: 'add', oldNo: null, newNo, text: text.slice(1) })
      newNo++
    } else if (sign === '-') {
      deletions++
      lines.push({ type: 'del', oldNo, newNo: null, text: text.slice(1) })
      oldNo++
    } else if (sign === '\\') {
      // "\ No newline at end of file"
      lines.push({ type: 'meta', oldNo: null, newNo: null, text })
    } else {
      // Context line (leading space).
      lines.push({ type: 'context', oldNo, newNo, text: text.slice(1) })
      oldNo++
      newNo++
    }
  }

  return { path, additions, deletions, lines, binary }
}

async function diff(repoPath: string, path: string, staged: boolean): Promise<FileDiff> {
  if (staged) {
    const raw = await run(repoPath, ['diff', '--cached', '--unified=3', '--', path])
    return parseDiff(path, raw)
  }

  // Untracked files have no index entry, so a plain `git diff` is empty; diff
  // against /dev/null instead so the whole file renders as additions.
  const tracked = await capture(repoPath, ['ls-files', '--error-unmatch', '--', path])
  if (tracked.code !== 0) {
    const r = await capture(repoPath, [
      'diff',
      '--no-index',
      '--unified=3',
      '--',
      NULL_DEVICE,
      path
    ])
    // `--no-index` exits 1 when the files differ (the normal case here).
    if (r.code > 1) throw new Error(r.stderr || r.stdout || 'git diff failed')
    return parseDiff(path, r.stdout)
  }

  const raw = await run(repoPath, ['diff', '--unified=3', '--', path])
  return parseDiff(path, raw)
}

/* ----------------------------------------------------------------------------
 * File tree & file I/O
 * -------------------------------------------------------------------------- */

async function fileTree(repoPath: string): Promise<FileNode[]> {
  const out = await run(repoPath, [
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard'
  ])
  const paths = Array.from(new Set(toLines(out).filter(Boolean)))

  // Badge changed files with their git state (prefer the working-tree state).
  const st = await status(repoPath)
  const stateByPath = new Map<string, GitFileState>()
  for (const f of st.staged) stateByPath.set(f.path, f.state)
  for (const f of st.unstaged) stateByPath.set(f.path, f.state)

  const root: FileNode[] = []
  const childrenOf = new Map<string, FileNode[]>([['', root]])

  // Create (and cache) the children array for a directory, building ancestors.
  function ensureDir(dirPath: string): FileNode[] {
    const existing = childrenOf.get(dirPath)
    if (existing) return existing
    const slash = dirPath.lastIndexOf('/')
    const parent = slash === -1 ? '' : dirPath.slice(0, slash)
    const name = slash === -1 ? dirPath : dirPath.slice(slash + 1)
    const node: FileNode = { name, path: dirPath, type: 'dir', children: [] }
    ensureDir(parent).push(node)
    childrenOf.set(dirPath, node.children!)
    return node.children!
  }

  for (const p of paths) {
    const slash = p.lastIndexOf('/')
    const dir = slash === -1 ? '' : p.slice(0, slash)
    const name = slash === -1 ? p : p.slice(slash + 1)
    const node: FileNode = { name, path: p, type: 'file' }
    const state = stateByPath.get(p)
    if (state) node.gitState = state
    ensureDir(dir).push(node)
  }

  // Directories first, then alphabetical, recursively.
  function sortNodes(nodes: FileNode[]): void {
    nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)
    )
    for (const n of nodes) if (n.children) sortNodes(n.children)
  }
  sortNodes(root)

  return root
}

async function readFile(repoPath: string, relPath: string): Promise<string> {
  return fsReadFile(join(repoPath, relPath), 'utf8')
}

async function writeFile(repoPath: string, relPath: string, content: string): Promise<void> {
  const full = join(repoPath, relPath)
  await mkdir(dirname(full), { recursive: true })
  await fsWriteFile(full, content, 'utf8')
}

/* ----------------------------------------------------------------------------
 * Worktrees
 * -------------------------------------------------------------------------- */

async function worktreeAdd(
  repoPath: string,
  opts: { branch: string; worktreePath: string; baseRef?: string; newBranch?: boolean }
): Promise<void> {
  if (opts.newBranch) {
    // Create a fresh branch forked from baseRef (or HEAD) in the new worktree.
    await run(repoPath, [
      'worktree',
      'add',
      '-b',
      opts.branch,
      opts.worktreePath,
      opts.baseRef || 'HEAD'
    ])
  } else {
    // Check out an existing branch into the new worktree.
    await run(repoPath, ['worktree', 'add', opts.worktreePath, opts.branch])
  }
}

async function worktreeRemove(
  repoPath: string,
  worktreePath: string,
  force?: boolean
): Promise<void> {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(worktreePath)
  await run(repoPath, args)
}

async function worktreeList(repoPath: string): Promise<{ path: string; branch: string }[]> {
  const out = await run(repoPath, ['worktree', 'list', '--porcelain'])
  const result: { path: string; branch: string }[] = []
  let current: { path?: string; branch?: string } = {}

  const flush = (): void => {
    if (current.path) result.push({ path: current.path, branch: current.branch ?? '' })
    current = {}
  }

  for (const line of toLines(out)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length)
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (line === 'detached') {
      current.branch = '(detached)'
    } else if (line === 'bare') {
      current.branch = '(bare)'
    }
  }
  flush()

  return result
}

export const git = {
  isRepo,
  currentBranch,
  defaultBranch,
  branchExists,
  status,
  stage,
  unstage,
  stageAll,
  commit,
  push,
  pull,
  fetch,
  diff,
  fileTree,
  readFile,
  writeFile,
  worktreeAdd,
  worktreeRemove,
  worktreeList
}

/* ----------------------------------------------------------------------------
 * Filesystem watcher
 * -------------------------------------------------------------------------- */

/** Coalesce bursts of FS events into a single `change` emit. */
const DEBOUNCE_MS = 150
/** Shallow recursion: HEAD/index already capture staging & commit/checkout. */
const WORKTREE_DEPTH = 2

/**
 * Watches one or more repositories and emits `('change', repoPath)` (debounced)
 * whenever `.git/HEAD`, `.git/index`, or the shallow working tree change.
 */
export class GitWatcher extends EventEmitter {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  watch(repoPath: string): void {
    if (this.watchers.has(repoPath)) return

    const gitDir = join(repoPath, '.git').replace(/\\/g, '/')
    const headPath = `${gitDir}/HEAD`
    const indexPath = `${gitDir}/index`

    const watcher = chokidar.watch([headPath, indexPath, repoPath], {
      ignoreInitial: true,
      depth: WORKTREE_DEPTH,
      ignored: (raw: string) => {
        const p = raw.replace(/\\/g, '/')
        if (p.includes('/node_modules/') || p.endsWith('/node_modules')) return true
        // Inside .git: allow only HEAD and index, drop the rest.
        if (p === gitDir || p.startsWith(`${gitDir}/`)) {
          return p !== gitDir && p !== headPath && p !== indexPath
        }
        return false
      }
    })

    watcher.on('all', () => this.schedule(repoPath))
    this.watchers.set(repoPath, watcher)
  }

  unwatch(repoPath: string): void {
    const watcher = this.watchers.get(repoPath)
    if (watcher) {
      void watcher.close()
      this.watchers.delete(repoPath)
    }
    const timer = this.timers.get(repoPath)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(repoPath)
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) void watcher.close()
    this.watchers.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private schedule(repoPath: string): void {
    const existing = this.timers.get(repoPath)
    if (existing) clearTimeout(existing)
    this.timers.set(
      repoPath,
      setTimeout(() => {
        this.timers.delete(repoPath)
        this.emit('change', repoPath)
      }, DEBOUNCE_MS)
    )
  }
}
