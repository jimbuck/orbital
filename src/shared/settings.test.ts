import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, WORKSPACE_SETTING_KEYS, parseSettings, resolveSettings } from './settings'
import { DEFAULT_ENV_SYNC_PATTERNS } from './types'

describe('the settings schema', () => {
  it('declares a default for every key, and resolves to exactly those when nothing is stored', () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([...WORKSPACE_SETTING_KEYS].sort())
    expect(resolveSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toMatchObject({
      theme: 'dark',
      systemDarkTheme: 'dark',
      systemLightTheme: 'light',
      fontLigatures: true,
      periodicFetch: true,
      debugLogging: false,
      defaultOpenAction: 'right',
      accentColor: null,
      worktreeBranchPrefix: 'feature/',
      envSyncPatterns: DEFAULT_ENV_SYNC_PATTERNS,
      alerts: { indicator: true, sound: true, taskbarBadge: true, taskbarFlash: true }
    })
  })
})

describe('resolveSettings', () => {
  it('takes a usable stored value over the default', () => {
    const s = resolveSettings({ periodicFetch: false, defaultShell: 'pwsh.exe', accentColor: 'F06A8A', theme: 'system' })
    expect(s).toMatchObject({ periodicFetch: false, defaultShell: 'pwsh.exe', accentColor: '#f06a8a', theme: 'system' })
  })

  it('skips a stored value of the wrong shape, for every key, instead of handing it out', () => {
    const garbage = Object.fromEntries(WORKSPACE_SETTING_KEYS.map((key) => [key, { not: 'a setting' }]))
    expect(resolveSettings(garbage)).toEqual(DEFAULT_SETTINGS)
    // The scalars that used to pass straight through when hand-edited:
    expect(
      resolveSettings({ fontLigatures: 'no', periodicFetch: 1, debugLogging: 'yes', defaultShell: 3, envSyncPatterns: [1] })
    ).toEqual(DEFAULT_SETTINGS)
  })

  it('never lets a key the schema does not declare through', () => {
    expect(resolveSettings({ bogus: 1, zoomLevel: 2, theme: 'system' })).not.toHaveProperty('bogus')
    expect(Object.keys(resolveSettings({ bogus: 1 })).sort()).toEqual([...WORKSPACE_SETTING_KEYS].sort())
  })

  it('reads a formerly-global key from the legacy blob until the workspace sets its own', () => {
    const legacy = { defaultShell: 'bash.exe', fontLigatures: false, theme: 'light', debugLogging: true }
    expect(resolveSettings({}, legacy)).toMatchObject(legacy)
    expect(resolveSettings({ defaultShell: 'pwsh.exe', fontLigatures: true }, legacy)).toMatchObject({
      defaultShell: 'pwsh.exe',
      fontLigatures: true,
      theme: 'light'
    })
  })

  it('does not read an always-workspace key from the legacy blob', () => {
    const legacy = { envSyncPatterns: ['old/**'], periodicFetch: false, accentColor: '#112233', externalEditor: 'subl' }
    expect(resolveSettings({}, legacy)).toEqual(DEFAULT_SETTINGS)
  })

  it('lets a legacy value show through a workspace value that is not usable', () => {
    expect(resolveSettings({ theme: 'not-a-theme' }, { theme: 'light' }).theme).toBe('light')
    expect(resolveSettings({ theme: 'not-a-theme' }, {}).theme).toBe('dark')
  })

  it('merges alert toggles by toggle, so one written before a toggle existed keeps the new default', () => {
    expect(resolveSettings({ alerts: { sound: false } }).alerts).toEqual({
      indicator: true,
      sound: false,
      taskbarBadge: true,
      taskbarFlash: true
    })
    expect(resolveSettings({ alerts: { sound: false } }, { alerts: { taskbarBadge: false, sound: true } }).alerts).toEqual(
      { indicator: true, sound: false, taskbarBadge: false, taskbarFlash: true }
    )
    expect(resolveSettings({ alerts: { sound: 'loud', extra: true } }).alerts).toEqual(DEFAULT_SETTINGS.alerts)
  })

  it('requires each half of the system pair to name a theme of its own appearance', () => {
    const s = resolveSettings({ systemDarkTheme: 'github-light', systemLightTheme: 'github-light' })
    expect(s.systemDarkTheme).toBe('dark')
    expect(s.systemLightTheme).toBe('github-light')
  })

  it('reads the worktree branch prefix as a branch name can carry it, and an empty one as no prefix', () => {
    expect(resolveSettings({ worktreeBranchPrefix: 'jb-' }).worktreeBranchPrefix).toBe('jb-')
    // Hand-edited: held to a branch name's characters rather than trusted.
    expect(resolveSettings({ worktreeBranchPrefix: ' /My Team// ' }).worktreeBranchPrefix).toBe('my-team/')
    // Empty is a choice (no prefix), so the default does not show through it.
    expect(resolveSettings({ worktreeBranchPrefix: '' }).worktreeBranchPrefix).toBe('')
    expect(resolveSettings({ worktreeBranchPrefix: 7 }).worktreeBranchPrefix).toBe('feature/')
  })

  it('converts a legacy enabledAgents list when the row has no agents of its own', () => {
    const agents = resolveSettings({ enabledAgents: ['claude'] }).agents
    expect(agents.map((a) => a.provider)).toEqual(['claude'])
    expect(resolveSettings({ agents: 'bogus' }).agents).toEqual(DEFAULT_SETTINGS.agents)
  })
})

describe('parseSettings', () => {
  it('keeps the usable fields and drops the rest', () => {
    expect(
      parseSettings({ periodicFetch: false, fontLigatures: 'no', theme: 'not-a-theme', accentColor: 'F06A8A', bogus: 1 })
    ).toEqual({ periodicFetch: false, accentColor: '#f06a8a' })
  })

  it('keeps only the alert toggles that are booleans', () => {
    expect(parseSettings({ alerts: { sound: false, indicator: 'yes', bogus: true } })).toEqual({ alerts: { sound: false } })
  })

  it('is undefined when nothing is usable, or the input is not an object', () => {
    expect(parseSettings({ defaultShell: 3, alerts: { sound: 'no' } })).toBeUndefined()
    expect(parseSettings({})).toBeUndefined()
    expect(parseSettings(null)).toBeUndefined()
    expect(parseSettings('settings')).toBeUndefined()
    expect(parseSettings([])).toBeUndefined()
  })
})
