import { describe, expect, it } from 'vitest'
import { fileIcon } from './fileIcons'

/** The two halves of the answer, as strings a test can read. */
const seen = (path: string): { icon: string; color: string } => {
  const { Icon, className } = fileIcon(path)
  return { icon: (Icon as unknown as { displayName?: string }).displayName ?? 'unknown', color: className }
}

describe('fileIcon', () => {
  it('tells the code families apart by glyph and by hue', () => {
    expect(seen('src/app.tsx').icon).toBe('FileCode2')
    // Same glyph, different hue: the family is "code", the hue is the language.
    expect(seen('src/app.tsx').color).not.toBe(seen('scripts/build.mjs').color)
    expect(seen('styles/app.css').icon).toBe('Palette')
    expect(seen('config/app.yaml').icon).toBe('Settings2')
    expect(seen('scripts/deploy.ps1').icon).toBe('FileTerminal')
    expect(seen('docs/guide.md').icon).toBe('BookText')
    expect(seen('assets/logo.svg').icon).toBe('FileImage')
    expect(seen('dist/app.zip').icon).toBe('FileArchive')
  })

  it('lets a whole filename outrank its extension', () => {
    // Both are JSON; only one is something you open on purpose.
    expect(seen('package.json').icon).toBe('Package')
    expect(seen('package-lock.json').icon).toBe('FileLock2')
    expect(seen('src/tsconfig.json').icon).toBe('FileJson2')
    expect(seen('pnpm-lock.yaml').icon).toBe('FileLock2')
    expect(seen('Dockerfile').icon).toBe('Container')
  })

  it('handles the dotted names no extension describes', () => {
    // extOf sees "local" in `.env.local` and "gitignore" in `.gitignore` — the
    // first is meaningless and the second only works by accident.
    expect(seen('.env').icon).toBe('FileKey2')
    expect(seen('apps/web/.env.production').icon).toBe('FileKey2')
    expect(seen('.gitignore').icon).toBe('GitBranch')
    expect(seen('.gitattributes').icon).toBe('GitBranch')
    expect(seen('README').icon).toBe('BookText')
    expect(seen('readme.md').icon).toBe('BookText')
  })

  it('falls back rather than guessing at an extension it does not know', () => {
    expect(seen('notes.qqq')).toEqual({ icon: 'FileText', color: 'text-faint' })
    expect(seen('Makefile')).toEqual({ icon: 'FileText', color: 'text-faint' })
  })

  it('only ever paints in theme tokens', () => {
    // A baked-in brand hex would fight twenty themes; see the module note.
    const paths = [
      'a.ts', 'a.js', 'a.json', 'a.md', 'a.css', 'a.html', 'a.yml', 'a.env', 'a.sh', 'a.png',
      'a.mp4', 'a.mp3', 'a.zip', 'a.sql', 'a.csv', 'a.woff2', 'a.pdf', 'a.exe', 'a.lock',
      'a.diff', 'a.txt', 'a.py', 'a.go', 'a.rs', 'a.java', 'a.rb', 'a.cpp', 'a.php', 'a.lua',
      'package.json', '.gitignore', 'Dockerfile', 'LICENSE', 'unknown.qqq'
    ]
    for (const path of paths) {
      expect(seen(path).color, path).toMatch(/^text-[a-z0-9-]+$/)
      expect(seen(path).color, path).not.toMatch(/\[/)
    }
  })
})
