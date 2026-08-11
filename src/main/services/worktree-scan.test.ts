import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Worktree } from '@shared/types'
import type { GitWorktreeEntry } from './git'
import { beginWorktreeCreate, endWorktreeCreate, pathsBeingCreated, planWorktreeSync } from './worktree-scan'

let root = ''
let project: Project
let rootRow: Worktree

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orbital-scan-'))
  mkdirSync(join(root, 'repo'), { recursive: true })
  mkdirSync(join(root, 'wt'), { recursive: true })
  project = { id: 'p1', name: 'repo', repoPath: join(root, 'repo') } as Project
  rootRow = { id: 'w-root', projectId: 'p1', kind: 'root', name: 'main', path: join(root, 'repo'), branch: 'main' } as Worktree
})
afterEach(() => {
  endWorktreeCreate(join(root, 'wt'))
  rmSync(root, { recursive: true, force: true })
})

/** git's view: the main checkout plus one linked worktree Orbital has no row for. */
function entries(): GitWorktreeEntry[] {
  return [
    { path: join(root, 'repo'), branch: 'main', bare: false, prunable: false },
    { path: join(root, 'wt'), branch: 'feature', bare: false, prunable: false }
  ]
}

describe('adoption of unknown checkouts', () => {
  it('adopts a checkout git knows about that has no row', () => {
    const plan = planWorktreeSync(project, [rootRow], entries(), [])
    expect(plan.adopt).toEqual([{ path: join(root, 'wt'), name: 'wt', branch: 'feature' }])
  })

  it('does NOT adopt a checkout Orbital is mid-create on', () => {
    // The window that produced two rows for one checkout: `git worktree add` has
    // announced itself, but createLinkedWorktree has not inserted its row yet.
    beginWorktreeCreate(join(root, 'wt'))
    expect(pathsBeingCreated()).toHaveLength(1)

    const plan = planWorktreeSync(project, [rootRow], entries(), pathsBeingCreated())
    expect(plan.adopt).toEqual([])
    // The in-flight checkout must not be torn down either.
    expect(plan.remove).toEqual([])

    // Once the row exists the claim is released, and a checkout created outside
    // Orbital is adoptable again.
    endWorktreeCreate(join(root, 'wt'))
    expect(pathsBeingCreated()).toEqual([])
    expect(planWorktreeSync(project, [rootRow], entries(), pathsBeingCreated()).adopt).toHaveLength(1)
  })

  it('matches the claim regardless of path spelling', () => {
    // git reports forward slashes on Windows; the claim is registered with the
    // OS-native path Orbital computed.
    beginWorktreeCreate(join(root, 'wt').replace(/\\/g, '/'))
    expect(planWorktreeSync(project, [rootRow], entries(), pathsBeingCreated()).adopt).toEqual([])
  })
})
