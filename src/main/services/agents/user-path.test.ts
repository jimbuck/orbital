import { afterEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandUserPath } from './user-path'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('expandUserPath', () => {
  it('expands a leading ~ (the one that silently breaks a profile directory)', () => {
    expect(expandUserPath('~/.claude-personal')).toBe(join(homedir(), '.claude-personal'))
    expect(expandUserPath('~\\.claude-personal')).toBe(join(homedir(), '.claude-personal'))
    expect(expandUserPath('~')).toBe(homedir())
  })

  it('expands environment variables in either spelling', () => {
    vi.stubEnv('ORBITAL_TEST_HOME', 'C:\\profiles')
    expect(expandUserPath('%ORBITAL_TEST_HOME%\\work')).toBe('C:\\profiles\\work')
    expect(expandUserPath('$ORBITAL_TEST_HOME/work')).toBe('C:\\profiles/work')
    expect(expandUserPath('${ORBITAL_TEST_HOME}/work')).toBe('C:\\profiles/work')
  })

  it('leaves an already-absolute path alone', () => {
    expect(expandUserPath('C:\\Users\\jim\\.claude-work')).toBe('C:\\Users\\jim\\.claude-work')
    expect(expandUserPath('/home/jim/.claude')).toBe('/home/jim/.claude')
  })

  it('trims blanks and strips quotes from a pasted path', () => {
    expect(expandUserPath('  C:\\p\\x  ')).toBe('C:\\p\\x')
    expect(expandUserPath('"C:\\Program Files\\x"')).toBe('C:\\Program Files\\x')
    expect(expandUserPath('   ')).toBe('')
    expect(expandUserPath('')).toBe('')
  })

  // Blanking it would turn a typo into "the default profile", which is the
  // failure this module exists to make visible.
  it('leaves an unknown variable in place rather than swallowing it', () => {
    expect(expandUserPath('%NO_SUCH_VAR_HERE%\\x')).toBe('%NO_SUCH_VAR_HERE%\\x')
  })

  // A `~` anywhere but the front is a legitimate directory name (and a Windows
  // 8.3 short path like PROGRA~1 must survive untouched).
  it('only expands a tilde at the start of the path', () => {
    expect(expandUserPath('C:\\PROGRA~1\\tool')).toBe('C:\\PROGRA~1\\tool')
    expect(expandUserPath('C:\\dir\\~backup')).toBe('C:\\dir\\~backup')
  })
})
