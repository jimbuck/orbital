import { describe, expect, it } from 'vitest'
import { fuzzyMatch, fuzzyMatchPath } from './fuzzy'

/** The matched characters, pulled back out of the target for readability. */
function matched(query: string, target: string): string | null {
  const m = fuzzyMatch(query, target)
  return m ? m.positions.map((p) => target[p]).join('') : null
}

describe('fuzzyMatch', () => {
  it('matches a subsequence and reports where it landed', () => {
    const m = fuzzyMatch('cmd', 'Command Palette')
    expect(m).not.toBeNull()
    expect(matched('cmd', 'Command Palette')).toBe('Cmd')
  })

  it('rejects a query that is not a subsequence at all', () => {
    expect(fuzzyMatch('zzz', 'Command Palette')).toBeNull()
    // Order matters: every character is present, but not in this sequence.
    expect(fuzzyMatch('dc', 'abcd')).toBeNull()
  })

  it('treats an empty query as matching everything, with no highlight', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] })
  })

  it('ignores case in both directions', () => {
    expect(fuzzyMatch('GIT', 'git push')).not.toBeNull()
    expect(fuzzyMatch('sp', 'Split Pane Across')).not.toBeNull()
  })

  it('prefers word starts over an earlier mid-word character', () => {
    // The `p` of `Palette` is what the user meant, not the `p` of `Compare`.
    expect(matched('cp', 'Compare Palette')).toBe('CP')
  })

  it('ranks a word-start acronym above the same letters buried mid-word', () => {
    const acronym = fuzzyMatch('sp', 'Split Pane')!
    const buried = fuzzyMatch('sp', 'unsupported')!
    expect(acronym.score).toBeGreaterThan(buried.score)
  })

  it('ranks a contiguous run above a scattered match', () => {
    const run = fuzzyMatch('stage', 'Stage All Changes')!
    const scattered = fuzzyMatch('stage', 'Set the alert badge')!
    expect(run.score).toBeGreaterThan(scattered.score)
  })

  it('ranks a tighter target above one padded with extra text', () => {
    const tight = fuzzyMatch('push', 'Push')!
    const padded = fuzzyMatch('push', 'Push to the configured upstream remote')!
    expect(tight.score).toBeGreaterThan(padded.score)
  })

  it('cannot match a query longer than the target', () => {
    expect(fuzzyMatch('abcdef', 'abc')).toBeNull()
  })
})

describe('fuzzyMatchPath', () => {
  it('ranks a file-name match above a directory-only one', () => {
    const inName = fuzzyMatchPath('store', 'src/renderer/src/store.ts')!
    const inDir = fuzzyMatchPath('store', 'src/store/reducers/legacy-thing-with-padding.ts')!
    expect(inName.score).toBeGreaterThan(inDir.score)
  })

  it('reports positions relative to the whole path, not the file name', () => {
    const path = 'src/renderer/store.ts'
    const m = fuzzyMatchPath('store', path)!
    expect(m.positions.map((p) => path[p]).join('')).toBe('store')
    expect(Math.min(...m.positions)).toBe(path.indexOf('store.ts'))
  })

  it('still matches a query that spans directory and file name', () => {
    const m = fuzzyMatchPath('rend/store', 'src/renderer/store.ts')
    expect(m).not.toBeNull()
  })

  it('returns null when the path does not contain the query at all', () => {
    expect(fuzzyMatchPath('zzz', 'src/renderer/store.ts')).toBeNull()
  })

  it('handles a path with no directory part', () => {
    const m = fuzzyMatchPath('pkg', 'package.json')
    expect(m).not.toBeNull()
  })
})
