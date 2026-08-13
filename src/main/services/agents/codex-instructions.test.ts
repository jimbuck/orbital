import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from '@shared/types'

/** The Codex profile dir under test; swapped per test to a fresh temp dir. */
let profileDir = ''

vi.mock('./profiles', () => ({
  defaultProfileDir: () => profileDir,
  agentProfileDir: (a: AgentConfig) => a.configDir ?? profileDir
}))

import { install, instructionsPath, remove, status } from './codex-instructions'

/** The profile under test. */
let agent: AgentConfig

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'orbital-codex-'))
  agent = { id: 'codex', name: 'Codex', provider: 'codex', configDir: profileDir }
})
afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

const read = (): string => readFileSync(instructionsPath(agent), 'utf8')

describe('a profile with no AGENTS.md', () => {
  it('creates one holding just Orbital’s block, and removes the file again', () => {
    expect(status(agent)).toMatchObject({ installed: false, path: join(profileDir, 'AGENTS.md') })

    install(agent)
    expect(status(agent).installed).toBe(true)
    expect(read()).toContain('orbital whoami')

    remove(agent)
    expect(status(agent).installed).toBe(false)
    // Orbital created the file, so nothing of the user's is lost by deleting it.
    expect(existsSync(instructionsPath(agent))).toBe(false)
  })

  it('installs into the profile it is given, leaving a sibling profile alone', () => {
    const other: AgentConfig = {
      id: 'codex-2',
      name: 'Codex (work)',
      provider: 'codex',
      configDir: mkdtempSync(join(tmpdir(), 'orbital-codex-2-'))
    }
    install(agent)

    expect(status(agent).installed).toBe(true)
    expect(status(other).installed).toBe(false)
    expect(existsSync(instructionsPath(other))).toBe(false)

    rmSync(other.configDir!, { recursive: true, force: true })
  })
})

describe("a profile with the user's own AGENTS.md", () => {
  const mine = '# My instructions\n\nAlways write tests first.\n'

  beforeEach(() => writeFileSync(instructionsPath(agent), mine, 'utf8'))

  it('appends the block without disturbing what is already there', () => {
    install(agent)
    const after = read()
    expect(after.startsWith('# My instructions')).toBe(true)
    expect(after).toContain('Always write tests first.')
    expect(after).toContain('## Orbital cockpit')
  })

  it('is idempotent — a second install refreshes the block rather than stacking it', () => {
    install(agent)
    install(agent)
    install(agent)
    expect(read().match(/## Orbital cockpit/g)).toHaveLength(1)
  })

  it('removes only its own block and keeps the file', () => {
    install(agent)
    remove(agent)
    expect(read()).toBe(mine)
    expect(status(agent).installed).toBe(false)
  })

  it('survives a hand-deleted end marker without eating the rest of the file', () => {
    install(agent)
    writeFileSync(instructionsPath(agent), read().replace('<!-- orbital:end -->', ''), 'utf8')
    remove(agent)
    // The stray body text is left behind (we cannot tell where it ended), but the
    // user's own content above it must still be intact.
    expect(read()).toContain('Always write tests first.')
    expect(status(agent).installed).toBe(false)
  })
})
