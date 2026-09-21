import { describe, expect, it } from 'vitest'
import { normalize } from './workspace-yaml'

describe('workspace-yaml normalize — agent settings', () => {
  it('keeps modern agents entries with their launch tweaks', () => {
    const cfg = normalize({
      id: 'ws',
      name: 'Work',
      settings: {
        agents: [
          { provider: 'claude', configDir: 'C:\\profiles\\work', args: ['--verbose'], env: { A: '1' } },
          { provider: 'codex' }
        ]
      },
      projects: []
    })
    expect(cfg.settings?.agents).toEqual([
      {
        id: 'claude',
        name: 'Claude',
        provider: 'claude',
        configDir: 'C:\\profiles\\work',
        args: ['--verbose'],
        env: { A: '1' }
      },
      { id: 'codex', name: 'Codex', provider: 'codex' }
    ])
  })

  it('converts a legacy enabledAgents array from an old export', () => {
    const cfg = normalize({
      id: 'ws',
      name: 'Old',
      settings: { enabledAgents: ['claude', 'cursor'] },
      projects: []
    })
    expect(cfg.settings?.agents).toEqual([
      { id: 'claude', name: 'Claude', provider: 'claude' },
      { id: 'cursor', name: 'Cursor', provider: 'cursor' }
    ])
  })

  it('drops an unusable agents value entirely', () => {
    const cfg = normalize({ id: 'ws', name: 'X', settings: { agents: 'bogus' }, projects: [] })
    expect(cfg.settings).toBeUndefined()
  })
})

describe('workspace-yaml normalize — accent colour', () => {
  it('keeps a valid accent, normalised to lowercase #rrggbb', () => {
    const cfg = normalize({ id: 'ws', name: 'Work', settings: { accentColor: 'F06A8A' }, projects: [] })
    expect(cfg.settings?.accentColor).toBe('#f06a8a')
  })

  it('drops an accent that is not a colour', () => {
    for (const bad of ['red', '#fff', '#12345g', 42, null]) {
      const cfg = normalize({ id: 'ws', name: 'Work', settings: { accentColor: bad, periodicFetch: true }, projects: [] })
      expect(cfg.settings?.accentColor).toBeUndefined()
      expect(cfg.settings?.periodicFetch).toBe(true)
    }
  })
})

describe('workspace-yaml normalize — theme', () => {
  it('keeps a known theme, System, and a pair of the right appearances', () => {
    const settings = { theme: 'system', systemDarkTheme: 'dracula', systemLightTheme: 'github-light' }
    const cfg = normalize({ id: 'ws', name: 'Work', settings, projects: [] })
    expect(cfg.settings).toEqual(settings)
  })

  it('drops an unknown theme and a half of the wrong appearance', () => {
    const cfg = normalize({
      id: 'ws',
      name: 'Work',
      settings: { theme: 'not-a-theme', systemDarkTheme: 'github-light', systemLightTheme: 'nord', periodicFetch: true },
      projects: []
    })
    expect(cfg.settings).toEqual({ periodicFetch: true })
  })
})

describe('workspace-yaml normalize — ligatures', () => {
  it('keeps a boolean and drops anything else', () => {
    expect(normalize({ id: 'ws', name: 'W', settings: { fontLigatures: false }, projects: [] }).settings).toEqual({
      fontLigatures: false
    })
    expect(normalize({ id: 'ws', name: 'W', settings: { fontLigatures: 'no' }, projects: [] }).settings).toBeUndefined()
  })
})
