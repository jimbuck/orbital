import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// `vi.mock` is hoisted above every import, so the spy it installs has to be
// hoisted with it.
const hoisted = vi.hoisted(() => ({ trashItem: vi.fn(async (): Promise<void> => {}) }))
const trashItem = hoisted.trashItem

// git.ts reaches Electron's shell for `trashItem` (the delete path).
vi.mock('electron', () => ({ shell: { trashItem: hoisted.trashItem } }))

import { checkEntryName, git, resolveInRepo } from './git'

const onWindows = process.platform === 'win32'

/**
 * A link to a directory. On Windows a real symlink needs elevation but a
 * JUNCTION does not, and Node resolves both through `realpath` — which is the
 * behaviour under test, so a junction stands in perfectly.
 */
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, onWindows ? 'junction' : 'dir')
}

/**
 * A pair of links pointing at each other, so `stat` on either fails with ELOOP
 * while the entry itself plainly exists. Returns the path to the first.
 *
 * This is how the "not every stat failure means not-found" tests get a REAL
 * errno instead of a mocked one. Faking it at the module level isn't available
 * here — vitest applies a `node:fs/promises` mock to the test file's own import
 * but not to git.ts's — and a genuine EACCES needs ACL surgery on Windows or a
 * non-root runner on POSIX. A link cycle is portable, needs no elevation, and
 * is the honest article.
 */
function linkCycle(dir: string, name: string): string {
  const a = join(dir, name)
  const b = join(dir, `${name}-partner`)
  linkDir(b, a)
  linkDir(a, b)
  return a
}

/* ---- Path containment ----------------------------------------------------
 *
 * `resolveInRepo` is the only thing standing between a renderer-supplied
 * string and `rename`/`trashItem` on the user's disk, so it gets the closest
 * scrutiny in this file.
 * ------------------------------------------------------------------------- */

