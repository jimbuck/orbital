import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The Codex profile dir under test; swapped per test to a fresh temp dir. */
let profileDir = ''

vi.mock('./profiles', () => ({
  defaultProfileDir: () => profileDir,
  agentProfileDir: () => profileDir
}))

import { install, instructionsPath, remove, status } from './codex-instructions'

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'orbital-codex-'))
})
afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

const read = (): string => readFileSync(instructionsPath(), 'utf8')

describe('a profile with no AGENTS.md', () => {
  it('creates one holding just Orbital’s block, and removes the file again', () => {
    expect(status()).toMatchObject({ installed: false, path: join(profileDir, 'AGENTS.md') })

    install()
    expect(status().installed).toBe(true)
    expect(read()).toContain('orbital whoami')

    remove()
    expect(status().installed).toBe(false)
    // Orbital created the file, so nothing of the user's is lost by deleting it.
    expect(existsSync(instructionsPath())).toBe(false)
  })
})

describe("a profile with the user's own AGENTS.md", () => {
  const mine = '# My instructions\n\nAlways write tests first.\n'

  beforeEach(() => writeFileSync(instructionsPath(), mine, 'utf8'))

  it('appends the block without disturbing what is already there', () => {
    install()
    const after = read()
    expect(after.startsWith('# My instructions')).toBe(true)
    expect(after).toContain('Always write tests first.')
    expect(after).toContain('## Orbital cockpit')
  })

  it('is idempotent — a second install refreshes the block rather than stacking it', () => {
    install()
    install()
    install()
    expect(read().match(/## Orbital cockpit/g)).toHaveLength(1)
  })

  it('removes only its own block and keeps the file', () => {
    install()
    remove()
    expect(read()).toBe(mine)
    expect(status().installed).toBe(false)
  })

  it('survives a hand-deleted end marker without eating the rest of the file', () => {
    install()
    writeFileSync(instructionsPath(), read().replace('<!-- orbital:end -->', ''), 'utf8')
    remove()
    // The stray body text is left behind (we cannot tell where it ended), but the
    // user's own content above it must still be intact.
    expect(read()).toContain('Always write tests first.')
    expect(status().installed).toBe(false)
  })
})
