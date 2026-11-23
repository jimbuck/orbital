import { describe, expect, it } from 'vitest'
import type { Project, Repo, Task, Worktree } from '@shared/types'
import {
  boardLanes,
  captureRepoId,
  impliedWorktreeRepoId,
  parseTargetValue,
  projectRepos,
  repoLock,
  targetValue,
  taskLaneKey,
  trackerFocusRepoId,
  worktreeTargets,
  type TaskScopeState
} from './taskScope'

const repo = (id: string, projectId = 'acme'): Repo => ({
  id,
  name: id,
  repoPath: `C:/acme/${id}`,
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId
})
const acme: Project = {
  id: 'acme',
  name: 'Acme',
  rootPath: 'C:/acme',
  homeRepoId: 'home',
  managedBlock: true,
  codeWorkspace: false,
  // Hand order puts the home in the middle; listings lead with it anyway.
  repoIds: ['api', 'home', 'web'],
  createdAt: 0
}
const repos = [repo('api'), repo('home'), repo('web'), repo('solo', 'solo')]
const task = (id: string, repoId: string | null, over: Partial<Task> = {}): Task => ({
  id,
  seq: 1,
  projectId: 'acme',
  repoId,
  title: id,
  description: '',
  tags: [],
  status: 'todo',
  worktreeId: null,
  createdBy: 'user',
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  ...over
})
const wt = (id: string, repoId: string | null, kind: Worktree['kind'], projectId = 'acme'): Worktree =>
  ({
    id,
    repoId,
    projectId,
    kind,
    name: id,
    path: id,
    branch: '',
    status: 'idle',
    taskId: null,
    panes: []
  }) as unknown as Worktree

describe('projectRepos', () => {
  it('lists the home first, then the hand order, skipping unknown ids', () => {
    expect(projectRepos({ ...acme, repoIds: [...acme.repoIds, 'gone'] }, repos).map((r) => r.id)).toEqual([
      'home',
      'api',
      'web'
    ])
    expect(projectRepos({ ...acme, homeRepoId: null }, repos).map((r) => r.id)).toEqual(['api', 'home', 'web'])
  })
})

describe('boardLanes', () => {
  const tasks = [
    task('t-api', 'api'),
    task('t-none', null),
    task('t-stale', 'gone'),
    task('t-web', 'web'),
    task('t-x', 'web', { projectId: 'other' })
  ]

  it('puts the Project lane first, then home, then the members, and a stale tag in Project', () => {
    const { single, lanes } = boardLanes(acme, repos, tasks)
    expect(single).toBe(false)
    expect(lanes.map((l) => [l.key, l.kind, l.name, l.repoId, l.tasks.map((t) => t.id)])).toEqual([
      ['project', 'project', 'Project', null, ['t-none', 't-stale']],
      ['home', 'home', 'home', 'home', []],
      ['api', 'repo', 'api', 'api', ['t-api']],
      ['web', 'repo', 'web', 'web', ['t-web']]
    ])
  })

  it('is single below two repos: one lane with every task, filed under the sole repo or none', () => {
    for (const [repoIds, repoId] of [
      [[], null],
      [['home'], 'home']
    ] as const) {
      const { single, lanes } = boardLanes({ ...acme, repoIds: [...repoIds] }, repos, tasks)
      expect(single).toBe(true)
      expect(lanes).toHaveLength(1)
      expect(lanes[0]).toMatchObject({ key: 'project', repoId })
      expect(lanes[0].tasks.map((t) => t.id)).toEqual(['t-api', 't-none', 't-stale', 't-web'])
    }
    expect(boardLanes({ ...acme, repoIds: ['api', 'web'], homeRepoId: null }, repos, tasks).single).toBe(false)
  })

  it('reads a lane from the tag only when the repo is in the project', () => {
    expect(taskLaneKey(task('a', 'api'), acme)).toBe('api')
    expect(taskLaneKey(task('a', 'solo'), acme)).toBe('project')
    expect(taskLaneKey(task('a', null), acme)).toBe('project')
  })
})

