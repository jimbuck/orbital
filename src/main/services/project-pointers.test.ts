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
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const {
  BLOCK_END,
  BLOCK_START,
  erasePointers,
  importsOnlyAgents,
  removeBlock,
  renderBlock,
  resetPointerMemory,
  syncProjectPointers,
  targetFile,
  upsertBlock,
  writePointers
} = await import('./project-pointers')

const entries = [
  { name: 'api', path: '../api', remote: 'git@github.com:acme/api.git', steering: 'AGENTS.md' },
  { name: 'web', path: '../web', remote: null, steering: null }
]
const block = (eol = '\n'): string => renderBlock(entries).join(eol)

describe('renderBlock', () => {
  it('lists each repo with only the clauses that apply', () => {
    expect(renderBlock(entries)).toEqual([
      BLOCK_START,
      '## Repos in this project',
      '',
      '<!-- Managed by Orbital: edits inside this block are overwritten. Turn it off per project in Orbital. -->',
      '',
      '- api: ../api. Clone from git@github.com:acme/api.git if missing. Read its AGENTS.md before changing it.',
      '- web: ../web.',
      BLOCK_END
    ])
  })
})

describe('upsertBlock / removeBlock', () => {
  it('writes the block alone into an empty file', () => {
    expect(upsertBlock('', renderBlock(entries))).toBe(block() + '\n')
  })

  it('appends after one blank line, and removing it restores the file byte for byte', () => {
    const original = '# Home\n\nShared rules.\n'
    const withBlock = upsertBlock(original, renderBlock(entries))!
    expect(withBlock).toBe(`${original}\n${block()}\n`)
    expect(removeBlock(withBlock)).toBe(original)
  })

  it('adds the missing line ending before the blank line when the file has none', () => {
    expect(upsertBlock('# Home', renderBlock(entries))).toBe(`# Home\n\n${block()}\n`)
  })

  it('keeps CRLF files CRLF, and the round trip exact', () => {
    const original = '# Home\r\n\r\nShared rules.\r\n'
    const withBlock = upsertBlock(original, renderBlock(entries))!
    expect(withBlock).toBe(`${original}\r\n${block('\r\n')}\r\n`)
    expect(withBlock.replace(/\r\n/g, '')).not.toContain('\n')
    expect(removeBlock(withBlock)).toBe(original)
  })

  it('replaces the block in place and leaves the text around it alone', () => {
    const before = `intro\n\n${BLOCK_START}\nold stuff\n${BLOCK_END}\n\n## After\nmore\n`
    const after = upsertBlock(before, renderBlock(entries))!
    expect(after).toBe(`intro\n\n${block()}\n\n## After\nmore\n`)
    expect(removeBlock(after)).toBe('intro\n\n## After\nmore\n')
  })

  it('is a no-op when the block is already current', () => {
    const current = `# Home\n\n${block()}\n`
    expect(upsertBlock(current, renderBlock(entries))).toBe(current)
  })

  it('refuses a block with no end marker rather than guess, and removal leaves it', () => {
    const broken = `# Home\n\n${BLOCK_START}\n- api: ../api.\n## Rules\n`
    expect(upsertBlock(broken, renderBlock(entries))).toBeNull()
    expect(removeBlock(broken)).toBe(broken)
  })

  it('removal without a block changes nothing', () => {
    expect(removeBlock('# Home\n')).toBe('# Home\n')
  })
})

describe('importsOnlyAgents', () => {
  it('spots a CLAUDE.md that only imports AGENTS.md', () => {
    expect(importsOnlyAgents('@AGENTS.md\n')).toBe(true)
    expect(importsOnlyAgents('\r\n@./AGENTS.md\r\n\r\n')).toBe(true)
    expect(importsOnlyAgents('@AGENTS.md\n\nAlso: run the tests.\n')).toBe(false)
    expect(importsOnlyAgents('')).toBe(false)
  })
})

