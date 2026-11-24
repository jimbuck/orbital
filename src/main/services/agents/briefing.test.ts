import { describe, expect, it, vi } from 'vitest'
import type { Project, Repo, Worktree } from '@shared/types'
import type { ProjectMap } from '../project-map'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('../runtime', () => ({ tables: {} }))

const { briefingText } = await import('./briefing')
const { sessionRole } = await import('../project-map')

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
const repos = [home, api]
const project: Project = {
  id: 'p1',
  name: 'Platform',
  rootPath: 'C:\\work',
  homeRepoId: null,
  managedBlock: true,
  codeWorkspace: false,
  repoIds: ['home', 'api'],
  createdAt: 0
}
const wt = (kind: Worktree['kind'], repoId: string | null, path: string): Worktree =>
  ({ id: `w-${kind}`, kind, repoId, projectId: 'p1', path, name: kind === 'folder' ? 'Platform' : 'main', branch: kind === 'folder' ? '' : 'main' }) as Worktree

const map: ProjectMap = {
  id: 'p1',
  name: 'Platform',
  rootPath: 'C:\\work',
  home: null,
  repos: [
    {
      id: 'home',
      name: 'home',
      path: home.repoPath,
      relPath: 'home',
      remote: null,
      branch: 'main',
      dirty: false,
      home: false,
      current: false,
      worktrees: [],
      openTasks: 0,
      steering: [],
      folder: null
    },
    {
      id: 'api',
      name: 'api',
      path: api.repoPath,
      relPath: 'api',
      remote: 'git@github.com:acme/api.git',
      branch: 'main',
      dirty: true,
      home: false,
      current: false,
      worktrees: [{ name: 'health', branch: 'feat/health', path: 'C:\\wt\\api-health', task: 7 }],
      openTasks: 2,
      steering: ['AGENTS.md'],
      folder: 'Services/Core'
    }
  ],
  openTasks: 3
}

describe('briefingText', () => {
  it('has no project section for a plain repo', () => {
    const text = briefingText({ repo: api, worktree: wt('root', 'api', api.repoPath), tabId: 't', hooksInstalled: true })
    expect(text).not.toContain('Project "')
    expect(text).toContain('- Repo: api')
  })

  it('maps every repo for the folder session, with the fan-out commands', () => {
    const worktree = wt('folder', null, 'C:\\work')
    const role = sessionRole(worktree, project, repos)!
    const text = briefingText({
      repo: { ...api, id: '', name: 'Platform', repoPath: 'C:\\work' },
      worktree,
      tabId: 't',
      hooksInstalled: true,
      project: { role, map, addDirs: [home.repoPath, api.repoPath] }
    })
    expect(text).toContain('- Project: Platform (its folder session')
    expect(text).not.toContain('- Branch:')
    expect(text).toContain("This session runs in the project's root folder (C:\\work); the project has no home repo.")
    expect(text).toContain('- api: C:\\work\\api (api/ in the project root)')
    expect(text).toContain('remote git@github.com:acme/api.git; root checkout on branch main, uncommitted changes; 2 open tasks')
    expect(text).toContain('worktree health (feat/health) at C:\\wt\\api-health, task #7')
    expect(text).toContain('Has AGENTS.md: read it before changing this repo.')
    expect(text).toContain('They are added to this session')
    expect(text).toContain('orbital tab new agent --repo <name>')
    expect(text).toContain('Worktree commands need `--repo <name>` here')
    expect(text).toContain('- Filed under no repo (work that spans the project): 3 open tasks.')
    expect(text).toContain('`orbital task add "<title>" [--repo <name>]` — file work for the whole project')
  })

  it('points a member repo at its home and siblings', () => {
    const withHome = { ...project, homeRepoId: 'home', repoIds: ['home', 'api', 'web'] }
    const web = repo('web', 'C:\\work\\web')
    const worktree = wt('root', 'api', api.repoPath)
    const role = sessionRole(worktree, withHome, [...repos, web])!
    const text = briefingText({
      repo: api,
      worktree,
      tabId: 't',
      hooksInstalled: true,
      project: { role, map: null, addDirs: [home.repoPath] }
    })
    expect(text).toContain('Project "Platform": this repo is one of 3 in it')
    expect(text).toContain('- Home repo: home at C:\\work\\home.')
    expect(text).toContain('its AGENTS.md / CLAUDE.md and skills are loaded')
    expect(text).toContain('  - web: C:\\work\\web')
    expect(text).not.toContain('  - home:')
    expect(text).toContain('better planned from the project session')
  })
})
