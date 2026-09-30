import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlRequest, Project } from '@shared/types'

// `repo.projects.list()` is workspace-scoped in the real repository; the stub
// stands in for "this instance's workspace". A project of another workspace
// is simply absent from it.
const workspaceProjects: Project[] = []
// Worktrees/tabs are NOT workspace-scoped in the real repository: lookups by id
// find rows of any workspace, so these stubs hold foreign ones too.
const worktrees = new Map<string, { id: string; projectId: string }>()
const tabs = new Map<string, { id: string; worktreeId: string }>()
vi.mock('../runtime', () => ({
  repo: {
    projects: { list: () => workspaceProjects },
    worktrees: { get: (id: string) => worktrees.get(id) },
    tabs: { get: (id: string) => tabs.get(id) }
  }
}))

const { resolveProject, scopeRequest } = await import('./helpers')

const project = (id: string, name: string): Project => ({
  id,
  name,
  repoPath: `C:\\repos\\${name}`,
  defaultAgentId: 'claude',
  addedAt: 0
})

const req = (over: Partial<ControlRequest> = {}): ControlRequest => ({ cmd: 'task-list', args: {}, ...over })

beforeEach(() => {
  workspaceProjects.splice(
    0,
    workspaceProjects.length,
    project('aaaa1111-0000', 'web'),
    project('bbbb2222-0000', 'API'),
    project('cccc3333-0000', 'dup'),
    project('cccc4444-0000', 'dup')
  )
  worktrees.clear()
  tabs.clear()
  worktrees.set('wt-web', { id: 'wt-web', projectId: 'aaaa1111-0000' })
  worktrees.set('wt-api', { id: 'wt-api', projectId: 'bbbb2222-0000' })
  worktrees.set('wt-foreign', { id: 'wt-foreign', projectId: 'foreign-project' })
  tabs.set('tab-web', { id: 'tab-web', worktreeId: 'wt-web' })
  tabs.set('tab-foreign', { id: 'tab-foreign', worktreeId: 'wt-foreign' })
})

describe('resolveProject', () => {
  it('matches an exact id', () => {
    expect(resolveProject('bbbb2222-0000').project?.name).toBe('API')
  })

  it('matches a name case-insensitively', () => {
    expect(resolveProject('api').project?.id).toBe('bbbb2222-0000')
  })

  it('matches a unique id prefix', () => {
    expect(resolveProject('aaaa').project?.name).toBe('web')
  })

  it('rejects ambiguous names and prefixes', () => {
    expect(resolveProject('dup').error).toMatch(/ambiguous/)
    expect(resolveProject('cccc').error).toMatch(/ambiguous/)
  })

  it('does not find projects outside the workspace', () => {
    expect(resolveProject('zzzz9999-0000').error).toMatch(/no project/)
  })
})

describe('scopeRequest', () => {
  it('keeps the caller project when no --project is given', () => {
    expect(scopeRequest(req({ projectId: 'aaaa1111-0000' })).req?.projectId).toBe('aaaa1111-0000')
  })

  it('retargets the request at the --project sibling', () => {
    const scoped = scopeRequest(req({ projectId: 'aaaa1111-0000', args: { project: 'api' } }))
    expect(scoped.req?.projectId).toBe('bbbb2222-0000')
  })

  it('works without an env project when --project is given', () => {
    expect(scopeRequest(req({ args: { project: 'web' } })).req?.projectId).toBe('aaaa1111-0000')
  })

  it('fails on an unknown --project instead of falling back', () => {
    expect(scopeRequest(req({ projectId: 'aaaa1111-0000', args: { project: 'nope' } })).error).toMatch(/no project/)
  })

  it('rejects an env project id from another workspace', () => {
    const scoped = scopeRequest(req({ cmd: 'worktree-new', projectId: 'foreign-id' }))
    expect(scoped.req).toBeUndefined()
    expect(scoped.error).toMatch(/not in this workspace/)
  })

  it('rejects a --project id from another workspace', () => {
    expect(scopeRequest(req({ args: { project: 'foreign-id' } })).error).toMatch(/no project/)
  })

  it('passes requests without any project through', () => {
    expect(scopeRequest(req({ cmd: 'status' })).req?.projectId).toBeUndefined()
  })
})

describe('scopeRequest env worktree / terminal ids', () => {
  it('accepts own worktree, terminal and matching project', () => {
    const r = req({ cmd: 'whoami', projectId: 'aaaa1111-0000', worktreeId: 'wt-web', terminalId: 'tab-web' })
    expect(scopeRequest(r).req).toBeDefined()
  })

  it('accepts a worktree id without a project id', () => {
    expect(scopeRequest(req({ worktreeId: 'wt-web' })).req).toBeDefined()
  })

  it('rejects a worktree of another workspace', () => {
    expect(scopeRequest(req({ cmd: 'whoami', worktreeId: 'wt-foreign' })).error).toMatch(/worktree .* not in this workspace/)
  })

  it('rejects a terminal of another workspace', () => {
    expect(scopeRequest(req({ cmd: 'status', terminalId: 'tab-foreign' })).error).toMatch(/terminal .* not in this workspace/)
  })

  it('rejects a worktree that belongs to another project than the env project', () => {
    const scoped = scopeRequest(req({ projectId: 'aaaa1111-0000', worktreeId: 'wt-api' }))
    expect(scoped.error).toMatch(/does not belong to project/)
  })

  it('rejects a terminal that is not in the given worktree', () => {
    const scoped = scopeRequest(req({ worktreeId: 'wt-api', terminalId: 'tab-web' }))
    expect(scoped.error).toMatch(/does not belong to worktree/)
  })

  it('lets --project override the project without tripping the env consistency check', () => {
    const scoped = scopeRequest(
      req({ projectId: 'aaaa1111-0000', worktreeId: 'wt-web', terminalId: 'tab-web', args: { project: 'api' } })
    )
    expect(scoped.req?.projectId).toBe('bbbb2222-0000')
  })

  it('still rejects a foreign worktree when --project is given', () => {
    expect(scopeRequest(req({ worktreeId: 'wt-foreign', args: { project: 'api' } })).error).toMatch(/not in this workspace/)
  })

  it('passes stale ids (closed tab / removed worktree) through for the handlers to no-op', () => {
    expect(scopeRequest(req({ cmd: 'hook', worktreeId: 'gone-wt', terminalId: 'gone-tab' })).req).toBeDefined()
  })
})
