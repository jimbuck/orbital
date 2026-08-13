import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from '@shared/types'

/** Root holding all the profile dirs a test uses. */
let root = ''
/** The Claude profile the workspace under test launches agents with. */
let workspaceDir = ''
/** A SECOND Claude profile in the same workspace — installs must not leak into it. */
let otherDir = ''
/** The machine default (`CLAUDE_CONFIG_DIR` / ~/.claude) — deliberately a DIFFERENT dir. */
let machineDir = ''

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:\\app' } }))
vi.mock('./paths', () => ({ hookShimPath: () => 'C:\\Orbital\\resources\\cli\\orbital.cmd' }))
vi.mock('./profiles', () => ({
  defaultProfileDir: () => machineDir,
  agentProfileDir: (agent: AgentConfig) => agent.configDir ?? machineDir
}))

import { install, plan, remove, settingsPath, status } from './claude-hooks'

/** The profile under test, and a sibling profile of the same provider. */
let agent: AgentConfig
let other: AgentConfig

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orbital-hooks-'))
  workspaceDir = join(root, 'work-profile')
  otherDir = join(root, 'personal-profile')
  machineDir = join(root, 'default-profile')
  for (const dir of [workspaceDir, otherDir, machineDir]) mkdirSync(dir, { recursive: true })
  agent = { id: 'claude', name: 'Claude (work)', provider: 'claude', configDir: workspaceDir }
  other = { id: 'claude-2', name: 'Claude (personal)', provider: 'claude', configDir: otherDir }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function readSettings(dir: string): Record<string, never> & { hooks?: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
}

describe('which settings.json the hooks target', () => {
  it("uses the profile's own directory, not the machine default", () => {
    expect(settingsPath(agent)).toBe(join(workspaceDir, 'settings.json'))
    expect(plan(agent).settingsPath).toBe(join(workspaceDir, 'settings.json'))

    install(agent)
    expect(status(agent)).toMatchObject({ installed: true, settingsPath: join(workspaceDir, 'settings.json') })
    // The dir Orbital's own process defaults to must be left completely alone —
    // writing there is exactly the bug this guards against.
    expect(() => readSettings(machineDir)).toThrow()
  })

  it('reports not-installed when only the machine default carries the hooks', () => {
    // The state a profile-using workspace was in before the fix: hooks exist, but
    // in a file the workspace's agents never read.
    writeFileSync(
      join(machineDir, 'settings.json'),
      JSON.stringify({
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'x hook Stop --orbital-managed' }] }] }
      }),
      'utf8'
    )
    expect(status(agent).installed).toBe(false)
  })

  it('installs per profile: a sibling Claude profile is untouched', () => {
    install(agent)

    expect(status(agent).installed).toBe(true)
    expect(status(other).installed).toBe(false)
    expect(() => readSettings(otherDir)).toThrow()

    // …and each profile uninstalls on its own.
    install(other)
    remove(agent)
    expect(status(agent).installed).toBe(false)
    expect(status(other).installed).toBe(true)
  })
})

describe('merge and uninstall', () => {
  it('preserves hooks it did not write, and is idempotent', () => {
    const mine = { matcher: '', hooks: [{ type: 'command', command: 'my-own-script.sh' }] }
    writeFileSync(
      join(workspaceDir, 'settings.json'),
      JSON.stringify({ model: 'opus', hooks: { Stop: [mine] } }),
      'utf8'
    )

    install(agent)
    install(agent)

    const after = readSettings(workspaceDir)
    expect(after.model).toBe('opus')
    expect(after.hooks!.Stop).toHaveLength(2) // the user's, plus exactly one of ours
    expect(after.hooks!.Stop[0]).toEqual(mine)

    remove(agent)
    const cleaned = readSettings(workspaceDir)
    expect(cleaned.hooks!.Stop).toEqual([mine])
    expect(cleaned.model).toBe('opus')
    expect(status(agent).installed).toBe(false)
  })

  it('refuses to touch a settings.json that exists but does not parse', () => {
    writeFileSync(join(workspaceDir, 'settings.json'), '{ not json', 'utf8')
    expect(() => install(agent)).toThrow(/not valid JSON/)
    expect(readFileSync(join(workspaceDir, 'settings.json'), 'utf8')).toBe('{ not json')
    // A read-only status check must not throw on the same file.
    expect(status(agent).installed).toBe(false)
  })
})