describe('resolveInRepo', () => {
  const root = resolve('/repo')

  it('resolves a nested relative path inside the checkout', () => {
    expect(resolveInRepo(root, 'src/renderer/index.ts')).toBe(join(root, 'src', 'renderer', 'index.ts'))
  })

  it('normalises harmless traversal that stays inside', () => {
    expect(resolveInRepo(root, 'src/../package.json')).toBe(join(root, 'package.json'))
  })

  it('resolves an empty path to the checkout root itself', () => {
    // New File… at the top level passes '' as its parent directory.
    expect(resolveInRepo(root, '')).toBe(root)
  })

  it('rejects a bare parent reference', () => {
    expect(() => resolveInRepo(root, '..')).toThrow(/escapes/)
  })

  it('rejects traversal out of the checkout', () => {
    expect(() => resolveInRepo(root, '../../.ssh/id_rsa')).toThrow(/escapes/)
    expect(() => resolveInRepo(root, 'src/../../outside.txt')).toThrow(/escapes/)
  })

  it('rejects a sibling directory whose path merely starts with the checkout path', () => {
    // The near miss a naive prefix check waves through: `C:\repo-evil` (or
    // `/repo-evil`) has `C:\repo` as a string prefix but is a different tree.
    const escaped = resolve(root, '../repo-evil/secret.txt')
    expect(escaped.startsWith(root)).toBe(true) // …which is why we don't test it that way
    expect(() => resolveInRepo(root, '../repo-evil/secret.txt')).toThrow(/escapes/)
  })

  it('rejects rooted paths of every flavour', () => {
    expect(() => resolveInRepo(root, '/etc/passwd')).toThrow(/not a path inside/)
    expect(() => resolveInRepo(root, '\\Windows\\System32')).toThrow(/not a path inside/)
    expect(() => resolveInRepo(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts')).toThrow(/not a path inside/)
    expect(() => resolveInRepo(root, '\\\\server\\share\\file')).toThrow(/not a path inside/)
  })

  it('rejects a drive-relative path, which `isAbsolute` alone would let through', () => {
    // `C:foo` means "foo, relative to C:'s current directory" — not a child of
    // the repo, however innocent it looks after a naive join.
    expect(() => resolveInRepo(root, 'D:evil.txt')).toThrow(/not a path inside/)
  })

  it.skipIf(!onWindows)('treats the root case-insensitively on Windows', () => {
    // A checkout recorded as C:\Repo must still accept c:\repo\... children.
    expect(resolveInRepo('C:\\Repo', 'src/a.ts')).toBe('C:\\Repo\\src\\a.ts')
    expect(() => resolveInRepo('C:\\Repo', '../Repo-evil/x')).toThrow(/escapes/)
  })
})

describe('checkEntryName', () => {
  it('accepts and trims an ordinary name', () => {
    expect(checkEntryName('  notes.md  ')).toBe('notes.md')
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(() => checkEntryName('')).toThrow(/Enter a name/)
    expect(() => checkEntryName('   ')).toThrow(/Enter a name/)
  })

  it('rejects path separators — the field collects a name, not a path', () => {
    expect(() => checkEntryName('src/a.ts')).toThrow(/path separators/)
    expect(() => checkEntryName('src\\a.ts')).toThrow(/path separators/)
  })

  it('rejects the directory self/parent references', () => {
    expect(() => checkEntryName('.')).toThrow(/not a valid name/)
    expect(() => checkEntryName('..')).toThrow(/not a valid name/)
  })

  /* The Windows-shaped rules are asserted WITHOUT `skipIf(!onWindows)` on
   * purpose, because the implementation isn't platform-gated: a name created
   * from Linux ends up in a repository someone else clones on Windows, where
   * these shapes cannot be checked out at all. */

  it('rejects DOS device names, extension or not', () => {
    for (const name of ['CON', 'con', 'NUL', 'aux', 'PRN', 'COM1', 'lpt9', 'CON.txt', 'con.txt.bak']) {
      expect(() => checkEntryName(name)).toThrow(/reserved device name/)
    }
  })

  it('leaves names that merely start like a device name alone', () => {
    // Only the exact stems are reserved; `console.ts` is an ordinary file and
    // an over-eager prefix test would be maddening in a JS repo.
    expect(checkEntryName('console.ts')).toBe('console.ts')
    expect(checkEntryName('com10')).toBe('com10')
    expect(checkEntryName('lpt0.ts')).toBe('lpt0.ts')
    expect(checkEntryName('connection')).toBe('connection')
  })

  it('rejects a colon, which would attach a hidden stream to an existing file', () => {
    expect(() => checkEntryName('taken.ts:evil')).toThrow(/cannot contain any of/)
  })

  it('rejects the other characters Win32 refuses in a name', () => {
    for (const name of ['a<b', 'a>b', 'a|b', 'a?b', 'a*b', 'a"b']) {
      expect(() => checkEntryName(name)).toThrow(/cannot contain any of/)
    }
  })

  it('rejects a trailing dot, which creates a file nothing can address', () => {
    // `weird.ts.` is a SECOND, literal file beside `weird.ts` that Explorer,
    // git and `shell.trashItem` all fail to open.
    expect(() => checkEntryName('weird.ts.')).toThrow(/cannot end with/)
    expect(() => checkEntryName('folder.')).toThrow(/cannot end with/)
  })

  it('still accepts a leading dot and a trailing space', () => {
    // A dotfile is normal; a trailing space is simply trimmed off, as it is for
    // every other name typed into the field.
    expect(checkEntryName('.gitignore')).toBe('.gitignore')
    expect(checkEntryName('weird.ts ')).toBe('weird.ts')
  })
})

/* ---- Mutating operations ------------------------------------------------- */

let repo = ''
let outside = ''

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orbital-git-'))
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'existing.ts'), 'export const a = 1\n')
  // A separate tree standing in for "anywhere that isn't the checkout".
  outside = mkdtempSync(join(tmpdir(), 'orbital-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'do not touch\n')
})
afterEach(() => {
  trashItem.mockClear()
  rmSync(repo, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  // The near-miss sibling some containment tests plant beside the checkout.
  rmSync(`${repo}-evil`, { recursive: true, force: true })
})

/**
 * A tree whose path is the checkout's path plus a suffix — `C:\repo` next to
 * `C:\repo-evil`. Returns its absolute path; `${repo}-evil` is reachable from
 * inside the checkout as `../<basename>-evil`, which is how the tests aim at it.
 */
function siblingTree(): string {
  const dir = `${repo}-evil`
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'secret.txt'), 'sibling secret\n')
  return dir
}

