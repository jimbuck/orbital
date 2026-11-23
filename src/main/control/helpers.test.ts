import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlRequest, Repo } from '@shared/types'

// `tables.repos.list()` is workspace-scoped in the real repository; the stub
// stands in for "this instance's workspace". A repo of another workspace
// is simply absent from it.
const workspaceRepos: Repo[] = []
// Worktrees/tabs are NOT workspace-scoped in the real repository: lookups by id
// find rows of any workspace, so these stubs hold foreign ones too.
const worktrees = new Map<string, { id: string; repoId: string | null; projectId?: string; kind?: string; name?: string }>()
const tabs = new Map<string, { id: string; worktreeId: string }>()
// This workspace's projects (list is workspace-scoped, get is not).
const workspaceProjects = [{ id: 'proj-platform', name: 'Platform' }]
// A project of another workspace: `get` finds it, `list` does not.
const foreignProjects = [{ id: 'proj-foreign', name: 'Elsewhere' }]
vi.mock('../runtime', () => ({
  tables: {
    repos: { list: () => workspaceRepos },
    projects: {
      list: () => workspaceProjects,
      get: (id: string) => [...workspaceProjects, ...foreignProjects].find((p) => p.id === id)
    },
    worktrees: { get: (id: string) => worktrees.get(id) },
    tabs: { get: (id: string) => tabs.get(id) }
  }
}))

const { noRepoError, resolveRepo, scopeRequest } = await import('./helpers')

const repo = (id: string, name: string): Repo => ({
  id,
  name,
  repoPath: `C:\\repos\\${name}`,
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId: `project-${id}`
})

const req = (over: Partial<ControlRequest> = {}): ControlRequest => ({ cmd: 'task-list', args: {}, ...over })

beforeEach(() => {
  workspaceRepos.splice(
    0,
    workspaceRepos.length,
    repo('aaaa1111-0000', 'web'),
    repo('bbbb2222-0000', 'API'),
    repo('cccc3333-0000', 'dup'),
    repo('cccc4444-0000', 'dup')
  )
  worktrees.clear()
  tabs.clear()
  worktrees.set('wt-web', { id: 'wt-web', repoId: 'aaaa1111-0000' })
  worktrees.set('wt-api', { id: 'wt-api', repoId: 'bbbb2222-0000' })
  worktrees.set('wt-foreign', { id: 'wt-foreign', repoId: 'foreign-repo' })
  tabs.set('tab-web', { id: 'tab-web', worktreeId: 'wt-web' })
  tabs.set('tab-foreign', { id: 'tab-foreign', worktreeId: 'wt-foreign' })
})

describe('resolveRepo', () => {
  it('matches an exact id', () => {
    expect(resolveRepo('bbbb2222-0000').repo?.name).toBe('API')
  })

  it('matches a name case-insensitively', () => {
    expect(resolveRepo('api').repo?.id).toBe('bbbb2222-0000')
  })

  it('matches a unique id prefix', () => {
    expect(resolveRepo('aaaa').repo?.name).toBe('web')
  })

  it('rejects ambiguous names and prefixes', () => {
    expect(resolveRepo('dup').error).toMatch(/ambiguous/)
    expect(resolveRepo('cccc').error).toMatch(/ambiguous/)
  })

  it('does not find repos outside the workspace', () => {
    expect(resolveRepo('zzzz9999-0000').error).toMatch(/no repo/)
  })
})

describe('scopeRequest', () => {
  it('keeps the caller repo when no --repo is given', () => {
    expect(scopeRequest(req({ repoId: 'aaaa1111-0000' })).req?.repoId).toBe('aaaa1111-0000')
  })

  it('retargets the request at the --repo sibling', () => {
    const scoped = scopeRequest(req({ repoId: 'aaaa1111-0000', args: { repo: 'api' } }))
    expect(scoped.req?.repoId).toBe('bbbb2222-0000')
  })

  it('works without an env repo when --repo is given', () => {
    expect(scopeRequest(req({ args: { repo: 'web' } })).req?.repoId).toBe('aaaa1111-0000')
  })

  it('fails on an unknown --repo instead of falling back', () => {
    expect(scopeRequest(req({ repoId: 'aaaa1111-0000', args: { repo: 'nope' } })).error).toMatch(/no repo/)
  })

  it('rejects an env repo id from another workspace', () => {
    const scoped = scopeRequest(req({ cmd: 'worktree-new', repoId: 'foreign-id' }))
    expect(scoped.req).toBeUndefined()
    expect(scoped.error).toMatch(/not in this workspace/)
  })

  it('rejects a --repo id from another workspace', () => {
    expect(scopeRequest(req({ args: { repo: 'foreign-id' } })).error).toMatch(/no repo/)
  })

  it('passes requests without any repo through', () => {
    expect(scopeRequest(req({ cmd: 'status' })).req?.repoId).toBeUndefined()
  })
})

