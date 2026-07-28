import { describe, expect, it } from 'vitest'
import { defaultAgentConfigs, formatArgsString, normalizeAgentConfigs, parseArgsString } from './types'

describe('normalizeAgentConfigs', () => {
  it('keeps well-formed entries and their optional fields', () => {
    const out = normalizeAgentConfigs([
      { provider: 'claude', configDir: 'C:\\profiles\\personal', args: ['--verbose'], env: { FOO: 'bar' } },
      { provider: 'codex', execPath: 'C:\\bin\\codex.exe' }
    ])
    expect(out).toEqual([
      { provider: 'claude', configDir: 'C:\\profiles\\personal', args: ['--verbose'], env: { FOO: 'bar' } },
      { provider: 'codex', execPath: 'C:\\bin\\codex.exe' }
    ])
  })

  it('drops entries without a provider and keeps the first of a duplicate', () => {
    const out = normalizeAgentConfigs([
      { provider: '' },
      { configDir: '/x' },
      { provider: 'claude', configDir: '/first' },
      { provider: 'claude', configDir: '/second' }
    ])
    expect(out).toEqual([{ provider: 'claude', configDir: '/first' }])
  })

  it('scrubs blank and mistyped optional fields', () => {
    const out = normalizeAgentConfigs([
      { provider: 'claude', configDir: '  ', execPath: '', args: [], env: {} },
      { provider: 'codex', args: ['ok', 42], env: { GOOD: 'v', BAD: 7 } }
    ])
    expect(out).toEqual([{ provider: 'claude' }, { provider: 'codex', env: { GOOD: 'v' } }])
  })

  it('converts a legacy enabledAgents id array', () => {
    expect(normalizeAgentConfigs(undefined, ['claude', 'cursor', 'claude'])).toEqual([
      { provider: 'claude' },
      { provider: 'cursor' }
    ])
  })

  it('returns undefined when neither value is usable', () => {
    expect(normalizeAgentConfigs(undefined, undefined)).toBeUndefined()
    expect(normalizeAgentConfigs('nope', { not: 'an array' })).toBeUndefined()
  })

  it('passes an explicit empty list through (no agents in the menus)', () => {
    expect(normalizeAgentConfigs([], ['claude'])).toEqual([])
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
})

describe('defaultAgentConfigs', () => {
  it('lists every supported provider untweaked', () => {
    expect(defaultAgentConfigs()).toEqual([{ provider: 'claude' }, { provider: 'codex' }, { provider: 'cursor' }])
  })
})
