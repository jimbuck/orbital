import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Repo } from '@shared/types'

const projects: Project[] = []
const repos: Repo[] = []
vi.mock('../runtime', () => ({
  tables: {
    projects: { list: () => projects },
    repos: { list: () => repos }
  }
}))
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const {
  eraseCodeWorkspace,
  mergeWorkspace,
  parseJsonc,
  removableWorkspace,
  renderWorkspace,
  resetCodeWorkspaceMemory,
  syncCodeWorkspaces,
  workspaceFileName,
  workspaceTarget,
  writeCodeWorkspace
} = await import('./code-workspace')

const folders = [
  { path: '.', name: 'home' },
  { path: '../api', name: 'api' }
]

describe('workspaceFileName', () => {
  it('slugs the project name', () => {
    expect(workspaceFileName('Acme Platform')).toBe('acme-platform.code-workspace')
    expect(workspaceFileName('  Web/API (v2) ')).toBe('web-api-v2.code-workspace')
    expect(workspaceFileName('???')).toBe('project.code-workspace')
  })
})

describe('workspaceTarget', () => {
  const repo = (id: string, repoPath: string): Repo => ({
    id,
    name: id,
    repoPath,
    defaultAgentId: 'claude',
    addedAt: 0,
    projectId: 'p'
  })
  const all = [repo('home', '/w/home'), repo('api', '/w/api'), repo('web', '/w/web')]
  const project = (over: Partial<Project> = {}): Project => ({
    id: 'p',
    name: 'Acme',
    rootPath: '/w',
    homeRepoId: 'home',
    managedBlock: true,
    codeWorkspace: true,
    repoIds: ['api', 'home', 'web'],
    createdAt: 0,
    ...over
  })

  it('goes in the home repo, home first as ".", then the rest in project order', () => {
    expect(workspaceTarget(project(), all)).toEqual({
      file: join('/w/home', 'acme.code-workspace'),
      folders: [
        { path: '.', name: 'home' },
        { path: '../api', name: 'api' },
        { path: '../web', name: 'web' }
      ]
    })
  })

  it('goes in the root folder when there is no home', () => {
    expect(workspaceTarget(project({ homeRepoId: null }), all)).toEqual({
      file: join('/w', 'acme.code-workspace'),
      folders: [
        { path: 'api', name: 'api' },
        { path: 'home', name: 'home' },
        { path: 'web', name: 'web' }
      ]
    })
  })

  it('has nothing to write for a project with no repos', () => {
    expect(workspaceTarget(project({ repoIds: [], homeRepoId: null }), all)).toBeNull()
  })
})

