import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
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
})

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
})
