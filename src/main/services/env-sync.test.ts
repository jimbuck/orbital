import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COPY_IN_PROGRESS_MARKER, copyNodeModulesTree, hasIncompleteCopy, targetsNodeModules } from './env-sync'

const onWindows = process.platform === 'win32'

let root = ''
let worktree = ''

/** A small but non-trivial node_modules: nested dirs, dotfiles, a few files. */
function seedNodeModules(): void {
  const nm = join(root, 'node_modules')
  mkdirSync(join(nm, 'pkg-a', 'lib'), { recursive: true })
  mkdirSync(join(nm, '.bin'), { recursive: true })
  mkdirSync(join(nm, '@scope', 'pkg-b'), { recursive: true })
  writeFileSync(join(nm, 'pkg-a', 'package.json'), '{"name":"pkg-a"}')
  writeFileSync(join(nm, 'pkg-a', 'lib', 'index.js'), 'module.exports = 1')
  writeFileSync(join(nm, '.bin', 'tool.cmd'), '@echo off')
  writeFileSync(join(nm, '@scope', 'pkg-b', 'index.js'), 'module.exports = 2')
  writeFileSync(join(nm, '.package-lock.json'), '{}')
}

const read = (rel: string): string => readFileSync(join(worktree, 'node_modules', rel), 'utf8')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orbital-envsync-root-'))
  worktree = mkdtempSync(join(tmpdir(), 'orbital-envsync-wt-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(worktree, { recursive: true, force: true })
})

describe('targetsNodeModules', () => {
  it('is true only for patterns that name node_modules', () => {
    expect(targetsNodeModules(['.env', 'node_modules'])).toBe(true)
    expect(targetsNodeModules(['node_modules/**'])).toBe(true)
    expect(targetsNodeModules(['.env', '**/.env.*'])).toBe(false)
    expect(targetsNodeModules([])).toBe(false)
  })
})

