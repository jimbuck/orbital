import { describe, expect, it } from 'vitest'
import { THEMES } from '@shared/themes'
import {
  HIGHLIGHT_LANGS,
  MAPPED_LANGS,
  SYNTAX_THEMES,
  highlightTokens,
  langFor,
  langForFence
} from './highlight'

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

  it('recognises infrastructure and config files by extension and by name', () => {
    expect(langFor('infra/main.tf')).toBe('terraform')
    expect(langFor('infra/prod.tfvars')).toBe('terraform')
    expect(langFor('jobs/api.nomad')).toBe('hcl')
    expect(langFor('deploy/main.bicep')).toBe('bicep')
    expect(langFor('Makefile')).toBe('make')
    expect(langFor('native/CMakeLists.txt')).toBe('cmake')
    expect(langFor('Jenkinsfile')).toBe('groovy')
    expect(langFor('build.gradle')).toBe('groovy')
    expect(langFor('Gemfile')).toBe('ruby')
    expect(langFor('.env')).toBe('dotenv')
    expect(langFor('apps/web/.env.local')).toBe('dotenv')
    expect(langFor('docker/Dockerfile.dev')).toBe('docker')
    expect(langFor('etc/nginx/nginx.conf')).toBe('nginx')
    expect(langFor('etc/app.service')).toBe('systemd')
    expect(langFor('home/me/.ssh/config')).toBe('ssh-config')
    expect(langFor('C:\\Users\\me\\.ssh\\config')).toBe('ssh-config')
    expect(langFor('.github/CODEOWNERS')).toBe('codeowners')
    expect(langFor('schema.prisma')).toBe('prisma')
    expect(langFor('api/v1/user.proto')).toBe('proto')
    expect(langFor('flake.nix')).toBe('nix')
    expect(langFor('justfile')).toBe('just')
    expect(langForFence('hcl')).toBe('hcl')
    expect(langForFence('tf')).toBe('terraform')
    expect(langForFence('makefile')).toBe('make')
    expect(langForFence('protobuf')).toBe('proto')
  })

  it('only maps onto grammars the build can load', () => {
    for (const lang of MAPPED_LANGS) expect(HIGHLIGHT_LANGS.has(lang), lang).toBe(true)
  })
})

describe('grammars', () => {
  // A grammar the JavaScript regex engine cannot compile, or that registers
  // under a different id than the one we ask for, only shows up as an
  // unhighlighted file at runtime — load every one of them here instead.
  it('loads and tokenises every grammar', async () => {
    const theme = THEMES[0].id
    for (const lang of HIGHLIGHT_LANGS) {
      const lines = await highlightTokens('a = "b" # c\n', lang, theme)
      expect(lines.length, lang).toBeGreaterThan(0)
    }
  }, 60_000)
})
