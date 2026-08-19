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
import type { BigIntStats, FSWatcher } from 'node:fs'
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  open as fsOpen,
  rename as fsRename,
  stat as fsStat,
  realpath as fsRealpath,
  mkdir,
  readdir
} from 'node:fs/promises'
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path'
import { shell } from 'electron'
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
 * Path containment
 *
 * Everything below this line acts on a path the RENDERER supplied, and several
 * of the operations create, rename or bin real files. A relative path from the
 * file tree is data, not a promise: a compromised renderer (or a bug that lets
 * repo content reach one of these calls) must not be able to walk out of the
 * checkout and rewrite the user's home directory. `resolveInRepo` is the single
 * gate every renderer-supplied path goes through — the mutating operations
 * defined here, the read/write pair further down, and the OS hand-offs in
 * `ipc.ts` (open / reveal / open-in-terminal), which resolve through it rather
 * than being handed an absolute path to trust.
 * -------------------------------------------------------------------------- */

/**
 * Anything the OS would read as "ignore where you are, start from a root":
 * a leading separator (POSIX absolute, or a UNC share when doubled) or a
 * Windows drive prefix. The drive case is the subtle one — `C:foo` is drive-
 * RELATIVE, so `isAbsolute` says false and `resolve` would graft it under the
 * repo, while Windows itself would resolve it against that drive's current
 * directory. Rejecting the whole shape up front avoids reasoning about which
 * platform's rules the incoming string was written for.
 */
const ROOTED = /^(?:[a-zA-Z]:|[\\/])/

/**
 * Resolve a checkout-relative path against `repoPath`, throwing if the result
 * lands outside the checkout. Returns the absolute path.
 *
 * This is the LEXICAL half of the gate — it reasons about the string only, and
 * so cannot see a symlinked directory that points out of the tree. Mutating
 * callers pair it with `resolveInRepoReal` below, which resolves the path's
 * ancestors on disk. Read-only callers stop here — `resolvePath` (Copy Path and
 * the OS hand-offs, where a syscall per menu click to decide whether a path may
 * be *shown* buys nothing) and `readFile` / `readFileBase64` / `listDir`, whose
 * split from the writing side is argued where they are defined.
 *
 * Containment is decided by `relative()`, deliberately NOT by a string prefix
 * test: `C:\repo-evil` starts with `C:\repo` yet is a different tree entirely.
 * `relative()` also folds case on Windows, so `c:\repo\src` is correctly seen
 * as inside `C:\Repo` — a case-sensitive prefix test would reject it.
 *
 * An empty `relPath` resolves to the checkout root itself, which callers that
 * must not operate on the root (delete) reject separately.
 */
export function resolveInRepo(repoPath: string, relPath: string): string {
  if (ROOTED.test(relPath)) {
    throw new Error(`"${relPath}" is not a path inside the Worktree`)
  }
  const root = resolve(repoPath)
  const full = resolve(root, relPath)
  const rel = relative(root, full)
  // `..` alone, `../…`, or an absolute answer (a different drive) all mean the
  // resolved path is not under the root.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`"${relPath}" escapes the Worktree`)
  }
  return full
}

/**
 * Reject anything that isn't a single path segment. The renderer's New File /
 * New Folder / Rename fields collect a NAME, so a separator in one would
 * silently turn into a path — `resolveInRepo` would happily accept `a/b/c`
 * because it stays inside the repo, which is exactly the confusion we don't
 * want in a rename box. Control characters are refused because they produce
 * names the user can neither see nor select afterwards.
 */
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\\/\u0000-\u001f]/

/**
 * Characters Win32 refuses in a file name. `:` is the dangerous one and the
 * reason this is a check rather than a nicety: on NTFS `taken.ts:evil` doesn't
 * create a file at all, it attaches a hidden ALTERNATE DATA STREAM to the
 * existing `taken.ts`. The call reports success and hands back a path the
 * editor then opens, but the tree never lists it and nothing the user can see
 * accounts for the bytes.
 */