describe('renderWorkspace', () => {
  it('is 2-space JSON with a trailing newline', () => {
    expect(renderWorkspace(folders)).toBe(
      '{\n  "folders": [\n    {\n      "path": ".",\n      "name": "home"\n    },\n    {\n      "path": "../api",\n      "name": "api"\n    }\n  ]\n}\n'
    )
    expect(renderWorkspace(folders, '\r\n').replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('parseJsonc', () => {
  it('reads comments and trailing commas, and keeps them inside strings', () => {
    expect(parseJsonc('// top\n{ /* a */ "a": "x // y /* z */", "b": [1, 2,], }\n')).toEqual({
      a: 'x // y /* z */',
      b: [1, 2]
    })
    expect(parseJsonc('﻿{"a": "q\\"//"}')).toEqual({ a: 'q"//' })
  })

  it('gives up on what is not JSONC', () => {
    expect(parseJsonc('{ "a": ')).toBeUndefined()
    expect(parseJsonc('{ "a": 1 /* open')).toBeUndefined()
    expect(parseJsonc('{ a: 1 }')).toBeUndefined()
  })
})

describe('mergeWorkspace', () => {
  it('replaces only the folders, keeping every other key, comment and the CRLF', () => {
    const existing = [
      '{',
      '  // my workspace',
      '  "folders": [',
      '    { "path": "old" }, // stale',
      '  ],',
      '  "settings": { "editor.tabSize": 2 },',
      '  "extensions": { "recommendations": ["x"] },',
      '}',
      ''
    ].join('\r\n')
    const merged = mergeWorkspace(existing, folders)!
    expect(merged).toContain('// my workspace')
    expect(merged).toContain('"settings": { "editor.tabSize": 2 },')
    expect(merged).toContain('"extensions": { "recommendations": ["x"] },')
    expect(merged).not.toContain('stale')
    expect(merged.replace(/\r\n/g, '')).not.toContain('\n')
    expect(parseJsonc(merged)).toEqual({
      folders,
      settings: { 'editor.tabSize': 2 },
      extensions: { recommendations: ['x'] }
    })
    expect(merged).toContain('  "folders": [\r\n    {\r\n      "path": ".",')
  })

  it('adds folders to a file without them', () => {
    const merged = mergeWorkspace('{\n  "settings": {}\n}\n', folders)!
    expect(parseJsonc(merged)).toEqual({ folders, settings: {} })
    expect(merged.startsWith('{\n  "folders": [\n')).toBe(true)
    expect(mergeWorkspace('{}\n', folders)).toBe(renderWorkspace(folders))
  })

  it('returns the file itself when the folders already match, however they are formatted', () => {
    const existing = '{ "folders": [{"path": ".", "name": "home"}, {"path": "../api", "name": "api"}], "x": 1 }'
    expect(mergeWorkspace(existing, folders)).toBe(existing)
  })

  it('refuses a file it cannot parse, or one that is not an object', () => {
    expect(mergeWorkspace('{ "folders": [ oops', folders)).toBeNull()
    expect(mergeWorkspace('[1, 2]', folders)).toBeNull()
  })
})

describe('removableWorkspace', () => {
  it('only when the folders are exactly what was written and nothing else is there', () => {
    expect(removableWorkspace(renderWorkspace(folders), folders)).toBe(true)
    expect(removableWorkspace('{ "folders": [] }', folders)).toBe(false)
    expect(removableWorkspace(`{ "folders": ${JSON.stringify(folders)}, "settings": {} }`, folders)).toBe(false)
    expect(removableWorkspace('not json', folders)).toBe(false)
  })
})

describe('files', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbital-ws-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a new file, then leaves it (and its mtime) alone', () => {
    const file = join(dir, 'a.code-workspace')
    expect(writeCodeWorkspace(file, folders)).toBe('written')
    expect(readFileSync(file, 'utf8')).toBe(renderWorkspace(folders))
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(file, past, past)
    expect(writeCodeWorkspace(file, folders)).toBe('unchanged')
    expect(statSync(file).mtimeMs).toBe(past.getTime())
  })

  it('never touches a file it cannot parse', () => {
    const file = join(dir, 'a.code-workspace')
    writeFileSync(file, '{ broken')
    expect(writeCodeWorkspace(file, folders)).toBe('skipped')
    expect(readFileSync(file, 'utf8')).toBe('{ broken')
    expect(eraseCodeWorkspace(file, folders)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  it('erases only an untouched file', () => {
    const file = join(dir, 'a.code-workspace')
    writeCodeWorkspace(file, folders)
    expect(eraseCodeWorkspace(file, folders)).toBe(true)
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, `{ "folders": ${JSON.stringify(folders)}, "settings": {} }`)
    expect(eraseCodeWorkspace(file, folders)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })
})

describe('syncCodeWorkspaces', () => {
  let root = ''
  const repo = (id: string): Repo => {
    const repoPath = join(root, id)
    mkdirSync(repoPath, { recursive: true })
    return {
      id,
      name: id,
      repoPath,
      defaultAgentId: 'claude',
      addedAt: 0,
      projectId: 'p1'
    }
  }
  const project = (over: Partial<Project> = {}): Project => ({
    id: 'p1',
    name: 'Platform',
    rootPath: root,
    homeRepoId: 'home',
    managedBlock: true,
    codeWorkspace: true,
    repoIds: ['home', 'api'],
    createdAt: 0,
    ...over
  })
  const inHome = (): string => join(root, 'home', 'platform.code-workspace')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orbital-ws-sync-'))
    resetCodeWorkspaceMemory()
    repos.splice(0, repos.length, repo('home'), repo('api'))
    projects.splice(0, projects.length)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes nothing while the flag is off', async () => {
    projects.push(project({ codeWorkspace: false }))
    await syncCodeWorkspaces()
    expect(existsSync(inHome())).toBe(false)
  })

  it('writes the file in the home, and removes it when the flag goes off', async () => {
    projects.push(project())
    await syncCodeWorkspaces()
    expect(JSON.parse(readFileSync(inHome(), 'utf8'))).toEqual({ folders })
    projects.splice(0, 1, project({ codeWorkspace: false }))
    await syncCodeWorkspaces()
    expect(existsSync(inHome())).toBe(false)
  })

  it('moves the file on a rename or when the home is cleared', async () => {
    projects.push(project())
    await syncCodeWorkspaces()
    projects.splice(0, 1, project({ name: 'Core' }))
    await syncCodeWorkspaces()
    expect(existsSync(inHome())).toBe(false)
    expect(existsSync(join(root, 'home', 'core.code-workspace'))).toBe(true)
    projects.splice(0, 1, project({ name: 'Core', homeRepoId: null }))
    await syncCodeWorkspaces()
    expect(existsSync(join(root, 'home', 'core.code-workspace'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'core.code-workspace'), 'utf8'))).toEqual({
      folders: [
        { path: 'home', name: 'home' },
        { path: 'api', name: 'api' }
      ]
    })
  })

  it('leaves a file the user has edited in the meantime', async () => {
    projects.push(project())
    await syncCodeWorkspaces()
    writeFileSync(inHome(), `{ "folders": ${JSON.stringify(folders)}, "settings": { "a": 1 } }`)
    projects.splice(0, 1, project({ codeWorkspace: false }))
    await syncCodeWorkspaces()
    expect(existsSync(inHome())).toBe(true)
  })
})
