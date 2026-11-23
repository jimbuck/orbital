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
      repos: []
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
      repos: []
    })
    expect(cfg.settings?.agents).toEqual([
      { id: 'claude', name: 'Claude', provider: 'claude' },
      { id: 'cursor', name: 'Cursor', provider: 'cursor' }
    ])
  })

  it('drops an unusable agents value entirely', () => {
    const cfg = normalize({ id: 'ws', name: 'X', settings: { agents: 'bogus' }, repos: [] })
    expect(cfg.settings).toBeUndefined()
  })
})

describe('workspace-yaml normalize — accent colour', () => {
  it('keeps a valid accent, normalised to lowercase #rrggbb', () => {
    const cfg = normalize({ id: 'ws', name: 'Work', settings: { accentColor: 'F06A8A' }, repos: [] })
    expect(cfg.settings?.accentColor).toBe('#f06a8a')
  })

  it('drops an accent that is not a colour', () => {
    for (const bad of ['red', '#fff', '#12345g', 42, null]) {
      const cfg = normalize({ id: 'ws', name: 'Work', settings: { accentColor: bad, periodicFetch: true }, repos: [] })
      expect(cfg.settings?.accentColor).toBeUndefined()
      expect(cfg.settings?.periodicFetch).toBe(true)
    }
  })
})

describe('workspace-yaml normalize — theme', () => {
  it('keeps a known theme, System, and a pair of the right appearances', () => {
    const settings = { theme: 'system', systemDarkTheme: 'dracula', systemLightTheme: 'github-light' }
    const cfg = normalize({ id: 'ws', name: 'Work', settings, repos: [] })
    expect(cfg.settings).toEqual(settings)
  })

  it('drops an unknown theme and a half of the wrong appearance', () => {
    const cfg = normalize({
      id: 'ws',
      name: 'Work',
      settings: { theme: 'not-a-theme', systemDarkTheme: 'github-light', systemLightTheme: 'nord', periodicFetch: true },
      repos: []
    })
    expect(cfg.settings).toEqual({ periodicFetch: true })
  })
})

describe('workspace-yaml normalize — ligatures', () => {
  it('keeps a boolean and drops anything else', () => {
    expect(normalize({ id: 'ws', name: 'W', settings: { fontLigatures: false }, repos: [] }).settings).toEqual({
      fontLigatures: false
    })
    expect(normalize({ id: 'ws', name: 'W', settings: { fontLigatures: 'no' }, repos: [] }).settings).toBeUndefined()
  })
})

describe('workspace-yaml normalize — shell, logging, open action, alerts', () => {
  it('keeps well-typed values', () => {
    const settings = {
      defaultShell: 'pwsh.exe',
      debugLogging: true,
      defaultOpenAction: 'left',
      alerts: { sound: false, taskbarFlash: true }
    }
    expect(normalize({ id: 'ws', name: 'W', settings, repos: [] }).settings).toEqual(settings)
  })

  it('drops badly-typed values and unknown alert toggles', () => {
    const cfg = normalize({
      id: 'ws',
      name: 'W',
      settings: { defaultShell: 3, debugLogging: 'yes', defaultOpenAction: 'sideways', alerts: { sound: 'no', bogus: true } },
      repos: []
    })
    expect(cfg.settings).toBeUndefined()
  })
})

describe('workspace-yaml normalize — projects', () => {
  const repos = [
    { id: 'a', name: 'api', path: 'C:/src/acme/api' },
    { id: 'b', name: 'web', path: 'C:/src/acme/web' },
    { id: 'c', name: 'docs', path: 'C:/src/docs' }
  ]

  it('keeps the grouping beside the repos list', () => {
    const cfg = normalize({
      id: 'ws',
      name: 'Work',
      repos,
      projects: [{ id: 'p', name: 'Acme', root: 'C:/src/acme', home: 'a', repos: ['a', 'b'] }]
    })
    expect(cfg.repos.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(cfg.projects).toEqual([{ id: 'p', name: 'Acme', root: 'C:/src/acme', home: 'a', repos: ['a', 'b'] }])
  })

  it('drops unknown and already-claimed members, a home that is not a member, and empty projects', () => {
    const cfg = normalize({
      id: 'ws',
      name: 'Work',
      repos,
      projects: [
        { id: 'p', root: 'C:/src/acme', home: 'c', repos: ['a', 'zzz', 'a'] },
        { id: 'p', name: 'Again', repos: ['a', 'b'] },
        { id: 'q', name: 'Nobody', root: 'C:/x', repos: ['nope'] }
      ]
    })
    expect(cfg.projects).toEqual([
      { id: 'p', name: 'acme', root: 'C:/src/acme', repos: ['a'] },
      // A repeated id is replaced; no root falls back to the first member's path.
      { id: expect.any(String), name: 'Again', root: 'C:/src/acme/web', repos: ['b'] }
    ])
    expect(cfg.projects![1].id).not.toBe('p')
  })

  it('reads `projects` without `repos` as the repo list of a file from before the rename', () => {
    const cfg = normalize({ id: 'ws', name: 'Old', projects: [{ id: 'x', name: 'x', path: 'C:/x' }] })
    expect(cfg.repos).toEqual([{ id: 'x', name: 'x', path: 'C:/x' }])
    expect(cfg.projects).toBeUndefined()
  })
})
