import { describe, expect, it } from 'vitest'
import { THEMES } from '@shared/themes'
import { SYNTAX_THEMES, langFor, langForFence } from './highlight'

describe('syntax themes', () => {
  it('ships one for every app theme', () => {
    // A theme whose `code` names a shiki theme with no loader would highlight
    // as GitHub instead, which is the kind of near-miss nobody reports.
    for (const theme of THEMES) expect(SYNTAX_THEMES.has(theme.code), theme.id).toBe(true)
  })
})

describe('grammar lookup', () => {
  it('maps paths and fence tags onto shiki grammars, and gives up on the rest', () => {
    expect(langFor('src/app/main.tsx')).toBe('tsx')
    expect(langFor('scripts/build.mjs')).toBe('javascript')
    expect(langFor('Dockerfile')).toBe('docker')
    expect(langFor('notes.wat')).toBeNull()
    expect(langForFence('c++')).toBe('cpp')
    expect(langForFence('sh')).toBe('bash')
    expect(langForFence('text')).toBeNull()
  })
})