describe('scopeRequest env worktree / terminal ids', () => {
  it('accepts own worktree, terminal and matching repo', () => {
    const r = req({ cmd: 'whoami', repoId: 'aaaa1111-0000', worktreeId: 'wt-web', terminalId: 'tab-web' })
    expect(scopeRequest(r).req).toBeDefined()
  })

  it('accepts a worktree id without a repo id', () => {
    expect(scopeRequest(req({ worktreeId: 'wt-web' })).req).toBeDefined()
  })

  it('rejects a worktree of another workspace', () => {
    expect(scopeRequest(req({ cmd: 'whoami', worktreeId: 'wt-foreign' })).error).toMatch(/worktree .* not in this workspace/)
  })

  it('rejects a terminal of another workspace', () => {
    expect(scopeRequest(req({ cmd: 'status', terminalId: 'tab-foreign' })).error).toMatch(/terminal .* not in this workspace/)
  })

  it('rejects a worktree that belongs to another repo than the env repo', () => {
    const scoped = scopeRequest(req({ repoId: 'aaaa1111-0000', worktreeId: 'wt-api' }))
    expect(scoped.error).toMatch(/does not belong to repo/)
  })

  it('rejects a terminal that is not in the given worktree', () => {
    const scoped = scopeRequest(req({ worktreeId: 'wt-api', terminalId: 'tab-web' }))
    expect(scoped.error).toMatch(/does not belong to worktree/)
  })

  it('lets --repo override the repo without tripping the env consistency check', () => {
    const scoped = scopeRequest(
      req({ repoId: 'aaaa1111-0000', worktreeId: 'wt-web', terminalId: 'tab-web', args: { repo: 'api' } })
    )
    expect(scoped.req?.repoId).toBe('bbbb2222-0000')
  })

  it('still rejects a foreign worktree when --repo is given', () => {
    expect(scopeRequest(req({ worktreeId: 'wt-foreign', args: { repo: 'api' } })).error).toMatch(/not in this workspace/)
  })

  it('passes stale ids (closed tab / removed worktree) through for the handlers to no-op', () => {
    expect(scopeRequest(req({ cmd: 'hook', worktreeId: 'gone-wt', terminalId: 'gone-tab' })).req).toBeDefined()
  })
})

describe("a project's folder session (no repo)", () => {
  beforeEach(() => {
    worktrees.set('wt-folder', { id: 'wt-folder', repoId: null, projectId: 'proj-platform', kind: 'folder', name: 'Platform' })
    worktrees.set('wt-folder-foreign', { id: 'wt-folder-foreign', repoId: null, projectId: 'proj-elsewhere', kind: 'folder' })
    tabs.set('tab-folder', { id: 'tab-folder', worktreeId: 'wt-folder' })
  })

  it('is in the workspace when its project is, so its status hooks go through', () => {
    expect(scopeRequest(req({ worktreeId: 'wt-folder', terminalId: 'tab-folder' })).req).toBeDefined()
    expect(scopeRequest(req({ worktreeId: 'wt-folder-foreign' })).error).toMatch(/not in this workspace/)
  })

  it('answers a repo-scoped command with what to do instead of blaming the environment', () => {
    expect(noRepoError(req({ worktreeId: 'wt-folder' }))).toMatch(
      /folder session of project 'Platform', which has no repo of its own; pass --repo/
    )
    expect(noRepoError(req({ worktreeId: 'wt-web' }))).toBe('no ORBITAL_REPO_ID in environment')
    expect(noRepoError(req())).toBe('no ORBITAL_REPO_ID in environment')
  })

  it('still reaches a sibling repo with --repo', () => {
    expect(scopeRequest(req({ worktreeId: 'wt-folder', args: { repo: 'web' } })).req?.repoId).toBe('aaaa1111-0000')
  })
})

describe('ORBITAL_PROJECT_ID', () => {
  it('passes a project of this workspace, and a stale one that matches nothing', () => {
    expect(scopeRequest(req({ projectId: 'proj-platform' })).req?.projectId).toBe('proj-platform')
    expect(scopeRequest(req({ projectId: 'proj-gone' })).req).toBeDefined()
  })

  it("rejects another workspace's project", () => {
    expect(scopeRequest(req({ projectId: 'proj-foreign' })).error).toMatch(/project 'proj-foreign' is not in this workspace/)
  })

  it('reads a project id that arrived as the repo (an empty ORBITAL_REPO_ID a shell dropped) as the project', () => {
    const scoped = scopeRequest(req({ repoId: 'proj-platform' }))
    expect(scoped.req?.repoId).toBeUndefined()
    expect(scoped.req?.projectId).toBe('proj-platform')
  })

  it('still rejects a repo id that is neither a repo nor a project here', () => {
    expect(scopeRequest(req({ repoId: 'proj-foreign' })).error).toMatch(/repo 'proj-foreign' is not in this workspace/)
  })
})
