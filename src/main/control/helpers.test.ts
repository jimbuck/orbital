import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlRequest, Project } from '@shared/types'

// `repo.projects.list()` is workspace-scoped in the real repository; the stub
// stands in for "this instance's workspace". A project of another workspace
// is simply absent from it.
const workspaceProjects: Project[] = []
vi.mock('../runtime', () => ({ repo: { projects: { list: () => workspaceProjects } } }))

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