describe('files in the home repo', () => {
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbital-pointers-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })
  const at = (name: string): string => join(home, name)

  it('creates AGENTS.md when the home has neither file', () => {
    expect(targetFile(home)).toBe(at('AGENTS.md'))
    expect(writePointers(home, entries)).toBe(at('AGENTS.md'))
    expect(readFileSync(at('AGENTS.md'), 'utf8')).toBe(block() + '\n')
  })

  it('prefers AGENTS.md, then a CLAUDE.md with content of its own', () => {
    writeFileSync(at('CLAUDE.md'), '# Rules\n')
    expect(targetFile(home)).toBe(at('CLAUDE.md'))
    writeFileSync(at('AGENTS.md'), '# Agents\n')
    expect(targetFile(home)).toBe(at('AGENTS.md'))
  })

  it('writes AGENTS.md, not a CLAUDE.md that only imports it', () => {
    writeFileSync(at('CLAUDE.md'), '@AGENTS.md\n')
    writePointers(home, entries)
    expect(readFileSync(at('CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    expect(readFileSync(at('AGENTS.md'), 'utf8')).toContain(BLOCK_START)
  })

  it('keeps the block in the file that already holds it', () => {
    writeFileSync(at('CLAUDE.md'), `# Rules\n\n${block()}\n`)
    writeFileSync(at('AGENTS.md'), '# Agents\n')
    expect(targetFile(home)).toBe(at('CLAUDE.md'))
  })

  it('does not rewrite (or touch the mtime of) an unchanged file', () => {
    writeFileSync(at('AGENTS.md'), `# Agents\n\n${block()}\n`)
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(at('AGENTS.md'), past, past)
    expect(writePointers(home, entries)).toBeNull()
    expect(statSync(at('AGENTS.md')).mtimeMs).toBe(past.getTime())
  })

  it('erases the block and deletes a file that held nothing else', () => {
    writePointers(home, entries)
    expect(erasePointers(home)).toEqual([at('AGENTS.md')])
    expect(existsSync(at('AGENTS.md'))).toBe(false)
  })

  it('erases only the block from a file with other content', () => {
    writeFileSync(at('AGENTS.md'), '# Agents\r\n')
    writePointers(home, entries)
    erasePointers(home)
    expect(readFileSync(at('AGENTS.md'), 'utf8')).toBe('# Agents\r\n')
  })
})

describe('syncProjectPointers', () => {
  let root = ''
  const repo = (id: string, name: string): Repo => {
    const repoPath = join(root, name)
    mkdirSync(repoPath, { recursive: true })
    return { id, name, repoPath, defaultAgentId: 'claude', addedAt: 0, projectId: 'p1' }
  }
  const project = (over: Partial<Project> = {}): Project => ({
    id: 'p1',
    name: 'Platform',
    rootPath: root,
    homeRepoId: 'r-home',
    managedBlock: true,
    repoIds: ['r-home', 'r-api'],
    createdAt: 0,
    ...over
  })
  const agentsMd = (name: string): string => join(root, name, 'AGENTS.md')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orbital-sync-'))
    resetPointerMemory()
    repos.splice(0, repos.length, repo('r-home', 'home'), repo('r-api', 'api'))
    projects.splice(0, projects.length)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the home block, and removes it when the flag goes off', async () => {
    projects.push(project())
    await syncProjectPointers()
    expect(readFileSync(agentsMd('home'), 'utf8')).toContain('- api: ../api.')
    projects.splice(0, 1, project({ managedBlock: false }))
    await syncProjectPointers()
    expect(existsSync(agentsMd('home'))).toBe(false)
  })

  it('removes the block from the OLD home when the home moves or is cleared', async () => {
    projects.push(project())
    await syncProjectPointers()
    projects.splice(0, 1, project({ homeRepoId: 'r-api' }))
    await syncProjectPointers()
    expect(existsSync(agentsMd('home'))).toBe(false)
    expect(readFileSync(agentsMd('api'), 'utf8')).toContain('- home: ../home.')
    projects.splice(0, 1, project({ homeRepoId: null }))
    await syncProjectPointers()
    expect(existsSync(agentsMd('api'))).toBe(false)
  })

  it('writes nothing for a home with no other repo to list', async () => {
    projects.push(project({ repoIds: ['r-home'] }))
    await syncProjectPointers()
    expect(existsSync(agentsMd('home'))).toBe(false)
  })
})
