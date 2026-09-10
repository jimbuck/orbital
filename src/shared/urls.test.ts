import { describe, expect, it } from 'vitest'
import { isOpenableExternalUrl } from './urls'

describe('isOpenableExternalUrl', () => {
  it('accepts web pages and mail links', () => {
    expect(isOpenableExternalUrl('https://example.com/a?b=c')).toBe(true)
    expect(isOpenableExternalUrl('http://localhost:3000/')).toBe(true)
    expect(isOpenableExternalUrl('mailto:someone@example.com')).toBe(true)
  })

  it('refuses anything the OS would run rather than browse', () => {
    expect(isOpenableExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isOpenableExternalUrl('ms-msdt:/id PCWDiagnostic')).toBe(false)
    expect(isOpenableExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableExternalUrl('C:\\evil.exe')).toBe(false)
    expect(isOpenableExternalUrl('')).toBe(false)
    expect(isOpenableExternalUrl('not a url')).toBe(false)
  })
})
