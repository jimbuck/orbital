import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildCreateRepoArgs,
  cleanGhError,
  ghEnv,
  github,
  parseLicenses,
  parseRepoList,
  validateCreateRepoOptions
} from './github'

const base = { owner: 'jimbuck', name: 'demo', visibility: 'private' as const }

describe('buildCreateRepoArgs', () => {
  it('always names the repo owner/name and passes the visibility as a flag', () => {
    expect(buildCreateRepoArgs(base)).toEqual(['repo', 'create', 'jimbuck/demo', '--private'])
  })

  it('emits every optional flag gh supports, in --flag=value form', () => {
    expect(
      buildCreateRepoArgs({
        ...base,
        visibility: 'public',
        description: 'A thing',
        homepage: 'https://example.com',
        gitignore: 'Node',
        license: 'mit',
        addReadme: true,
        disableIssues: true,
        disableWiki: true,
        team: 'core'
      })
    ).toEqual([
      'repo',
      'create',
      'jimbuck/demo',
      '--public',
      '--description=A thing',
      '--homepage=https://example.com',
      '--gitignore=Node',
      '--license=mit',
      '--add-readme',
      '--disable-issues',
      '--disable-wiki',
      '--team=core'
    ])
  })

  it('keeps a value that starts with a dash attached to its flag', () => {
    expect(buildCreateRepoArgs({ ...base, description: '-- not a flag' })).toContain('--description=-- not a flag')
  })

  it('drops gitignore / license / README when a template is used, since gh refuses the combination', () => {
    const args = buildCreateRepoArgs({
      ...base,
      template: 'jimbuck/starter',
      includeAllBranches: true,
      gitignore: 'Node',
      license: 'mit',
      addReadme: true
    })
    expect(args).toEqual([
      'repo',
      'create',
      'jimbuck/demo',
      '--private',
      '--template=jimbuck/starter',
      '--include-all-branches'
    ])
  })

  it('ignores blank optional strings', () => {
    expect(buildCreateRepoArgs({ ...base, description: '   ', homepage: '', team: ' ' })).toEqual([
      'repo',
      'create',
      'jimbuck/demo',
      '--private'
    ])
  })
})

describe('validateCreateRepoOptions', () => {
  it('passes a well-formed request', () => {
    expect(validateCreateRepoOptions(base)).toBeNull()
    expect(
      validateCreateRepoOptions({ ...base, template: 'cli/cli', team: 'core-team', homepage: 'https://x.dev' })
    ).toBeNull()
  })

  it('rejects a bad owner, name, visibility, template, team or homepage', () => {
    expect(validateCreateRepoOptions({ ...base, owner: '-x' })).toMatch(/owner/)
    expect(validateCreateRepoOptions({ ...base, name: 'a b' })).toMatch(/Only letters/)
    expect(validateCreateRepoOptions({ ...base, visibility: 'secret' as never })).toMatch(/visibility/)
    expect(validateCreateRepoOptions({ ...base, template: 'no-slash' })).toMatch(/owner\/repository/)
    expect(validateCreateRepoOptions({ ...base, team: 'has space' })).toMatch(/team/)
    expect(validateCreateRepoOptions({ ...base, homepage: 'example.com' })).toMatch(/http/)
  })
})

describe('cleanGhError', () => {
  it('cuts the usage block off a flag error', () => {
    const raw = '.gitignore and license templates are not added when template is provided\r\n\r\nUsage:  gh repo create [<name>] [flags]\r\n\r\nFlags:\r\n  --add-readme'
    expect(cleanGhError(raw)).toBe('.gitignore and license templates are not added when template is provided')
  })

  it('leaves a one-line API error alone', () => {
    expect(cleanGhError('HTTP 404: Not Found (https://api.github.com/users/nope)\n')).toBe(
      'HTTP 404: Not Found (https://api.github.com/users/nope)'
    )
  })
})

describe('parseLicenses', () => {
  it('reads key<TAB>name rows and tolerates blank lines', () => {
    expect(parseLicenses('mit\tMIT License\r\n\napache-2.0\tApache License 2.0\n')).toEqual([
      { key: 'mit', name: 'MIT License' },
      { key: 'apache-2.0', name: 'Apache License 2.0' }
    ])
  })
})

describe('parseRepoList', () => {
  it('normalises nulls and visibility casing and sorts by last push, newest first', () => {
    const json = JSON.stringify([
      {
        name: 'old',
        nameWithOwner: 'me/old',
        description: null,
        visibility: 'PUBLIC',
        url: 'https://github.com/me/old',
        isTemplate: false,
        isArchived: true,
        isEmpty: false,
        pushedAt: '2024-01-01T00:00:00Z'
      },
      {
        name: 'new',
        nameWithOwner: 'me/new',
        description: 'fresh',
        visibility: 'PRIVATE',
        url: 'https://github.com/me/new',
        isTemplate: true,
        isArchived: false,
        isEmpty: true,
        pushedAt: '2026-01-01T00:00:00Z'
      }
    ])
    const list = parseRepoList(json)
    expect(list.map((r) => r.name)).toEqual(['new', 'old'])
    expect(list[0]).toEqual({
      name: 'new',
      nameWithOwner: 'me/new',
      description: 'fresh',
      visibility: 'private',
      url: 'https://github.com/me/new',
      isTemplate: true,
      isArchived: false,
      isEmpty: true,
      pushedAt: '2026-01-01T00:00:00Z'
    })
    expect(list[1].description).toBe('')
    expect(list[1].visibility).toBe('public')
  })
})

describe('ghEnv', () => {
  it('disables every prompt and pager gh could raise', () => {
    const env = ghEnv()
    expect(env.GH_PROMPT_DISABLED).toBe('1')
    expect(env.GH_NO_UPDATE_NOTIFIER).toBe('1')
    expect(env.GH_PAGER).toBe('cat')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.NO_COLOR).toBe('1')
  })
})

describe('resolveCloneTarget', () => {
  let parent: string
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'orbital-gh-'))
  })
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })

  it('returns <parent>/<name> when the target does not exist yet', () => {
    expect(github.resolveCloneTarget(parent, 'demo')).toBe(resolve(join(parent, 'demo')))
  })

  it('accepts an existing empty directory as the target', () => {
    mkdirSync(join(parent, 'empty'))
    expect(github.resolveCloneTarget(parent, 'empty')).toBe(resolve(join(parent, 'empty')))
  })

  it('refuses a missing, relative or blank parent', () => {
    expect(() => github.resolveCloneTarget('', 'demo')).toThrow(/Choose a local folder/)
    expect(() => github.resolveCloneTarget('relative/dir', 'demo')).toThrow(/absolute/)
    expect(() => github.resolveCloneTarget(join(parent, 'nope'), 'demo')).toThrow(/does not exist/)
  })

  it('refuses a non-empty directory or a file at the target', () => {
    mkdirSync(join(parent, 'full'))
    writeFileSync(join(parent, 'full', 'x.txt'), 'x')
    writeFileSync(join(parent, 'file'), 'x')
    expect(() => github.resolveCloneTarget(parent, 'full')).toThrow(/not empty/)
    expect(() => github.resolveCloneTarget(parent, 'file')).toThrow(/file already exists/)
  })

  it('refuses a folder name that is not a valid repository name (no path escapes)', () => {
    expect(() => github.resolveCloneTarget(parent, '../up')).toThrow(/Only letters/)
    expect(() => github.resolveCloneTarget(parent, '..')).toThrow(/only periods/)
  })
})
