import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileNode } from '@shared/types'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))

const { folderFileTree } = await import('./folder-tree')

/**
 * The editor tree of a project's folder session: a plain folder, with the
 * repos under it listed by git and the heavy folders left for a lazy expand.
 */

let root: string

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** `path` for a file, `path/` for a folder, and `path/…` for one left unexpanded. */
function flatten(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) =>
    n.type === 'file'
      ? [n.path]
      : n.children
        ? [`${n.path}/`, ...flatten(n.children)]
        : [`${n.path}/…`]
  )
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orbital-folder-tree-')))
  writeFileSync(join(root, 'AGENTS.md'), '# root\n')
  mkdirSync(join(root, 'notes'))
  writeFileSync(join(root, 'notes', 'plan.md'), 'plan\n')
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })

  const api = join(root, 'api')
  mkdirSync(join(api, 'src'), { recursive: true })
  gitIn(api, 'init', '-q', '-b', 'main')
  gitIn(api, 'config', 'user.email', 'test@example.com')
  gitIn(api, 'config', 'user.name', 'Test')
  gitIn(api, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(api, '.gitignore'), 'dist/\n')
  writeFileSync(join(api, 'src', 'index.ts'), 'export {}\n')
  gitIn(api, 'add', '.')
  gitIn(api, 'commit', '-q', '-m', 'init')
  writeFileSync(join(api, 'src', 'index.ts'), 'export const x = 1\n')
  mkdirSync(join(api, 'dist'))
  writeFileSync(join(api, 'dist', 'out.js'), '\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('folderFileTree', () => {
  it('lists the root folder, with each repo under it as git lists it, under its folder', async () => {
    const tree = await folderFileTree(root)
    expect(flatten(tree)).toEqual([
      'api/',
      'api/dist/…',
      'api/src/',
      'api/src/index.ts',
      'api/.gitignore',
      'node_modules/…',
      'notes/',
      'notes/plan.md',
      'AGENTS.md'
    ])
    const api = tree.find((n) => n.name === 'api')!
    const index = api.children!.find((n) => n.name === 'src')!.children![0]
    // Git's badge survives the graft, on the prefixed path.
    expect(index).toMatchObject({ path: 'api/src/index.ts', gitState: 'modified' })
    expect(api.children!.find((n) => n.name === 'dist')).toMatchObject({ ignored: true })
    expect(tree.find((n) => n.name === 'node_modules')).toMatchObject({ ignored: true, type: 'dir' })
  })

  it('hands a root that is itself a checkout to git', async () => {
    const tree = await folderFileTree(join(root, 'api'))
    expect(flatten(tree)).toContain('src/index.ts')
  })
})