/** `../<name>-evil/...` — the sibling above, spelled the way the renderer would. */
function siblingRel(child: string): string {
  return `../${repo.split(/[\\/]/).pop()}-evil/${child}`
}

describe('git.createFile', () => {
  it('creates an empty file and returns its checkout-relative path', async () => {
    expect(await git.createFile(repo, 'src', 'fresh.ts')).toBe('src/fresh.ts')
    expect(readFileSync(join(repo, 'src', 'fresh.ts'), 'utf8')).toBe('')
  })

  it('creates at the checkout root when the parent is empty', async () => {
    expect(await git.createFile(repo, '', 'root.txt')).toBe('root.txt')
  })

  it('refuses to clobber an existing file', async () => {
    await expect(git.createFile(repo, 'src', 'existing.ts')).rejects.toThrow(/already exists/)
    // The original content survived — the whole point of opening with 'wx'.
    expect(readFileSync(join(repo, 'src', 'existing.ts'), 'utf8')).toContain('export const a')
  })

  it('refuses a name that is really a path', async () => {
    await expect(git.createFile(repo, 'src', '../../escape.txt')).rejects.toThrow(/path separators/)
  })

  it('refuses a name Windows cannot represent, without touching the disk', async () => {
    // Observed live before the guard existed: `existing.ts:evil` succeeded and
    // attached a hidden NTFS alternate data stream to the tracked file — the
    // returned path was auto-opened in the editor and never listed in the tree.
    await expect(git.createFile(repo, 'src', 'existing.ts:evil')).rejects.toThrow(/cannot contain any of/)
    await expect(git.createFile(repo, 'src', 'CON')).rejects.toThrow(/reserved device name/)
    expect(readdirSync(join(repo, 'src'))).toEqual(['existing.ts'])
  })

  it('refuses a parent directory outside the checkout', async () => {
    await expect(git.createFile(repo, '../elsewhere', 'x.txt')).rejects.toThrow(/escapes/)
  })
})

describe('git.createDirectory', () => {
  it('creates the directory and returns its relative path', async () => {
    expect(await git.createDirectory(repo, 'src', 'components')).toBe('src/components')
    expect(existsSync(join(repo, 'src', 'components'))).toBe(true)
  })

  it('reports a collision instead of silently succeeding', async () => {
    await git.createDirectory(repo, 'src', 'components')
    await expect(git.createDirectory(repo, 'src', 'components')).rejects.toThrow(/already exists/)
  })
})

