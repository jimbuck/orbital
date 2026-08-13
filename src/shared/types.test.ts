import { describe, expect, it } from 'vitest'
import {
  defaultAgentConfigs,
  findAgentConfig,
  formatArgsString,
  nextAgentId,
  nextAgentName,
  normalizeAgentConfigs,
  parseArgsString,
  type AgentConfig
} from './types'

describe('normalizeAgentConfigs', () => {
  it('keeps well-formed entries and their optional fields', () => {
    const out = normalizeAgentConfigs([
      {
        id: 'claude',
        name: 'Claude (personal)',
        provider: 'claude',
        configDir: 'C:\\profiles\\personal',
        args: ['--verbose'],
        env: { FOO: 'bar' }
      },
      { id: 'codex', name: 'Codex', provider: 'codex', execPath: 'C:\\bin\\codex.exe' }
    ])
    expect(out).toEqual([
      {
        id: 'claude',
        name: 'Claude (personal)',
        provider: 'claude',
        configDir: 'C:\\profiles\\personal',
        args: ['--verbose'],
        env: { FOO: 'bar' }
      },
      { id: 'codex', name: 'Codex', provider: 'codex', execPath: 'C:\\bin\\codex.exe' }
    ])
  })

  it('drops entries without a provider, and mints ids/names for those missing them', () => {
    const out = normalizeAgentConfigs([
      { provider: '' },
      { configDir: '/x' },
      { provider: 'claude', configDir: '/personal' },
      { provider: 'claude', configDir: '/work' }
    ])
    // Several profiles of one provider are the point; the FIRST keeps the bare
    // provider id so references stored before profiles existed still resolve.
    expect(out).toEqual([
      { id: 'claude', name: 'Claude', provider: 'claude', configDir: '/personal' },
      { id: 'claude-2', name: 'Claude', provider: 'claude', configDir: '/work' }
    ])
  })

  it('re-mints an id two profiles claim, so every reference stays unambiguous', () => {
    const out = normalizeAgentConfigs([
      { id: 'claude', name: 'Work', provider: 'claude' },
      { id: 'claude', name: 'Personal', provider: 'claude' }
    ])
    expect(out?.map((a) => a.id)).toEqual(['claude', 'claude-2'])
    expect(out?.map((a) => a.name)).toEqual(['Work', 'Personal'])
  })

  it('scrubs blank and mistyped optional fields', () => {
    const out = normalizeAgentConfigs([
      { provider: 'claude', configDir: '  ', execPath: '', args: [], env: {} },
      { provider: 'codex', name: '  ', args: ['ok', 42], env: { GOOD: 'v', BAD: 7 } }
    ])
    expect(out).toEqual([
      { id: 'claude', name: 'Claude', provider: 'claude' },
      { id: 'codex', name: 'Codex', provider: 'codex', env: { GOOD: 'v' } }
    ])
  })

  it('converts a legacy enabledAgents id array', () => {
    expect(normalizeAgentConfigs(undefined, ['claude', 'cursor', 'claude'])).toEqual([
      { id: 'claude', name: 'Claude', provider: 'claude' },
      { id: 'cursor', name: 'Cursor', provider: 'cursor' }
    ])
  })

  it('returns undefined when neither value is usable', () => {
    expect(normalizeAgentConfigs(undefined, undefined)).toBeUndefined()
    expect(normalizeAgentConfigs('nope', { not: 'an array' })).toBeUndefined()
  })

  it('passes an explicit empty list through (no agents in the menus)', () => {
    expect(normalizeAgentConfigs([], ['claude'])).toEqual([])
  })

  // An unrecognized id would still be offered in the menus, but main resolves
  // it to the Claude provider — so it must never survive normalization.
  it('drops providers Orbital does not support', () => {
    expect(normalizeAgentConfigs([{ provider: 'claude' }, { provider: 'aider' }])).toEqual([
      { id: 'claude', name: 'Claude', provider: 'claude' }
    ])
    expect(normalizeAgentConfigs(undefined, ['claude', 'aider'])).toEqual([
      { id: 'claude', name: 'Claude', provider: 'claude' }
    ])
  })

  it('treats a non-empty list that scrubs down to nothing as unusable', () => {
    expect(normalizeAgentConfigs([{ provider: 'aider' }, { nope: true }])).toBeUndefined()
    expect(normalizeAgentConfigs(undefined, ['aider'])).toBeUndefined()
  })
})

describe('parseArgsString / formatArgsString', () => {
  it('splits on whitespace and honors quotes', () => {
    expect(parseArgsString('--flag value')).toEqual(['--flag', 'value'])
    expect(parseArgsString('--path "C:\\My Dir\\x" rest')).toEqual(['--path', 'C:\\My Dir\\x', 'rest'])
    expect(parseArgsString("--msg 'two words'")).toEqual(['--msg', 'two words'])
    expect(parseArgsString('   ')).toEqual([])
  })

  it('round-trips through formatArgsString', () => {
    const args = ['--path', 'C:\\My Dir\\x', '--verbose']
    expect(parseArgsString(formatArgsString(args))).toEqual(args)
  })

  it('switches to single quotes so a spaced arg containing a quote round-trips', () => {
    expect(formatArgsString(['--msg', 'hello "world"'])).toBe('--msg \'hello "world"\'')
    expect(parseArgsString(formatArgsString(['--msg', 'hello "world"']))).toEqual(['--msg', 'hello "world"'])
    // No spaces means no quoting needed, so the quote character passes through.
    expect(parseArgsString(formatArgsString(['a"b']))).toEqual(['a"b'])
  })
})

describe('defaultAgentConfigs', () => {
  it('lists every supported provider untweaked, keyed by the provider id', () => {
    expect(defaultAgentConfigs()).toEqual([
      { id: 'claude', name: 'Claude', provider: 'claude' },
      { id: 'codex', name: 'Codex', provider: 'codex' },
      { id: 'cursor', name: 'Cursor', provider: 'cursor' }
    ])
  })
})

describe('findAgentConfig', () => {
  const agents: AgentConfig[] = [
    { id: 'claude', name: 'Claude (personal)', provider: 'claude' },
    { id: 'claude-2', name: 'Claude (work)', provider: 'claude' },
    { id: 'codex', name: 'Codex', provider: 'codex' }
  ]

  it('matches by profile id', () => {
    expect(findAgentConfig(agents, 'claude-2')?.name).toBe('Claude (work)')
  })

  // Tabs and project defaults stored before profiles had ids hold a provider id.
  it('falls back to the first profile of a provider, so legacy references resolve', () => {
    expect(findAgentConfig(agents, 'codex')?.id).toBe('codex')
    expect(findAgentConfig([{ id: 'personal', name: 'Personal', provider: 'claude' }], 'claude')?.id).toBe('personal')
  })

  it('resolves nothing for an unknown or absent reference', () => {
    expect(findAgentConfig(agents, 'gone')).toBeUndefined()
    expect(findAgentConfig(agents, undefined)).toBeUndefined()
  })
})

describe('nextAgentId / nextAgentName', () => {
  it('hands the first profile the bare provider id and suffixes the rest', () => {
    expect(nextAgentId('claude', [])).toBe('claude')
    expect(nextAgentId('claude', ['claude'])).toBe('claude-2')
    expect(nextAgentId('claude', ['claude', 'claude-2'])).toBe('claude-3')
  })

  it('numbers repeat names off the provider label', () => {
    expect(nextAgentName('claude', [])).toBe('Claude')
    expect(nextAgentName('claude', ['Claude'])).toBe('Claude 2')
  })
})
