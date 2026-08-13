import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import type { AgentConfig } from '@shared/types'

/** The Claude profile dir under test; swapped per test to a fresh temp dir. */
let configDir = ''

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))
vi.mock('./profiles', () => ({
  defaultProfileDir: () => configDir,
  agentProfileDir: (a: AgentConfig) => a.configDir ?? configDir
}))

import { install, remove, skillMarkdown, skillPath, status } from './claude-skill'

/** The profile under test. */
let agent: AgentConfig

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'orbital-skill-'))
  agent = { id: 'claude', name: 'Claude', provider: 'claude', configDir }
})
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

/** Split the SKILL.md into its YAML frontmatter and body. */
function frontmatter(md: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(md)
  expect(match, 'SKILL.md must open with a YAML frontmatter block').not.toBeNull()
  return parse(match![1]) as Record<string, unknown>
}

describe('the generated SKILL.md', () => {
  it('has frontmatter Claude Code can parse, with only fields it accepts', () => {
    const fm = frontmatter(skillMarkdown())
    expect(fm.name).toBe('orbital')
    expect(String(fm.description)).toMatch(/orbital/i)
    // Every key must be in the allowed set — an unexpected key is a hard load error.
    const allowed = ['name', 'description', 'allowed-tools', 'metadata', 'license', 'compatibility']
    expect(Object.keys(fm).filter((k) => !allowed.includes(k))).toEqual([])
  })

  it('pre-approves only the read-only and reporting commands', () => {
    const tools = frontmatter(skillMarkdown())['allowed-tools'] as string[]
    expect(tools).toContain('Bash(orbital status *)')
    // Creating worktrees/tabs and deleting tasks should still prompt.
    expect(tools.some((t) => /worktree new|tab new|task delete/.test(t))).toBe(false)
  })
})

describe('install / remove', () => {
  it('writes the skill where Claude looks for a personal skill, and reports it installed', () => {
    expect(status(agent)).toMatchObject({ installed: false, foreign: false })
    const result = install(agent)
    expect(result.installed).toBe(true)
    expect(skillPath(agent)).toBe(join(configDir, 'skills', 'orbital', 'SKILL.md'))
    expect(readFileSync(skillPath(agent), 'utf8')).toBe(skillMarkdown())
  })

  it('is idempotent, and remove takes the whole skill directory with it', () => {
    install(agent)
    install(agent)
    expect(status(agent).installed).toBe(true)
    remove(agent)
    expect(status(agent).installed).toBe(false)
    expect(existsSync(dirname(skillPath(agent)))).toBe(false)
  })

  it('leaves supporting files in the skill directory alone when removing', () => {
    install(agent)
    // A skill directory can hold scripts/references someone added alongside it;
    // uninstalling Orbital's SKILL.md must not take those with it.
    const extra = join(dirname(skillPath(agent)), 'notes.md')
    writeFileSync(extra, 'mine', 'utf8')

    remove(agent)
    expect(existsSync(skillPath(agent))).toBe(false)
    expect(readFileSync(extra, 'utf8')).toBe('mine')
  })

  it('installs into the profile it is given, leaving a sibling profile alone', () => {
    const other: AgentConfig = {
      id: 'claude-2',
      name: 'Claude (personal)',
      provider: 'claude',
      configDir: mkdtempSync(join(tmpdir(), 'orbital-skill-2-'))
    }
    install(agent)

    expect(status(agent).installed).toBe(true)
    expect(status(other).installed).toBe(false)
    expect(existsSync(skillPath(other))).toBe(false)

    rmSync(other.configDir!, { recursive: true, force: true })
  })

  it('refuses to overwrite a SKILL.md it did not write, and leaves it alone', () => {
    mkdirSync(dirname(skillPath(agent)), { recursive: true })
    writeFileSync(skillPath(agent), '---\nname: orbital\n---\nmine, not yours\n', 'utf8')

    expect(status(agent)).toMatchObject({ installed: false, foreign: true })
    expect(() => install(agent)).toThrow(/not written by Orbital/)
    // Both the failed install and a remove must leave the user's file untouched.
    remove(agent)
    expect(readFileSync(skillPath(agent), 'utf8')).toContain('mine, not yours')
  })
})
