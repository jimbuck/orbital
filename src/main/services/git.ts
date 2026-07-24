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
import { readFileSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import ignore from 'ignore'
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

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await capture(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return r.code === 0
}

/** Local branch names, most-recently-committed first. */
async function listBranches(repoPath: string): Promise<string[]> {
  const r = await capture(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    'refs/heads'
  ])
  if (r.code !== 0) return []
  return toLines(r.stdout).filter(Boolean)
}

/** Remote-tracking branch names (e.g. `origin/pr-42`), most-recently-committed first. */
async function listRemoteBranches(repoPath: string): Promise<string[]> {
  const r = await capture(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    'refs/remotes'
  ])
  if (r.code !== 0) return []
  // Drop the symbolic `origin/HEAD` pointer — it's not a checkout target.
  return toLines(r.stdout).filter((b) => b && !b.endsWith('/HEAD'))
}

/**
 * Concurrent `status` calls for the same checkout share one spawn: the git panel
 * and the file tree both refresh on the same state broadcast, and porcelain
 * status is the most expensive frequent git invocation.
 */
const statusInFlight = new Map<string, Promise<GitStatus>>()

function status(repoPath: string): Promise<GitStatus> {
  const pending = statusInFlight.get(repoPath)
  if (pending) return pending
  const p = statusUncached(repoPath).finally(() => statusInFlight.delete(repoPath))
  statusInFlight.set(repoPath, p)
  return p
}

async function statusUncached(repoPath: string): Promise<GitStatus> {
  // `-c core.quotePath=false` keeps non-ASCII/special filenames literal (not C-quoted),
  // so the paths we hand back can be staged/diffed/opened verbatim. `--no-optional-locks`
  // stops status from opportunistically rewriting `.git/index`, which the watcher watches
  // — otherwise every refresh would feed itself another change event.
  const out = await run(repoPath, [
    '--no-optional-locks',
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v2',
    '--branch'
  ])
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

async function unstageAll(repoPath: string): Promise<void> {
  await run(repoPath, ['reset', '-q', 'HEAD', '--'])
}

/**
 * Throw away a file's working-tree changes: tracked files are restored from the
 * index (any staged version survives), untracked files are deleted outright.
 */
async function discard(repoPath: string, path: string): Promise<void> {
  const tracked = await capture(repoPath, ['ls-files', '--error-unmatch', '--', path])
  if (tracked.code === 0) {
    await run(repoPath, ['restore', '--worktree', '--', path])
  } else {
    await run(repoPath, ['clean', '-fd', '--', path])
  }
}

/** Discard ALL unstaged changes and delete untracked files; staged changes survive. */
async function discardAll(repoPath: string): Promise<void> {
  // `restore` errors when nothing is tracked yet (fresh repo); still clean untracked.
  await capture(repoPath, ['restore', '--worktree', '--', '.'])
  await run(repoPath, ['clean', '-fd'])
}

async function commit(repoPath: string, message: string, amend?: boolean): Promise<void> {
  const args = ['commit', '-m', message]
  if (amend) args.push('--amend')
  await run(repoPath, args)
}

/** Full message of the HEAD commit ('' on an empty repo) — prefills the amend box. */
async function lastCommitMessage(repoPath: string): Promise<string> {
  const r = await capture(repoPath, ['log', '-1', '--pretty=%B'])
  return r.code === 0 ? r.stdout.trim() : ''
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

/** Switch the checkout to `branch`; `create` forks a new branch from HEAD first. */
async function checkout(repoPath: string, branch: string, create?: boolean): Promise<void> {
  const args = create ? ['switch', '-c', branch] : ['switch', branch]
  await run(repoPath, args)
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

/** Directories first, then alphabetical, recursively. */
function sortNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)
  )
  for (const n of nodes) if (n.children) sortNodes(n.children)
}

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

  // Gitignored entries, shown dimmed in the tree. `--directory` collapses a
  // fully-ignored directory (node_modules, dist, …) to a single `dir/` line
  // instead of enumerating its contents — those load lazily via listDir when
  // the user expands the directory.
  const ignoredOut = await run(repoPath, [
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory'
  ])
  const ignoredPaths = Array.from(new Set(toLines(ignoredOut).filter(Boolean)))

  // Badge changed files with their git state (prefer the working-tree state).
  const st = await status(repoPath)
  const stateByPath = new Map<string, GitFileState>()
  for (const f of st.staged) stateByPath.set(f.path, f.state)
  for (const f of st.unstaged) stateByPath.set(f.path, f.state)

  const root: FileNode[] = []
  const childrenOf = new Map<string, FileNode[]>([['', root]])
  const dirNodes = new Map<string, FileNode>()

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
    dirNodes.set(dirPath, node)
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

  for (const raw of ignoredPaths) {
    const isDir = raw.endsWith('/')
    const p = isDir ? raw.slice(0, -1) : raw
    if (isDir) {
      // git may list an ignored dir AND some of its contents (e.g. when the
      // dir is ignored via a .gitignore inside it), so build it through
      // ensureDir and just mark the node — never a duplicate sibling.
      ensureDir(p)
      dirNodes.get(p)!.ignored = true
      continue
    }
    const slash = p.lastIndexOf('/')
    const dir = slash === -1 ? '' : p.slice(0, slash)
    const name = slash === -1 ? p : p.slice(slash + 1)
    ensureDir(dir).push({ name, path: p, type: 'file', ignored: true })
  }

  // An ignored dir that stayed empty was collapsed by --directory: drop the
  // children array so the renderer knows to fetch its contents on expand.
  function pruneCollapsedDirs(nodes: FileNode[]): void {
    for (const n of nodes) {
      if (!n.children) continue
      pruneCollapsedDirs(n.children)
      if (n.ignored && n.children.length === 0) delete n.children
    }
  }
  pruneCollapsedDirs(root)

  sortNodes(root)

  return root
}