const WINDOWS_BAD_CHARS = /[<>:"|?*]/

/**
 * DOS device names, which Win32 still resolves ahead of the filesystem — with
 * or without an extension, so `CON.txt` and `CON.txt.bak` are as reserved as
 * `CON`. A file created under one of these is a one-way trip: Explorer, git and
 * `shell.trashItem` (which throws "Failed to parse path") all fail to address
 * it, so the user cannot delete what a single typo just made.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Validate one entry name from a New File / New Folder / Rename field.
 *
 * The Windows-specific rules below are enforced on EVERY platform, deliberately.
 * They are not a property of the machine running Orbital, they are a property
 * of the repository: a `CON.ts` or a `weird.ts.` committed from Linux cannot be
 * checked out on Windows at all, and the collaborator meets it as a broken
 * clone rather than as a name they can rename. Gating on `process.platform`
 * would let one half of a shared team create names the other half cannot use,
 * which is the worse failure. None of this is a containment concern —
 * `resolveInRepo` owns that — these are names that produce files the user, and
 * this app, cannot subsequently manage.
 */
export function checkEntryName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Enter a name')
  if (BAD_NAME.test(trimmed)) throw new Error('A name cannot contain path separators')
  if (trimmed === '.' || trimmed === '..') throw new Error(`"${trimmed}" is not a valid name`)
  if (WINDOWS_BAD_CHARS.test(trimmed)) {
    throw new Error('A name cannot contain any of < > : " | ? *')
  }
  if (WINDOWS_RESERVED.test(trimmed)) {
    // Name the stem, not the whole string: for `CON.txt` the extension is fine
    // and only the part before it has to change.
    const stem = trimmed.split('.')[0]
    throw new Error(`"${stem}" is a reserved device name on Windows — pick another name`)
  }
  // The trailing-space half is belt-and-braces, since `trim()` has already
  // removed one, but a trailing DOT survives trimming and is the shape seen in
  // the wild: `weird.ts.` is created as a second, literal file beside
  // `weird.ts` that then cannot be opened, renamed or binned by anything.
  if (/[. ]$/.test(trimmed)) {
    throw new Error('A name cannot end with a "." or a space')
  }
  return trimmed
}

/** Join a checkout-relative directory and a child name (`''` parent = repo root). */
function childOf(parentRel: string, name: string): string {
  return parentRel ? `${parentRel}/${name}` : name
}

/** Last path separator, whichever flavour the caller's string happens to use. */
function lastSep(p: string): number {
  return Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
}

/** The errno codes that genuinely mean "there is nothing at this path". */
function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  // ENOTDIR is the same answer arrived at differently: a path component turned
  // out to be a file, so the entry below it cannot exist either.
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * `stat` the entry at `full`, or `null` if there is nothing there.
 *
 * Catching not-found NARROWLY is the point. Treating any stat failure as
 * "nothing there" turns an EACCES/EPERM/EIO/ELOOP — "I could not tell" — into a
 * confident wrong answer. In `trashPath` that reads back to the user as "no
 * longer exists" for a file still sitting in the tree in front of them; in a
 * collision guard it is worse, because "nothing is in the way" is exactly the
 * licence to write over a file we could not see. Anything that isn't not-found
 * propagates and gets reported as itself.
 *
 * Stats are taken with `bigint` so the inode is exact; `renamePath` compares
 * ids to tell a re-spelling from a collision.
 */