describe('copyNodeModulesTree', () => {
  it('copies the whole tree and reports what it did', async () => {
    seedNodeModules()
    const report = await copyNodeModulesTree(root, worktree)
    expect(read('pkg-a/package.json')).toBe('{"name":"pkg-a"}')
    expect(read('pkg-a/lib/index.js')).toBe('module.exports = 1')
    expect(read('.bin/tool.cmd')).toBe('@echo off')
    expect(read('@scope/pkg-b/index.js')).toBe('module.exports = 2')
    expect(read('.package-lock.json')).toBe('{}')
    expect(report.copied).toBe(5)
    expect(report.skipped).toBe(0)
    expect(report.errorCount).toBe(0)
    expect(report.bytes).toBeGreaterThan(0)
  })

  it('is a no-op when the root has no node_modules', async () => {
    const report = await copyNodeModulesTree(root, worktree)
    expect(report.copied).toBe(0)
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
  })

  it('reports progress per file', async () => {
    seedNodeModules()
    const ticks: number[] = []
    await copyNodeModulesTree(root, worktree, { onProgress: (n) => ticks.push(n) })
    expect(ticks).toEqual([1, 2, 3, 4, 5])
  })

  it('resumes: a second run skips files the worktree already has', async () => {
    // What makes an interrupted copy finishable — and a stalled one worth
    // retrying — instead of a from-scratch rewrite of the whole tree.
    seedNodeModules()
    await copyNodeModulesTree(root, worktree)
    const again = await copyNodeModulesTree(root, worktree)
    expect(again.copied).toBe(0)
    expect(again.skipped).toBe(5)
  })

  it('resumes: fills in what an interrupted copy did not reach', async () => {
    seedNodeModules()
    // Half a copy, as a killed app would leave it.
    mkdirSync(join(worktree, 'node_modules', 'pkg-a'), { recursive: true })
    writeFileSync(join(worktree, 'node_modules', 'pkg-a', 'package.json'), '{"name":"pkg-a"}')
    const report = await copyNodeModulesTree(root, worktree)
    expect(report.skipped).toBe(1)
    expect(report.copied).toBe(4)
    expect(read('pkg-a/lib/index.js')).toBe('module.exports = 1')
  })

  it('overwrites a worktree file the root has since changed', async () => {
    seedNodeModules()
    await copyNodeModulesTree(root, worktree)
    // The root was reinstalled: same file, new content, newer mtime.
    const src = join(root, 'node_modules', 'pkg-a', 'lib', 'index.js')
    writeFileSync(src, 'module.exports = 42')
    const future = new Date(Date.now() + 60_000)
    utimesSync(src, future, future)
    const report = await copyNodeModulesTree(root, worktree)
    expect(report.copied).toBe(1)
    expect(read('pkg-a/lib/index.js')).toBe('module.exports = 42')
  })

  it('overwrites a worktree file whose size differs, whatever the mtimes say', async () => {
    seedNodeModules()
    await copyNodeModulesTree(root, worktree)
    writeFileSync(join(worktree, 'node_modules', 'pkg-a', 'package.json'), 'truncated')
    const report = await copyNodeModulesTree(root, worktree)
    expect(report.copied).toBe(1)
    expect(read('pkg-a/package.json')).toBe('{"name":"pkg-a"}')
  })

  it('leaves the in-progress marker while copying and removes it after', async () => {
    seedNodeModules()
    let seenDuring = false
    const report = await copyNodeModulesTree(root, worktree, {
      onProgress: () => {
        seenDuring = seenDuring || hasIncompleteCopy(worktree)
      }
    })
    expect(report.errorCount).toBe(0)
    expect(seenDuring).toBe(true)
    expect(hasIncompleteCopy(worktree)).toBe(false)
    expect(existsSync(join(worktree, 'node_modules', COPY_IN_PROGRESS_MARKER))).toBe(false)
  })

  it('recognises a copy that never finished by its marker', () => {
    expect(hasIncompleteCopy(worktree)).toBe(false)
    mkdirSync(join(worktree, 'node_modules'), { recursive: true })
    writeFileSync(join(worktree, 'node_modules', COPY_IN_PROGRESS_MARKER), '')
    expect(hasIncompleteCopy(worktree)).toBe(true)
  })

  it('records a per-file failure and carries on with the rest', async () => {
    seedNodeModules()
    // A directory where the copy expects to write a file: copyFile fails on
    // that one path and nothing else.
    mkdirSync(join(worktree, 'node_modules', 'pkg-a', 'package.json'), { recursive: true })
    const report = await copyNodeModulesTree(root, worktree)
    expect(report.errorCount).toBe(1)
    expect(report.errors[0].path).toBe(join(root, 'node_modules', 'pkg-a', 'package.json'))
    expect(report.errors[0].message).toBeTruthy()
    expect(report.copied).toBe(4)
    expect(read('pkg-a/lib/index.js')).toBe('module.exports = 1')
    // The marker still comes off: the copy FINISHED, with errors, and the
    // caller logs them. Leaving it would mean retrying a permanent failure on
    // every launch.
    expect(hasIncompleteCopy(worktree)).toBe(false)
  })

  it('runs copies from the same root one at a time, in order', async () => {
    seedNodeModules()
    const other = mkdtempSync(join(tmpdir(), 'orbital-envsync-wt2-'))
    try {
      const order: string[] = []
      const first = copyNodeModulesTree(root, worktree, { onProgress: () => order.push('first') })
      const second = copyNodeModulesTree(root, other, { onProgress: () => order.push('second') })
      await Promise.all([first, second])
      // Every tick of the first copy lands before any tick of the second.
      expect(order).toEqual([...Array(5).fill('first'), ...Array(5).fill('second')])
      expect(readFileSync(join(other, 'node_modules', 'pkg-a', 'package.json'), 'utf8')).toBe('{"name":"pkg-a"}')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('recreates a link, rebasing a target inside the root onto the worktree', async () => {
    // An npm workspace: node_modules/pkg-ws -> <root>/packages/pkg-ws. The
    // worktree's copy should point at the worktree's own packages/pkg-ws.
    seedNodeModules()
    mkdirSync(join(root, 'packages', 'pkg-ws'), { recursive: true })
    writeFileSync(join(root, 'packages', 'pkg-ws', 'index.js'), 'ws')
    symlinkSync(join(root, 'packages', 'pkg-ws'), join(root, 'node_modules', 'pkg-ws'), onWindows ? 'junction' : 'dir')
    mkdirSync(join(worktree, 'packages', 'pkg-ws'), { recursive: true })
    writeFileSync(join(worktree, 'packages', 'pkg-ws', 'index.js'), 'ws-in-worktree')

    const report = await copyNodeModulesTree(root, worktree)
    expect(report.links).toBe(1)
    expect(report.errorCount).toBe(0)
    const link = join(worktree, 'node_modules', 'pkg-ws')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(link, 'index.js'), 'utf8')).toBe('ws-in-worktree')
    // A rerun leaves the link alone.
    expect((await copyNodeModulesTree(root, worktree)).skipped).toBe(6)
  })

  it('recreates a link whose target is outside the root verbatim', async () => {
    seedNodeModules()
    const store = mkdtempSync(join(tmpdir(), 'orbital-envsync-store-'))
    try {
      mkdirSync(join(store, 'global-pkg'))
      symlinkSync(join(store, 'global-pkg'), join(root, 'node_modules', 'global-pkg'), onWindows ? 'junction' : 'dir')
      await copyNodeModulesTree(root, worktree)
      const target = readlinkSync(join(worktree, 'node_modules', 'global-pkg'))
      // Windows reports a junction target with a trailing separator (and can
      // add a `\\?\` prefix); the path is what matters.
      expect(target.replace(/^\\\\\?\\/, '').replace(/[\\/]$/, '')).toBe(join(store, 'global-pkg'))
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })
})
