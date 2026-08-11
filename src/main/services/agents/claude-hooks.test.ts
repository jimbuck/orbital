import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The Claude profile dir the workspace under test launches agents against. */
let workspaceDir = ''
/** The machine default (`CLAUDE_CONFIG_DIR` / ~/.claude) — deliberately a DIFFERENT dir. */
let machineDir = ''

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:\\app' } }))
vi.mock('./paths', () => ({ hookShimPath: () => 'C:\\Orbital\\resources\\cli\\orbital.cmd' }))
vi.mock('./profiles', () => ({
  defaultProfileDir: () => machineDir,
  agentProfileDir: () => workspaceDir
}))

import { install, plan, remove, settingsPath, status } from './claude-hooks'

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'orbital-hooks-'))
  workspaceDir = join(root, 'work-profile')
  machineDir = join(root, 'default-profile')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(machineDir, { recursive: true })
})
afterEach(() => {
  rmSync(join(workspaceDir, '..'), { recursive: true, force: true })
})

function readSettings(dir: string): Record<string, never> & { hooks?: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
}

describe('which settings.json the hooks target', () => {
  it("uses the workspace's Claude profile, not the machine default", () => {
    expect(settingsPath()).toBe(join(workspaceDir, 'settings.json'))
    expect(plan().settingsPath).toBe(join(workspaceDir, 'settings.json'))

    install()
    expect(status()).toMatchObject({ installed: true, settingsPath: join(workspaceDir, 'settings.json') })
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
    expect(status().installed).toBe(false)
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

    install()
    install()

    const after = readSettings(workspaceDir)
    expect(after.model).toBe('opus')
    expect(after.hooks!.Stop).toHaveLength(2) // the user's, plus exactly one of ours
    expect(after.hooks!.Stop[0]).toEqual(mine)

    remove()
    const cleaned = readSettings(workspaceDir)
    expect(cleaned.hooks!.Stop).toEqual([mine])
    expect(cleaned.model).toBe('opus')
    expect(status().installed).toBe(false)
  })

  it('refuses to touch a settings.json that exists but does not parse', () => {
    writeFileSync(join(workspaceDir, 'settings.json'), '{ not json', 'utf8')
    expect(() => install()).toThrow(/not valid JSON/)
    expect(readFileSync(join(workspaceDir, 'settings.json'), 'utf8')).toBe('{ not json')
    // A read-only status check must not throw on the same file.
    expect(status().installed).toBe(false)
  })
})