describe('git.renamePath', () => {
  it('renames in place and returns the new relative path', async () => {
    expect(await git.renamePath(repo, 'src/existing.ts', 'renamed.ts')).toBe('src/renamed.ts')
    expect(existsSync(join(repo, 'src', 'existing.ts'))).toBe(false)
    expect(existsSync(join(repo, 'src', 'renamed.ts'))).toBe(true)
  })

  it('refuses to overwrite an existing sibling', async () => {
    writeFileSync(join(repo, 'src', 'taken.ts'), 'x')
    await expect(git.renamePath(repo, 'src/existing.ts', 'taken.ts')).rejects.toThrow(/already exists/)
    expect(readFileSync(join(repo, 'src', 'taken.ts'), 'utf8')).toBe('x')
  })

  it('refuses a new name containing a separator', async () => {
    await expect(git.renamePath(repo, 'src/existing.ts', '../escaped.ts')).rejects.toThrow(/path separators/)
  })

  it('refuses a source path outside the checkout', async () => {
    await expect(git.renamePath(repo, '../outside.ts', 'inside.ts')).rejects.toThrow(/escapes/)
  })

  it('allows a case-only rename instead of calling it a collision', async () => {
    // On a case-insensitive filesystem (Windows, default macOS) `case.ts` and
    // `Case.ts` are ONE entry, so the destination "already exists" — as itself.
    // The device+inode comparison sees that; the old `platform === 'win32'`
    // gate did not, and wrongly refused this on macOS. On a case-SENSITIVE
    // filesystem the destination simply doesn't exist, so this passes there too
    // and the assertions below hold either way.
    writeFileSync(join(repo, 'src', 'Case.ts'), 'body')
    expect(await git.renamePath(repo, 'src/Case.ts', 'case.ts')).toBe('src/case.ts')

    const names = readdirSync(join(repo, 'src'))
    expect(names).toContain('case.ts')
    expect(names).not.toContain('Case.ts')
    expect(readFileSync(join(repo, 'src', 'case.ts'), 'utf8')).toBe('body')
  })

  it('surfaces a non-not-found stat error instead of skipping the collision guard', async () => {
    // The regression that matters. Something IS at `src/taken`, but `stat` can
    // only answer ELOOP. Treating any failure as "nothing there" would optimise
    // "I could not tell" into "nothing is in the way" and rename over it.
    linkCycle(join(repo, 'src'), 'taken')

    await expect(git.renamePath(repo, 'src/existing.ts', 'taken')).rejects.toThrow(/ELOOP/)
    expect(existsSync(join(repo, 'src', 'existing.ts'))).toBe(true)
  })
})