async function statOrNull(full: string): Promise<BigIntStats | null> {
  try {
    return await fsStat(full, { bigint: true })
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/** Does something exist at `full`? See `statOrNull` for the error handling. */
async function pathExists(full: string): Promise<boolean> {
  return (await statOrNull(full)) !== null
}

/**
 * `realpath` of `full`'s PARENT chain, tolerating a target (or intermediate
 * directories) that doesn't exist yet — the normal case for New File / New
 * Folder / a rename's destination. Walks up until a real directory is found and
 * re-appends the not-yet-existing segments.
 */
async function realParentOf(full: string): Promise<string> {
  let dir = dirname(full)
  const missing: string[] = []
  for (;;) {
    try {
      return join(await fsRealpath(dir), ...missing)
    } catch (err) {
      if (!isNotFound(err)) throw err
      const parent = dirname(dir)
      // Reached the filesystem root without finding anything real; there are no
      // links left that could redirect us, so the lexical answer is the answer.
      if (parent === dir) return join(dir, ...missing)
      missing.unshift(basename(dir))
      dir = parent
    }
  }
}

/**
 * The containment gate for every operation that WRITES: lexical containment
 * first, then the same question asked of the real filesystem. Returns the
 * absolute (lexical) path, so callers still act through the path the user sees.
 *
 * Why the extra syscall. `resolveInRepo` compares strings, so `link/secret.txt`
 * passes it while `link` is a symlink or Windows junction pointing anywhere at
 * all. Git stores symlinks, so a repo the user merely *cloned* can carry one —
 * this is a checkout the app writes into, not input we vouched for.
 *
 * Two details keep it from rejecting legitimate paths:
 *
 *  - The repo root is resolved the SAME way as the target. Orbital's own
 *    worktrees live under `.orbital-worktrees`, and a checkout can sit behind a
 *    junction or a symlinked home; comparing a resolved target against an
 *    unresolved root would reject every path in such a checkout.
 *  - Only the ANCESTORS are resolved — the final segment is left alone. A
 *    symlink is itself a directory entry, and renaming or binning one is an
 *    ordinary in-repo edit that affects the link, not its target. Resolving the
 *    leaf too would refuse to let anyone tidy up a symlink they can see.
 *
 * What this deliberately still refuses: writing THROUGH a link that leaves the
 * checkout — including a pnpm-style `node_modules` entry linked to a global
 * store. Those files really are outside the worktree, and an editor tree that
 * silently edits the shared store on a misclick is the failure worth having.
 */
async function resolveInRepoReal(repoPath: string, relPath: string): Promise<string> {
  const full = resolveInRepo(repoPath, relPath)
  const root = resolve(repoPath)
  // The checkout root is trivially inside itself and has no ancestor worth
  // resolving. Callers that must not act on the root reject it by name.
  if (full === root) return full
  const realRoot = await fsRealpath(root)
  const real = join(await realParentOf(full), basename(full))
  const rel = relative(realRoot, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`"${relPath}" resolves outside the Worktree through a link`)
  }
  return full
}

/**
 * Create an empty file `name` inside `parentRel`; returns its checkout-relative
 * path. Opening with 'wx' is what makes this safe against clobbering — an
 * existing file fails with EEXIST instead of being truncated to nothing.
 */
async function createFile(repoPath: string, parentRel: string, name: string): Promise<string> {
  const relPath = childOf(parentRel, checkEntryName(name))
  const full = await resolveInRepoReal(repoPath, relPath)
  await mkdir(dirname(full), { recursive: true })
  try {
    const handle = await fsOpen(full, 'wx')
    await handle.close()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`"${relPath}" already exists`)
    }
    throw err
  }
  return relPath
}

/**
 * Create directory `name` inside `parentRel`; returns its checkout-relative
 * path. The parent chain is created recursively but the leaf is not, so an
 * existing directory reports a collision rather than silently succeeding.
 */
async function createDirectory(repoPath: string, parentRel: string, name: string): Promise<string> {
  const relPath = childOf(parentRel, checkEntryName(name))
  const full = await resolveInRepoReal(repoPath, relPath)
  await mkdir(dirname(full), { recursive: true })
  try {
    await mkdir(full)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`"${relPath}" already exists`)
    }
    throw err
  }
  return relPath
}

/**
 * Rename a file or directory in place (same parent), returning its new
 * checkout-relative path. Both ends are containment-checked: the source
 * because the renderer chose it, the target because it is derived from a
 * user-typed name.
 */
async function renamePath(repoPath: string, relPath: string, newName: string): Promise<string> {
  const name = checkEntryName(newName)
  const from = await resolveInRepoReal(repoPath, relPath)
  const cut = lastSep(relPath)
  const target = cut === -1 ? name : `${relPath.slice(0, cut)}/${name}`
  const to = await resolveInRepoReal(repoPath, target)
  if (to === from) return relPath // nothing typed but the existing name

  // Something is already at the destination — but "something" may be the very
  // file being renamed. `Foo.ts` -> `foo.ts` is one entry under two spellings
  // on a case-insensitive filesystem, and on macOS the same is true of two
  // Unicode normalisations of one name. Refusing those as collisions would
  // block a perfectly legal rename.
  //
  // Rather than guess from `process.platform` (the previous gate said Windows
  // only, which was wrong for the default macOS filesystem and for the
  // case-insensitive mounts that exist on Linux too), ask the filesystem which
  // entry each name denotes. Matching device + inode means one entry, whatever
  // the platform's rules happen to be — so `rename` is a re-spelling, not a
  // clobber, and we hand it to the OS.
  const dest = await statOrNull(to)
  if (dest !== null) {
    const src = await fsStat(from, { bigint: true })
    // 64-bit ids, so read them as BigInt: NTFS file ids overflow a JS number,
    // and a rounded id could collide two distinct files into "same entry" —
    // the one mistake here that loses data. A filesystem that reports no inode
    // at all (0n, e.g. some network shares) gets the safe answer: a collision.
    const sameEntry = src.ino !== 0n && src.ino === dest.ino && src.dev === dest.dev
    if (!sameEntry) throw new Error(`"${target}" already exists`)
  }

  await fsRename(from, to)
  return target
}