/**
 * Immediate children of an ignored directory, read from disk (git knows nothing
 * about them). Everything under an ignored directory is itself ignored; child
 * dirs again come back without children, for another lazy expand.
 */
async function listDir(repoPath: string, relPath: string): Promise<FileNode[]> {
  const entries = await readdir(join(repoPath, relPath), { withFileTypes: true })
  const nodes: FileNode[] = entries.map((e) => {
    const p = relPath ? `${relPath}/${e.name}` : e.name
    return e.isDirectory()
      ? { name: e.name, path: p, type: 'dir', ignored: true }
      : { name: e.name, path: p, type: 'file', ignored: true }
  })
  sortNodes(nodes)
  return nodes
}

async function readFile(repoPath: string, relPath: string): Promise<string> {
  return fsReadFile(join(repoPath, relPath), 'utf8')
}

/** Raw file bytes as base64 — lets the renderer display binary content (images). */
async function readFileBase64(repoPath: string, relPath: string): Promise<string> {
  const buf = await fsReadFile(join(repoPath, relPath))
  return buf.toString('base64')
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
  opts: { branch: string; worktreePath: string; baseRef?: string; newBranch?: boolean; track?: boolean }
): Promise<void> {
  if (opts.newBranch) {
    // Create a fresh branch forked from baseRef (or HEAD) in the new worktree.
    // `track` sets the baseRef (a remote-tracking branch) as upstream.
    const args = ['worktree', 'add']
    if (opts.track) args.push('--track')
    args.push('-b', opts.branch, opts.worktreePath, opts.baseRef || 'HEAD')
    await run(repoPath, args)
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

/**
 * Drop administrative entries for worktrees whose directories no longer exist
 * (`git worktree prune`). Run after we delete a worktree's folder ourselves so
 * git forgets the now-dangling entry and won't reject re-using the path later.
 */
async function worktreePrune(repoPath: string): Promise<void> {
  await run(repoPath, ['worktree', 'prune'])
}

/** One checkout as reported by `git worktree list --porcelain`. */
export interface GitWorktreeEntry {
  /** Absolute path of the checkout (git reports forward slashes on Windows). */
  path: string
  /** Checked-out branch name (e.g. `feature/x`), or null when HEAD is detached. */
  branch: string | null
  /** True for a bare repo entry (no working tree to show). */
  bare: boolean
  /** True when git flags the entry as prunable (its directory is gone). */
  prunable: boolean
}

/**
 * Every checkout of the repo `repoPath` belongs to, main checkout first —
 * the discovery source that lets ANY `git worktree add`, wherever it was run,
 * surface in Orbital.
 */
async function worktreeList(repoPath: string): Promise<GitWorktreeEntry[]> {
  const out = await run(repoPath, ['worktree', 'list', '--porcelain'])
  const entries: GitWorktreeEntry[] = []
  let cur: GitWorktreeEntry | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim(), branch: null, bare: false, prunable: false }
      entries.push(cur)
    } else if (!cur) {
      continue
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      cur.bare = true
    } else if (line.startsWith('prunable')) {
      cur.prunable = true
    }
    // `HEAD <sha>`, `detached`, `locked` — not needed; detached is branch: null.
  }
  return entries
}

/**
 * The repo's shared git dir (`.git` of the main checkout) — where the
 * `worktrees/` administrative directory lives. Works from any checkout.
 */
async function commonGitDir(repoPath: string): Promise<string> {
  const out = await run(repoPath, ['rev-parse', '--git-common-dir'])
  // Git may answer with a relative path (commonly just `.git`).
  return resolve(repoPath, out.trim())
}

export const git = {
  isRepo,
  currentBranch,
  branchExists,
  listBranches,
  listRemoteBranches,
  status,
  stage,
  unstage,
  stageAll,
  unstageAll,
  discard,
  discardAll,
  commit,
  lastCommitMessage,
  push,
  pull,
  fetch,
  checkout,
  diff,
  fileTree,
  listDir,
  readFile,
  readFileBase64,
  writeFile,
  worktreeAdd,
  worktreeRemove,
  worktreePrune,
  worktreeList,
  commonGitDir
}

/* ----------------------------------------------------------------------------
 * Filesystem watcher
 * -------------------------------------------------------------------------- */

/** Coalesce bursts of FS events into a single `change` emit. */
const DEBOUNCE_MS = 150

