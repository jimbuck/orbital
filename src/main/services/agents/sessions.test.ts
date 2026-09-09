import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { files, isDir, readHead, samePath, subdirs } from './sessions'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orbital-sessions-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('samePath', () => {
  it('ignores separator style and a trailing slash', () => {
    expect(samePath(root, `${root}/`)).toBe(true)
    expect(samePath(root, root.replace(/\\/g, '/'))).toBe(true)
    expect(samePath(root, join(root, 'child'))).toBe(false)
  })

  it.runIf(process.platform === 'win32')('ignores case on Windows', () => {
    expect(samePath('C:\\Projects\\orbital', 'c:/projects/ORBITAL/')).toBe(true)
  })
})

describe('directory helpers', () => {
  it('list subdirectories and files separately, and tolerate a missing dir', () => {
    mkdirSync(join(root, 'a'))
    writeFileSync(join(root, 'f.txt'), 'x')
    expect(subdirs(root)).toEqual(['a'])
    expect(files(root)).toEqual(['f.txt'])
    expect(subdirs(join(root, 'missing'))).toEqual([])
    expect(files(join(root, 'missing'))).toEqual([])
    expect(isDir(join(root, 'a'))).toBe(true)
    expect(isDir(join(root, 'f.txt'))).toBe(false)
  })

  it('reads only the head of a file', () => {
    const file = join(root, 'big.jsonl')
    writeFileSync(file, 'x'.repeat(100) + '\n' + 'y'.repeat(100))
    expect(readHead(file, 50)).toBe('x'.repeat(50))
    expect(readHead(join(root, 'missing'))).toBe('')
  })
})
