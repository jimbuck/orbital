import { describe, expect, it } from 'vitest'
import { isValidOwner, parseNameWithOwner, suggestRepoName, validateRepoName } from './github'

describe('validateRepoName', () => {
  it('accepts the characters GitHub allows', () => {
    for (const name of ['orbital', 'my.app', 'a_b-c', '.github', '123', 'C++']) {
      expect(validateRepoName(name), name).toBe(name === 'C++' ? 'Only letters, numbers, hyphens, underscores and periods are allowed.' : null)
    }
  })

  it('rejects empty, oversize, and disallowed names', () => {
    expect(validateRepoName('')).toMatch(/required/)
    expect(validateRepoName('a'.repeat(101))).toMatch(/100 characters/)
    expect(validateRepoName('my app')).toMatch(/Only letters/)
    expect(validateRepoName('.')).toMatch(/only periods/)
    expect(validateRepoName('..')).toMatch(/only periods/)
    expect(validateRepoName('thing.git')).toMatch(/\.git/)
    expect(validateRepoName('thing.GIT')).toMatch(/\.git/)
  })
})

describe('suggestRepoName', () => {
  it('collapses runs of disallowed characters to one hyphen, like GitHub does', () => {
    expect(suggestRepoName('My  Cool App!')).toBe('My-Cool-App-')
    expect(suggestRepoName('  spaced  ')).toBe('spaced')
    expect(suggestRepoName('already-fine')).toBe('already-fine')
  })
})

describe('isValidOwner', () => {
  it('follows GitHub login rules', () => {
    expect(isValidOwner('jimbuck')).toBe(true)
    expect(isValidOwner('dotnet-foundation')).toBe(true)
    expect(isValidOwner('-lead')).toBe(false)
    expect(isValidOwner('trail-')).toBe(false)
    expect(isValidOwner('dou--ble')).toBe(false)
    expect(isValidOwner('has space')).toBe(false)
    expect(isValidOwner('')).toBe(false)
  })
})

describe('parseNameWithOwner', () => {
  it('splits a well-formed owner/repo and trims whitespace', () => {
    expect(parseNameWithOwner(' cli/cli ')).toEqual({ owner: 'cli', name: 'cli' })
  })

  it('returns null for anything else', () => {
    expect(parseNameWithOwner('cli')).toBeNull()
    expect(parseNameWithOwner('/cli')).toBeNull()
    expect(parseNameWithOwner('cli/')).toBeNull()
    expect(parseNameWithOwner('a/b/c')).toBeNull()
    expect(parseNameWithOwner('bad owner/repo')).toBeNull()
    expect(parseNameWithOwner('owner/bad repo')).toBeNull()
  })
})
