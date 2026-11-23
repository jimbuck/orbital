import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Repo, Task, Worktree } from '@shared/types'

vi.mock('../runtime', () => ({ tables: {} }))

const { agentAddDirs, assembleProjectMap, branchFromStatusHeader, relativePath, sessionRole } = await import(
  './project-map'
)

const repo = (id: string, path: string): Repo => ({
  id,
  name: id,
  repoPath: path,
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId: 'p1'
})
const home = repo('home', 'C:\\work\\home')
const api = repo('api', 'C:\\work\\api')
const web = repo('web', 'C:\\work\\web')
const repos = [home, api, web]
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Platform',
  rootPath: 'C:\\work',
  homeRepoId: 'home',
  managedBlock: true,
  codeWorkspace: false,
  repoIds: ['home', 'api', 'web'],
  createdAt: 0,
  ...over
})
const wt = (kind: Worktree['kind'], repoId: string | null, path: string): Worktree =>
  ({ id: `${repoId}-${kind}`, kind, repoId, projectId: 'p1', path, name: kind, branch: 'main' }) as Worktree

describe('sessionRole', () => {
  it('makes a folder session the project session', () => {
    const role = sessionRole(wt('folder', null, 'C:\\work'), project({ homeRepoId: null }), repos)
    expect(role?.kind).toBe('project')
    expect(role?.home).toBeNull()
  })

  it('makes any worktree of the home the project session when there are other members', () => {
    expect(sessionRole(wt('root', 'home', home.repoPath), project(), repos)?.kind).toBe('project')
    expect(sessionRole(wt('linked', 'home', 'C:\\wt\\home-x'), project(), repos)?.kind).toBe('project')
  })

  it('gives a home that is the only repo no role', () => {
    expect(sessionRole(wt('root', 'home', home.repoPath), project({ repoIds: ['home'] }), repos)).toBeNull()
  })

  it('makes a sibling a member, with or without a home', () => {
    expect(sessionRole(wt('root', 'api', api.repoPath), project(), repos)?.kind).toBe('member')
    expect(sessionRole(wt('root', 'api', api.repoPath), project({ homeRepoId: null }), repos)?.kind).toBe('member')
  })

  it('gives a plain one-repo project no role', () => {
    expect(sessionRole(wt('root', 'api', api.repoPath), project({ homeRepoId: null, repoIds: ['api'] }), repos)).toBeNull()
  })
})

describe('agentAddDirs', () => {
  it('adds every other member to the project session, but not its own repo or the cwd', () => {
    const folder = wt('folder', null, 'C:\\work')
    expect(agentAddDirs(sessionRole(folder, project({ homeRepoId: null }), repos), folder)).toEqual([
      home.repoPath,
      api.repoPath,
      web.repoPath
    ])
    const homeLinked = wt('linked', 'home', 'C:\\wt\\home-x')
    expect(agentAddDirs(sessionRole(homeLinked, project(), repos), homeLinked)).toEqual([api.repoPath, web.repoPath])
  })

  it('adds only the home to a member session, and nothing when there is no home', () => {
    const apiRoot = wt('root', 'api', api.repoPath)
    expect(agentAddDirs(sessionRole(apiRoot, project(), repos), apiRoot)).toEqual([home.repoPath])
    expect(agentAddDirs(sessionRole(apiRoot, project({ homeRepoId: null }), repos), apiRoot)).toEqual([])
  })

  it('adds nothing for a plain repo', () => {
    expect(agentAddDirs(null, wt('root', 'api', api.repoPath))).toEqual([])
  })
})

describe('relativePath', () => {
  it('uses forward slashes, and gives up across drives', () => {
    const root = join(tmpdir(), 'work')
    expect(relativePath(root, join(root, 'api'))).toBe('api')
    expect(relativePath(join(root, 'home'), join(root, 'api'))).toBe('../api')
    expect(relativePath(join(root, 'home'), join(root, 'libs', 'ui'))).toBe('../libs/ui')
    expect(relativePath(root, root)).toBeNull()
    if (process.platform === 'win32') expect(relativePath('C:\\work', 'D:\\api')).toBeNull()
  })
})

describe('branchFromStatusHeader', () => {
  it('reads the branch from every header shape', () => {
    expect(branchFromStatusHeader('## main...origin/main [ahead 1]')).toBe('main')
    expect(branchFromStatusHeader('## feat/x')).toBe('feat/x')
    expect(branchFromStatusHeader('## No commits yet on main')).toBe('main')
    expect(branchFromStatusHeader('## HEAD (no branch)')).toBe('HEAD (detached)')
    expect(branchFromStatusHeader(' M file')).toBeNull()
  })
})

describe('assembleProjectMap', () => {
  it('joins rows and probes into one entry per member', () => {
    const linked = { ...wt('linked', 'api', 'C:\\wt\\api-x'), name: 'api-x', branch: 'feat/x', taskId: 't1' }
    const tasks = [
      { id: 't1', seq: 12, projectId: 'p1', repoId: 'api', status: 'in-progress', archivedAt: null },
      { id: 't2', seq: 13, projectId: 'p1', repoId: 'api', status: 'done', archivedAt: null },
      { id: 't3', seq: 14, projectId: 'p1', repoId: 'web', status: 'todo', archivedAt: null },
      // Filed under no repo, and under one that is no longer the project's: both span the project.
      { id: 't4', seq: 15, projectId: 'p1', repoId: null, status: 'todo', archivedAt: null },
      { id: 't5', seq: 16, projectId: 'p1', repoId: 'gone', status: 'draft', archivedAt: null },
      // Another project's task never counts here.
      { id: 't6', seq: 17, projectId: 'p2', repoId: 'web', status: 'todo', archivedAt: null }
    ] as unknown as Task[]
    const map = assembleProjectMap({
      project: project(),
      members: repos,
      worktrees: [wt('root', 'api', api.repoPath), linked],
      tasks,
      probes: new Map([['api', { remote: 'git@x:api.git', branch: 'main', dirty: true }]]),
      currentRepoId: 'api',
      steering: (p) => (p === api.repoPath ? ['AGENTS.md'] : [])
    })
    expect(map.home).toEqual({ id: 'home', name: 'home', path: home.repoPath })
    const entry = map.repos.find((r) => r.id === 'api')!
    expect(entry).toMatchObject({
      relPath: 'api',
      remote: 'git@x:api.git',
      branch: 'main',
      dirty: true,
      current: true,
      home: false,
      openTasks: 1,
      steering: ['AGENTS.md'],
      worktrees: [{ name: 'api-x', branch: 'feat/x', path: 'C:\\wt\\api-x', task: 12 }]
    })
    // No probe: unknown rather than a guess.
    expect(map.repos.find((r) => r.id === 'web')).toMatchObject({ remote: null, dirty: null, openTasks: 1 })
    expect(map.openTasks).toBe(2)
  })
})
