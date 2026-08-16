import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// git.ts reaches Electron's shell for `trashItem` (the delete path); nothing in
// these tests bins anything, but the import has to resolve.
vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))

import { checkEntryName, git, resolveInRepo } from './git'

const onWindows = process.platform === 'win32'

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

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orbital-git-'))
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'existing.ts'), 'export const a = 1\n')
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
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
})