describe('repoLock', () => {
  it('pins a task to a live worktree with a repo, and nothing else', () => {
    const worktrees = [wt('w-api', 'api', 'linked'), wt('w-folder', null, 'folder')]
    expect(repoLock(task('a', 'api', { worktreeId: 'w-api' }), worktrees)?.id).toBe('w-api')
    expect(repoLock(task('a', 'api', { worktreeId: 'gone' }), worktrees)).toBeNull()
    expect(repoLock(task('a', null, { worktreeId: 'w-folder' }), worktrees)).toBeNull()
    expect(repoLock(task('a', 'api'), worktrees)).toBeNull()
  })
})

describe('tracker focus and capture', () => {
  const worktrees = [
    wt('home-root', 'home', 'root'),
    wt('home-linked', 'home', 'linked'),
    wt('api-root', 'api', 'root'),
    wt('solo-root', 'solo', 'root', 'solo'),
    wt('platform-folder', null, 'folder', 'platform')
  ]
  const solo: Project = {
    ...acme,
    id: 'solo',
    name: 'solo',
    homeRepoId: null,
    repoIds: ['solo']
  }
  const platform: Project = {
    ...acme,
    id: 'platform',
    name: 'Platform',
    homeRepoId: null,
    repoIds: ['api', 'web']
  }
  const state = (activeProjectId: string | null, activeWorktreeId: string | null): TaskScopeState => ({
    projects: [acme, solo, platform],
    repos,
    worktrees,
    activeProjectId,
    activeWorktreeId
  })

  it('leads with the session repo, except in the project session', () => {
    expect(trackerFocusRepoId(state('acme', 'home-root'))).toBeNull()
    expect(trackerFocusRepoId(state('acme', 'home-linked'))).toBe('home')
    expect(trackerFocusRepoId(state('acme', 'api-root'))).toBe('api')
    expect(trackerFocusRepoId(state('platform', 'platform-folder'))).toBeNull()
    expect(trackerFocusRepoId(state('solo', 'solo-root'))).toBeNull()
    expect(trackerFocusRepoId(state(null, 'api-root'))).toBeNull()
  })

  it('captures under the focus repo, the sole repo of a single project, or none', () => {
    expect(captureRepoId(state('acme', 'api-root'))).toBe('api')
    expect(captureRepoId(state('acme', 'home-root'))).toBeNull()
    expect(captureRepoId(state('platform', 'platform-folder'))).toBeNull()
    expect(captureRepoId(state('solo', 'solo-root'))).toBe('solo')
    expect(
      captureRepoId({
        ...state('solo', null),
        projects: [{ ...solo, repoIds: [] }]
      })
    ).toBeNull()
    expect(captureRepoId(state(null, null))).toBeNull()
  })
})

describe('worktree targets', () => {
  it('offers the repos in listing order, round-tripping through option values', () => {
    const targets = worktreeTargets(acme, repos)
    expect(targets).toEqual([
      { kind: 'repo', repoId: 'home' },
      { kind: 'repo', repoId: 'api' },
      { kind: 'repo', repoId: 'web' }
    ])
    for (const t of [...targets, { kind: 'project' as const }]) expect(parseTargetValue(targetValue(t))).toEqual(t)
    expect(parseTargetValue('')).toBeNull()
    expect(parseTargetValue('repo:')).toBeNull()
  })

  it('implies the given repo, then the task repo, then the only repo, else asks', () => {
    expect(impliedWorktreeRepoId(repo('web'), task('a', 'api'), acme)).toBe('web')
    expect(impliedWorktreeRepoId(undefined, task('a', 'api'), acme)).toBe('api')
    expect(impliedWorktreeRepoId(undefined, task('a', 'solo'), acme)).toBeNull()
    expect(impliedWorktreeRepoId(undefined, task('a', null), acme)).toBeNull()
    expect(impliedWorktreeRepoId(undefined, task('a', null), { repoIds: ['solo'] })).toBe('solo')
  })
})