/**
 * Resolve a checkout's real git dir: `.git` is a directory at a repo root, but a
 * pointer file (`gitdir: <path>`) inside a linked worktree — whose HEAD/index
 * live under the main repo's `.git/worktrees/<name>/`.
 */
function resolveGitDir(repoPath: string): string {
  const dotGit = join(repoPath, '.git')
  try {
    if (statSync(dotGit).isFile()) {
      const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)
      if (m) return resolve(repoPath, m[1].trim())
    }
  } catch {
    // missing .git — fall through and watch the conventional path anyway.
  }
  return dotGit
}

/** Directory names whose subtrees never warrant a working-tree change event. */
const IGNORED_SEGMENTS = ['.git', 'node_modules', '.orbital-worktrees']

type Ignore = ReturnType<typeof ignore>

/**
 * Parse the checkout's root ignore sources into a matcher over repo-relative,
 * forward-slash paths. A linked worktree has no in-tree `.git/info/exclude`
 * (its `.git` is a pointer file), so that read simply misses; nested
 * (non-root) `.gitignore` files are likewise not consulted (accepted limits).
 */
function loadIgnoreRules(repoPath: string): Ignore {
  const ig = ignore()
  for (const rel of ['.gitignore', '.git/info/exclude']) {
    try {
      ig.add(readFileSync(join(repoPath, rel), 'utf8'))
    } catch {
      // Absent source — nothing to exclude from it.
    }
  }
  return ig
}

/** One checkout's live handles plus its (reloadable) ignore matcher. */
interface WatchEntry {
  readonly handles: FSWatcher[]
  ig: Ignore
}

/**
 * Watches one or more checkouts (repo roots and linked worktrees) and emits
 * `('change', repoPath)` (debounced) whenever the checkout's git HEAD/index or
 * working tree change.
 */
export class GitWatcher extends EventEmitter {
  private readonly entries = new Map<string, WatchEntry>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  watch(repoPath: string): void {
    if (this.entries.has(repoPath)) return

    const gitDir = resolveGitDir(repoPath)
    const entry: WatchEntry = { handles: [], ig: loadIgnoreRules(repoPath) }
    this.entries.set(repoPath, entry)

    // Working tree: a single recursive handle (ReadDirectoryChangesW on Windows)
    // surfaces files landing anywhere in the checkout, at any depth. Gitignored
    // build dirs are filtered per-event rather than watched, so their churn
    // never fires — consistent with the file tree, built from `ls-files
    // --exclude-standard`, which never shows ignored paths either.
    this.open(entry, repoPath, { recursive: true }, (filename) => {
      if (filename === null) {
        // fs.watch can omit the filename; treat as a generic change.
        this.schedule(repoPath)
        return
      }
      const rel = filename.replace(/\\/g, '/')
      if (rel.split('/').some((seg) => IGNORED_SEGMENTS.includes(seg))) return
      // A changed root `.gitignore` re-reads the rules before it can be applied.
      if (rel === '.gitignore') entry.ig = loadIgnoreRules(repoPath)
      try {
        if (entry.ig.ignores(rel)) return
      } catch {
        // `ignores` rejects paths it can't classify; keep the event.
      }
      this.schedule(repoPath)
    })

    // HEAD and index live in the git dir. For a linked worktree the git dir sits
    // OUTSIDE the checkout (under the main repo's `.git/worktrees/<name>/`), so
    // the recursive watch above never sees it — this non-recursive handle does.
    this.open(entry, gitDir, { recursive: false }, (filename) => {
      if (filename === 'HEAD' || filename === 'index') this.schedule(repoPath)
    })

    // HEAD is replaced by atomic rename, which the file watch can miss (seen on
    // Windows for `checkout -b`); the reflog is appended in place on every HEAD
    // move, so logs/HEAD is the reliable checkout/commit signal.
    this.open(entry, join(gitDir, 'logs'), { recursive: false }, (filename) => {
      if (filename === 'HEAD') this.schedule(repoPath)
    })
  }

  /** Open one fs.watch handle, guarding both setup and delivery so nothing throws out. */
  private open(
    entry: WatchEntry,
    target: string,
    opts: { recursive: boolean },
    onName: (filename: string | null) => void
  ): void {
    let handle: FSWatcher
    try {
      handle = watch(target, opts)
    } catch {
      // A missing target (e.g. no logs dir yet) must not abort the other handles.
      return
    }
    handle.on('change', (_event, filename) => {
      try {
        onName(filename == null ? null : filename.toString())
      } catch {
        // A malformed event must never crash the main process.
      }
    })
    handle.on('error', () => {
      // e.g. the watched root was deleted; never throw out of the watcher.
    })
    entry.handles.push(handle)
  }

  unwatch(repoPath: string): void {
    const entry = this.entries.get(repoPath)
    if (entry) {
      for (const handle of entry.handles) {
        try {
          handle.close()
        } catch {
          // Ignore close failures.
        }
      }
      this.entries.delete(repoPath)
    }
    const timer = this.timers.get(repoPath)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(repoPath)
    }
  }

  stop(): void {
    for (const repoPath of [...this.entries.keys()]) this.unwatch(repoPath)
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
