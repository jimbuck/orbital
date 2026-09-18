import { describe, expect, it } from 'vitest'
import { parseRg, rgArgs, rgPath } from './ripgrep'

/**
 * The ripgrep backend's two pure halves: the argv it asks for, and what it
 * makes of the answer. `search.test.ts` covers how they fit into a search.
 */

describe('rgArgs', () => {
  it('asks for the same file set git grep --untracked covers', () => {
    const args = rgArgs({ query: 'x' }, 50)
    // Dotfiles are tracked by git and skipped by ripgrep unless asked for…
    expect(args).toContain('--hidden')
    // …and --hidden would then walk the object database, which is not a file set.
    expect(args.join(' ')).toContain('--glob !.git/')
  })

  it('ignores the user\'s ripgrep config', () => {
    // RIPGREP_CONFIG_PATH is a shell preference; it must not decide what this
    // window finds.
    expect(rgArgs({ query: 'x' }, 50)).toContain('--no-config')
  })

  it('is case-insensitive and literal by default', () => {
    const args = rgArgs({ query: 'a(b' }, 50)
    expect(args).toContain('--ignore-case')
    expect(args).toContain('--fixed-strings')
  })

  it('drops the literal flag for a regex query, and the case flag when case matters', () => {
    const args = rgArgs({ query: 'a(b)', regex: true, caseSensitive: true }, 50)
    expect(args).not.toContain('--fixed-strings')
    expect(args).not.toContain('--ignore-case')
  })

  it('passes whole-word to ripgrep rather than faking it in the pattern', () => {
    expect(rgArgs({ query: 'use', wholeWord: true }, 50)).toContain('--word-regexp')
    const args = rgArgs({ query: 'use' }, 50)
    expect(args).not.toContain('--word-regexp')
    expect(args[args.indexOf('--regexp') + 1]).toBe('use')
  })

  it('caps matches per file and turns include globs into globs', () => {
    const args = rgArgs({ query: 'x', include: 'src/**/*.ts, *.md' }, 7)
    expect(args[args.indexOf('--max-count') + 1]).toBe('7')
    expect(args).toContain('src/**/*.ts')
    expect(args).toContain('*.md')
  })

  it('ends the flags before the pattern, so a query starting with a dash is not one', () => {
    const args = rgArgs({ query: '--help' }, 50)
    expect(args[args.indexOf('--regexp') + 1]).toBe('--help')
    expect(args[args.length - 2]).toBe('--')
  })

  it('always names a directory to search', () => {
    // Without one, ripgrep reads STDIN whenever it is not a terminal — which,
    // spawned from Electron, is always. The search would find nothing, forever.
    expect(rgArgs({ query: 'x' }, 50).at(-1)).toBe('.')
  })
})

describe('parseRg', () => {
  const match = (path: string, line: number, text: string): string =>
    JSON.stringify({ type: 'match', data: { path: { text: path }, lines: { text }, line_number: line } })

  it('reads match events and drops the line terminator', () => {
    expect(parseRg(match('src/a.ts', 4, 'const a = 1\n'))).toEqual([
      { path: 'src/a.ts', line: 4, text: 'const a = 1' }
    ])
  })

  it('strips a leading ./ that a path argument would have added', () => {
    expect(parseRg(match('./src/a.ts', 1, 'x\n'))[0].path).toBe('src/a.ts')
  })

  it('normalises platform separators to POSIX', () => {
    // Everything downstream — the editor, the file index, the git panel —
    // speaks repo-relative POSIX paths.
    expect(parseRg(match('src\\lib\\a.ts', 1, 'x\n'))[0].path).toBe('src/lib/a.ts')
  })

  it('skips everything that is not a match, without failing the search', () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'a' } } }),
      match('a.ts', 1, 'hit\n'),
      JSON.stringify({ type: 'summary', data: { stats: {} } }),
      '{ not json',
      ''
    ].join('\n')
    expect(parseRg(stdout)).toHaveLength(1)
  })

  it('decodes a path or line ripgrep could not send as UTF-8', () => {
    // rg falls back to base64 for invalid UTF-8. Showing what can be shown
    // beats dropping the hit entirely.
    const stdout = JSON.stringify({
      type: 'match',
      data: {
        path: { bytes: Buffer.from('src/é.ts').toString('base64') },
        lines: { bytes: Buffer.from('café\n').toString('base64') },
        line_number: 2
      }
    })
    expect(parseRg(stdout)).toEqual([{ path: 'src/é.ts', line: 2, text: 'café' }])
  })

  it('skips a match event missing the fields the result shape needs', () => {
    expect(parseRg(JSON.stringify({ type: 'match', data: { path: { text: 'a' } } }))).toEqual([])
  })
})

describe('rgPath', () => {
  it('finds the binary this platform ships', () => {
    // The dependency is os/cpu-gated, so on a platform @vscode/ripgrep has no
    // binary for this is legitimately null — and search falls back to git grep.
    const path = rgPath()
    expect(path === null || path.includes('rg')).toBe(true)
  })
})