/**
 * Send a file or directory to the OS recycle bin / trash. Recoverable by
 * design — an editor tree is a place people misclick, and `unlink` there would
 * be an unrecoverable data loss with no undo anywhere in the app.
 */
async function trashPath(repoPath: string, relPath: string): Promise<void> {
  const full = await resolveInRepoReal(repoPath, relPath)
  if (full === resolve(repoPath)) throw new Error('The Worktree root cannot be deleted here')
  if (!(await pathExists(full))) throw new Error(`"${relPath}" no longer exists`)
  // Rejects with the OS error when the item can't be binned (e.g. a locked file).
  await shell.trashItem(full)
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

/* ----------------------------------------------------------------------------
 * Which gate the read/write pair uses, and why they differ
 *
 * All four functions below take a path the RENDERER chose, so all four are
 * containment-checked — before this they were bare `join(repoPath, relPath)`,
 * which let `../../evil.txt` land wherever it liked.
 *
 * `writeFile` uses `resolveInRepoReal`, the same gate as every other mutating
 * operation: writing THROUGH a symlink that leaves the checkout edits a file
 * that is not in the checkout, and a link is a directory entry a merely-cloned
 * repo can carry. Editing a pnpm-linked `node_modules` package in place —
 * silently patching the machine-wide store from the editor tree — is the
 * concrete failure this refuses, and it is refused consistently with
 * createFile / createDirectory / renamePath / trashPath.
 *
 * The three reads stop at the lexical `resolveInRepo`, deliberately:
 *
 *  - Cost. A read runs on every tree click, every lazy directory expand and
 *    every image in a markdown preview; a write runs when a human presses save.
 *    `resolveInRepoReal` walks the ancestor chain with `realpath`, so it is a
 *    per-path syscall burst on the hot path and a single one on the cold path.
 *  - What it would actually buy. A renderer cannot CREATE an escaping link —
 *    there is no symlink IPC, and every path that makes a directory entry is
 *    already gated — so the link would have to be committed in the repo the
 *    user chose to open. At that point the same bytes are readable from the
 *    terminal tab sitting next to the editor.
 *  - What it would cost in correctness. `listDir` exists to expand IGNORED
 *    directories, i.e. `node_modules` — where pnpm and npm both hand out
 *    symlinks into a store outside the checkout. Real-path containment would
 *    turn "expand node_modules" and "open the file I can see in the tree" into
 *    errors, for a read the user explicitly asked for.
 *
 * Reading through a link is the smaller exposure; writing through one is the
 * one that changes state outside the checkout. The split follows that.
 * -------------------------------------------------------------------------- */

/**
 * Immediate children of an ignored directory, read from disk (git knows nothing
 * about them). Everything under an ignored directory is itself ignored; child
 * dirs again come back without children, for another lazy expand.
 */
async function listDir(repoPath: string, relPath: string): Promise<FileNode[]> {
  const entries = await readdir(resolveInRepo(repoPath, relPath), { withFileTypes: true })
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
  return fsReadFile(resolveInRepo(repoPath, relPath), 'utf8')
}

/** Raw file bytes as base64 — lets the renderer display binary content (images). */
async function readFileBase64(repoPath: string, relPath: string): Promise<string> {
  const buf = await fsReadFile(resolveInRepo(repoPath, relPath))
  return buf.toString('base64')
}

async function writeFile(repoPath: string, relPath: string, content: string): Promise<void> {
  const full = await resolveInRepoReal(repoPath, relPath)
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
  resolveInRepo,
  createFile,
  createDirectory,
  renamePath,
  trashPath,
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
