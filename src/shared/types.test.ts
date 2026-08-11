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

  // An unrecognized id would still be offered in the menus, but main resolves
  // it to the Claude provider — so it must never survive normalization.
  it('drops providers Orbital does not support', () => {
    expect(normalizeAgentConfigs([{ provider: 'claude' }, { provider: 'aider' }])).toEqual([{ provider: 'claude' }])
    expect(normalizeAgentConfigs(undefined, ['claude', 'aider'])).toEqual([{ provider: 'claude' }])
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
  it('lists every supported provider untweaked', () => {
    expect(defaultAgentConfigs()).toEqual([{ provider: 'claude' }, { provider: 'codex' }, { provider: 'cursor' }])
  })
})
