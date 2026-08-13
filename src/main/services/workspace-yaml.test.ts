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