describe('git.trashPath', () => {
  it('bins an entry inside the checkout', async () => {
    await git.trashPath(repo, 'src/existing.ts')
    expect(trashItem).toHaveBeenCalledWith(join(repo, 'src', 'existing.ts'))
  })

  it('refuses to bin the checkout root', async () => {
    await expect(git.trashPath(repo, '')).rejects.toThrow(/root cannot be deleted/)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('reports a non-not-found stat error as itself, not as "no longer exists"', async () => {
    // An entry `stat` cannot resolve is a problem the user can act on. Calling
    // it "no longer exists" sends them looking for the wrong thing — and the
    // entry is still sitting there in the tree, contradicting the message.
    linkCycle(repo, 'knot')

    const err = await git.trashPath(repo, 'knot').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/ELOOP/)
    expect((err as Error).message).not.toMatch(/no longer exists/)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('still reports a genuinely missing entry as gone', async () => {
    await expect(git.trashPath(repo, 'src/never-was.ts')).rejects.toThrow(/no longer exists/)
    expect(trashItem).not.toHaveBeenCalled()
  })
})

/* ---- Read / write containment --------------------------------------------
 *
 * These four were bare `join(repoPath, relPath)` until the guard was retrofitted
 * onto them, so `writeFile(repo, '../../evil.txt', …)` planted a file two levels
 * above the checkout and `readFile` read whatever it was pointed at. They are
 * reachable straight from the renderer over IPC, which is what made it a live
 * hole rather than a latent one.
 *
 * Each gets the same three questions: does traversal out get refused, does an
 * ordinary nested path still work, and is the sibling near-miss (`repo` vs
 * `repo-evil`) caught — the case a prefix comparison waves through.
 * ------------------------------------------------------------------------- */

describe('git.readFile', () => {
  it('reads a nested file inside the checkout', async () => {
    expect(await git.readFile(repo, 'src/existing.ts')).toBe('export const a = 1\n')
  })

  it('normalises harmless traversal that stays inside', async () => {
    expect(await git.readFile(repo, 'src/../src/existing.ts')).toBe('export const a = 1\n')
  })

  it('refuses to read out of the checkout', async () => {
    await expect(git.readFile(repo, '../../evil.txt')).rejects.toThrow(/escapes/)
    await expect(git.readFile(repo, 'src/../../outside.txt')).rejects.toThrow(/escapes/)
  })

  it('refuses the sibling tree whose path merely starts with the checkout path', async () => {
    const sibling = siblingTree()
    await expect(git.readFile(repo, siblingRel('secret.txt'))).rejects.toThrow(/escapes/)
    // The file really is there and really is readable — the guard is what stopped it.
    expect(readFileSync(join(sibling, 'secret.txt'), 'utf8')).toBe('sibling secret\n')
  })

  /*
   * `orbital tab new editor <path>` puts its argument straight into
   * `tab.config.filePath`, and the editor tab hands that to readFile unchanged
   * — so the CLI is a second, un-vetted way into this function and the reason
   * the guard was deferred here in the first place. Every spelling the CLI can
   * actually deliver a file with still works.
   */
  it('still reads the path shapes the CLI open-editor argument delivers', async () => {
    expect(await git.readFile(repo, 'src/existing.ts')).toBe('export const a = 1\n')
    expect(await git.readFile(repo, './src/existing.ts')).toBe('export const a = 1\n')
  })

  it.skipIf(!onWindows)('reads a backslash-spelled relative path from the CLI', async () => {
    // A Windows shell completes paths with backslashes, so this is what a
    // tab-completed `orbital tab new editor src\existing.ts` sends.
    expect(await git.readFile(repo, 'src\\existing.ts')).toBe('export const a = 1\n')
  })

  it('refuses an absolute path with a message, where it used to fail with an errno', async () => {
    // Not a behaviour change worth preserving: `join('C:/repo', 'C:/other/x')`
    // produced `C:\repo\C:\other\x`, which no filesystem opens, so an absolute
    // path has never once succeeded through this call. What changes is that the
    // refusal now says why instead of surfacing ENOENT.
    await expect(git.readFile(repo, join(repo, 'src', 'existing.ts'))).rejects.toThrow(
      /not a path inside/
    )
    await expect(git.readFile(repo, '/etc/passwd')).rejects.toThrow(/not a path inside/)
  })
})

describe('git.readFileBase64', () => {
  it('reads a nested file inside the checkout', async () => {
    const b64 = await git.readFileBase64(repo, 'src/existing.ts')
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('export const a = 1\n')
  })

  it('refuses to read out of the checkout', async () => {
    // The markdown preview reaches this one with paths derived from REPO
    // CONTENT (an image src), so a `../../` in a committed file lands here.
    await expect(git.readFileBase64(repo, '../../../.ssh/id_rsa')).rejects.toThrow(/escapes/)
  })

  it('refuses the sibling near-miss', async () => {
    siblingTree()
    await expect(git.readFileBase64(repo, siblingRel('secret.txt'))).rejects.toThrow(/escapes/)
  })
})

describe('git.writeFile', () => {
  it('writes a nested file inside the checkout, creating parents', async () => {
    await git.writeFile(repo, 'src/deep/nested/new.ts', 'ok\n')
    expect(readFileSync(join(repo, 'src', 'deep', 'nested', 'new.ts'), 'utf8')).toBe('ok\n')
  })

  it('refuses to write out of the checkout, leaving nothing behind', async () => {
    await expect(git.writeFile(repo, '../../evil.txt', 'pwned')).rejects.toThrow(/escapes/)
    expect(existsSync(resolve(repo, '..', '..', 'evil.txt'))).toBe(false)
    await expect(git.writeFile(repo, join(outside, 'secret.txt'), 'pwned')).rejects.toThrow(
      /not a path inside/
    )
    // The parent directories are created by writeFile, so a guard that ran too
    // late would still leave a trail outside the checkout. It doesn't.
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('do not touch\n')
  })

  it('refuses the sibling near-miss without touching it', async () => {
    const sibling = siblingTree()
    await expect(git.writeFile(repo, siblingRel('secret.txt'), 'pwned')).rejects.toThrow(/escapes/)
    expect(readFileSync(join(sibling, 'secret.txt'), 'utf8')).toBe('sibling secret\n')
  })

  it('refuses to CREATE a file under a name Windows cannot manage', async () => {
    // The same class createFile refuses: a literal CON/NUL/COM1 in the repo is
    // a one-way trip — nothing can delete it afterwards.
    await expect(git.writeFile(repo, 'src/CON', 'x')).rejects.toThrow(/reserved device name/)
    await expect(git.writeFile(repo, 'src/NUL.txt', 'x')).rejects.toThrow(/reserved device name/)
    await expect(git.writeFile(repo, 'src/trailing.', 'x')).rejects.toThrow(/cannot end with/)
    await expect(git.writeFile(repo, 'src/bad:name', 'x')).rejects.toThrow(/cannot contain/)
    expect(readdirSync(join(repo, 'src'))).toEqual(['existing.ts'])
  })

  it('still saves an existing file whose name would fail the create check', async () => {
    // Saving is not creating. A checkout can carry a name that checkEntryName
    // would refuse in a New File box (committed from a platform that allows
    // it); the editor opened it, so the editor can save it.
    if (onWindows) return // Win32 cannot create such a name to begin with
    writeFileSync(join(repo, 'src', 'odd:name'), 'before')
    await git.writeFile(repo, 'src/odd:name', 'after')
    expect(readFileSync(join(repo, 'src', 'odd:name'), 'utf8')).toBe('after')
  })
})

describe('git.listDir', () => {
  it('lists a directory inside the checkout', async () => {
    expect((await git.listDir(repo, 'src')).map((n) => n.path)).toEqual(['src/existing.ts'])
  })

  it('lists the checkout root for an empty path', async () => {
    expect((await git.listDir(repo, '')).map((n) => n.name)).toEqual(['src'])
  })

  it('refuses to enumerate out of the checkout', async () => {
    await expect(git.listDir(repo, '../..')).rejects.toThrow(/escapes/)
    await expect(git.listDir(repo, outside)).rejects.toThrow(/not a path inside/)
  })

  it('refuses the sibling near-miss', async () => {
    siblingTree()
    await expect(git.listDir(repo, siblingRel(''))).rejects.toThrow(/escapes/)
  })

  it('lists a linked directory as a directory, not as a file', async () => {
    // A Dirent's isDirectory() is false for a link, so a pnpm-style linked
    // package used to show as an unexpandable file in the tree.
    mkdirSync(join(repo, 'real-pkg'))
    linkDir(join(repo, 'real-pkg'), join(repo, 'src', 'linked-pkg'))
    const nodes = await git.listDir(repo, 'src')
    expect(nodes.find((n) => n.name === 'linked-pkg')?.type).toBe('dir')
    expect(nodes.find((n) => n.name === 'existing.ts')?.type).toBe('file')
  })

  it('lists a dangling link as a file rather than failing the whole listing', async () => {
    linkDir(join(repo, 'gone'), join(repo, 'src', 'dangling'))
    const nodes = await git.listDir(repo, 'src')
    expect(nodes.find((n) => n.name === 'dangling')?.type).toBe('file')
  })
})

/* ---- Diff -----------------------------------------------------------------
 *
 * `diff` is the one git-pathspec operation that ALSO has a `--no-index` branch,
 * and `--no-index` is git's "compare files that are not in a repository" mode:
 * it ignores the repository boundary by design. So the containment story for
 * this function is not git's, and these tests run against a real `git init`
 * checkout to prove the gate is ours.
 * ------------------------------------------------------------------------- */

/** Turn the scratch checkout into a real repository with one commit. */
function gitInit(): void {
  const g = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  g('init', '-q')
  g('config', 'user.email', 'test@example.com')
  g('config', 'user.name', 'Test')
  g('add', '.')
  g('commit', '-q', '-m', 'init')
}

describe('git.diff', () => {
  it('diffs an untracked file against nothing, so it renders as all additions', async () => {
    gitInit()
    writeFileSync(join(repo, 'src', 'fresh.ts'), 'one\ntwo\n')
    const d = await git.diff(repo, 'src/fresh.ts', false)
    expect(d.additions).toBe(2)
    expect(d.deletions).toBe(0)
    expect(d.lines.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['one', 'two'])
  })

  it('diffs a modified tracked file', async () => {
    gitInit()
    writeFileSync(join(repo, 'src', 'existing.ts'), 'export const a = 2\n')
    const d = await git.diff(repo, 'src/existing.ts', false)
    expect(d.additions).toBe(1)
    expect(d.deletions).toBe(1)
  })

  it('refuses to read out of the checkout through the --no-index fallback', async () => {
    // Before the gate, both of these came back as the full file contents: the
    // path is untracked (not in this repo at all), so the untracked branch ran
    // `diff --no-index -- /dev/null <path>`, which reads anything it is given.
    gitInit()
    await expect(git.diff(repo, '../outside/secret.txt', false)).rejects.toThrow(/escapes/)
    await expect(git.diff(repo, join(outside, 'secret.txt'), false)).rejects.toThrow(
      /not a path inside/
    )
  })

  it('refuses the sibling near-miss', async () => {
    gitInit()
    siblingTree()
    await expect(git.diff(repo, siblingRel('secret.txt'), false)).rejects.toThrow(/escapes/)
  })

  it('applies the same spelling rule to the staged and tracked branches', async () => {
    // Git would refuse these itself ("is outside repository"), but the gate
    // answers first, with the same message every file operation uses.
    gitInit()
    await expect(git.diff(repo, '../nope.txt', true)).rejects.toThrow(/escapes/)
    await expect(git.diff(repo, join(outside, 'secret.txt'), true)).rejects.toThrow(
      /not a path inside/
    )
  })
})

/* ---- Symlink containment -------------------------------------------------
 *
 * `resolveInRepo` is lexical, so `link/x.txt` satisfies it however far out of
 * the checkout `link` points. The mutating operations therefore re-ask the
 * question of the real filesystem. These tests cover both directions: the
 * escape is refused, and the several legitimate shapes are NOT.
 * ------------------------------------------------------------------------- */

describe('real-path containment', () => {
  it('refuses to create through a link that leaves the checkout', async () => {
    linkDir(outside, join(repo, 'escape'))
    await expect(git.createFile(repo, 'escape', 'planted.txt')).rejects.toThrow(/resolves outside/)
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false)
  })

  it('refuses to create a directory through such a link', async () => {
    linkDir(outside, join(repo, 'escape'))
    await expect(git.createDirectory(repo, 'escape', 'planted')).rejects.toThrow(/resolves outside/)
    expect(existsSync(join(outside, 'planted'))).toBe(false)
  })

  it('refuses to rename a file that lives outside via a link', async () => {
    linkDir(outside, join(repo, 'escape'))
    await expect(git.renamePath(repo, 'escape/secret.txt', 'mine.txt')).rejects.toThrow(
      /resolves outside/
    )
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
  })

  it('refuses to bin a file that lives outside via a link', async () => {
    linkDir(outside, join(repo, 'escape'))
    await expect(git.trashPath(repo, 'escape/secret.txt')).rejects.toThrow(/resolves outside/)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('allows a link that stays inside the checkout', async () => {
    // Repos legitimately contain links. One pointing at a sibling directory in
    // the same checkout is still the checkout, and must not be collateral.
    mkdirSync(join(repo, 'real'))
    linkDir(join(repo, 'real'), join(repo, 'src', 'linked'))
    expect(await git.createFile(repo, 'src/linked', 'ok.txt')).toBe('src/linked/ok.txt')
    expect(existsSync(join(repo, 'real', 'ok.txt'))).toBe(true)
  })

  it('allows operations on a checkout reached through a link', async () => {
    // Orbital's own worktrees live under `.orbital-worktrees`, and a checkout
    // path can sit behind a junction or a symlinked home. The root is resolved
    // the same way the target is, so this must not read as an escape.
    const linkedRoot = join(outside, 'checkout-link')
    linkDir(repo, linkedRoot)
    expect(await git.createFile(linkedRoot, 'src', 'via-link.ts')).toBe('src/via-link.ts')
    expect(existsSync(join(repo, 'src', 'via-link.ts'))).toBe(true)
  })

  it('refuses to write through a link that leaves the checkout', async () => {
    linkDir(outside, join(repo, 'escape'))
    await expect(git.writeFile(repo, 'escape/secret.txt', 'pwned')).rejects.toThrow(
      /resolves outside/
    )
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('do not touch\n')
  })

  it('still READS through such a link — the deliberate half of the split', async () => {
    // Reads stop at the lexical gate on purpose. `listDir` exists to expand
    // ignored directories, i.e. node_modules, where pnpm and npm hand out links
    // into a store outside the checkout; refusing those would turn "expand
    // node_modules" and "open the file I can see" into errors. Nothing in the
    // file IPC surface creates such a link and every entry-creating call is
    // real-path checked, so it has to have arrived in a repo the user chose to
    // open, where the terminal tab beside the editor reads the same bytes.
    // Writing through one still changes state outside the checkout, which is
    // why the test above refuses it.
    linkDir(outside, join(repo, 'escape'))
    expect(await git.readFile(repo, 'escape/secret.txt')).toBe('do not touch\n')
    expect((await git.listDir(repo, 'escape')).map((n) => n.name)).toContain('secret.txt')
  })

  it('lets a link entry itself be renamed and binned', async () => {
    // Only the ANCESTORS are resolved: a symlink is a directory entry like any
    // other, and renaming or binning one edits the link, not its target.
    linkDir(outside, join(repo, 'escape'))
    expect(await git.renamePath(repo, 'escape', 'renamed-link')).toBe('renamed-link')
    expect(existsSync(join(repo, 'renamed-link'))).toBe(true)

    await git.trashPath(repo, 'renamed-link')
    expect(trashItem).toHaveBeenCalledWith(join(repo, 'renamed-link'))
    // The link's target is untouched by either operation.
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('do not touch\n')
  })

  it('resolves a linked entry to a path whose real target is outside the repo', () => {
    // What this pins is `resolveInRepo` itself: given a link that leaves the
    // checkout, it returns the lexical path unchanged, and that path's REAL
    // target is outside. That is the stated negative in the API docs for
    // `openPath` / `revealPath` / `openInTerminal` — those three contain the
    // SPELLING, not the destination — and it is worth a test because the
    // property is deliberate rather than accidental.
    //
    // Be precise about what it does NOT pin. The hand-offs live in
    // `main/ipc.ts`, which no test imports (it pulls in electron, the sqlite
    // repo and node-pty), so nothing here observes their wiring: swapping
    // `worktreePath` to a real-path gate would leave this test green. Read it
    // as "the gate those three call behaves this way", not as a regression
    // guard on the call sites. Covering those properly needs a test that can
    // load `ipc.ts`, which is a bigger change than this file.
    linkDir(outside, join(repo, 'escape'))
    const handedToTheOs = resolveInRepo(repo, 'escape/secret.txt')
    expect(handedToTheOs).toBe(join(repo, 'escape', 'secret.txt'))
    expect(realpathSync(handedToTheOs)).toBe(join(realpathSync(outside), 'secret.txt'))
  })
})
