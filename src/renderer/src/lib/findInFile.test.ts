import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAB_SIZE,
  findError,
  findMatches,
  nextMatchIndex,
  parseTabSize,
  replaceAll,
  replacementFor,
  selectionQuery
} from './findInFile'

const opts = { caseSensitive: false, tabSize: 4 }

describe('findMatches', () => {
  it('finds every occurrence, without overlapping them', () => {
    // "aa" in "aaaa" is two matches, not three: a find box that counted the
    // overlaps would step through positions no one can see the difference
    // between.
    expect(findMatches('aaaa', 'aa', opts).map((m) => [m.start, m.end])).toEqual([
      [0, 2],
      [2, 4]
    ])
  })

  it('ignores case unless asked, and reports offsets into the original text', () => {
    expect(findMatches('Foo foo FOO', 'foo', opts)).toHaveLength(3)
    expect(findMatches('Foo foo FOO', 'foo', { ...opts, caseSensitive: true }).map((m) => m.start)).toEqual([4])
  })

  it('has no matches for an empty query', () => {
    // Not "every position": an untouched find box reports nothing.
    expect(findMatches('anything', '', opts)).toEqual([])
  })

  it('numbers lines from one and gives the column the text is drawn at', () => {
    const [match] = findMatches('alpha\nbeta gamma', 'gamma', opts)
    expect(match).toMatchObject({ line: 2, column: 5, width: 5 })
  })

  it('expands tabs to the rendered column, not the character index', () => {
    // The highlight is a rectangle at `column` ch. On a tab-indented line the
    // character index and the rendered column are different numbers, and using
    // the wrong one puts every rectangle in the wrong place.
    const [match] = findMatches('\t\tvalue', 'value', opts)
    expect(match.column).toBe(8)
    expect(findMatches('\t\tvalue', 'value', { ...opts, tabSize: 8 })[0].column).toBe(16)
  })

  it('advances a tab to the next stop rather than a fixed width', () => {
    // "ab\tc" with tabSize 4: the tab fills columns 2-3, so 'c' is at 4.
    expect(findMatches('ab\tc', 'c', opts)[0].column).toBe(4)
  })

  it('keeps the line and column walk correct across many matches', () => {
    const text = 'x\n\tx\nxx'
    expect(findMatches(text, 'x', opts).map((m) => [m.line, m.column])).toEqual([
      [1, 0],
      [2, 4],
      [3, 0],
      [3, 1]
    ])
  })
})

describe('nextMatchIndex', () => {
  const matches = findMatches('a...a...a', 'a', opts)

  it('steps on from the caret rather than restarting at the top', () => {
    expect(nextMatchIndex(matches, 0, true)).toBe(0)
    expect(nextMatchIndex(matches, 1, true)).toBe(1)
    expect(nextMatchIndex(matches, 5, true)).toBe(2)
  })

  it('wraps at both ends', () => {
    expect(nextMatchIndex(matches, 9, true)).toBe(0)
    expect(nextMatchIndex(matches, 0, false)).toBe(2)
  })

  it('goes back to the last match that starts before the caret', () => {
    expect(nextMatchIndex(matches, 8, false)).toBe(1)
  })

  it('has nowhere to go with no matches', () => {
    expect(nextMatchIndex([], 0, true)).toBe(-1)
    expect(nextMatchIndex([], 0, false)).toBe(-1)
  })
})

describe('parseTabSize', () => {
  it('reads a column count and falls back for anything it cannot use', () => {
    expect(parseTabSize('4')).toBe(4)
    // A length value ("32px") is indistinguishable from a huge column count
    // once parsed, so anything out of range takes the CSS default instead.
    expect(parseTabSize('32px')).toBe(DEFAULT_TAB_SIZE)
    expect(parseTabSize(undefined)).toBe(DEFAULT_TAB_SIZE)
    expect(parseTabSize('0')).toBe(DEFAULT_TAB_SIZE)
  })
})

describe('whole word and regex', () => {
  const spans = (text: string, query: string, extra: object): number[][] =>
    findMatches(text, query, { ...opts, ...extra }).map((m) => [m.start, m.end])

  it('matches whole words only when asked', () => {
    expect(spans('cat concat cat_x cat', 'cat', { wholeWord: true })).toEqual([
      [0, 3],
      [17, 20]
    ])
  })

  it('still finds a word that starts inside a rejected candidate', () => {
    // "aa" at 0 is half of "aaa"; the one at 4 stands alone.
    expect(spans('aaa aa', 'aa', { wholeWord: true })).toEqual([[4, 6]])
  })

  it('treats the query as a pattern in regex mode, line anchors included', () => {
    expect(spans('foo1 foo22\nfoo', 'foo\\d+', { regex: true })).toEqual([
      [0, 4],
      [5, 10]
    ])
    expect(spans('ab\nab', '^a', { regex: true })).toEqual([
      [0, 1],
      [3, 4]
    ])
  })

  it('skips empty matches rather than looping on them', () => {
    expect(spans('abc', 'x*', { regex: true })).toEqual([])
  })

  it('keeps matches to one line', () => {
    expect(spans('a\nb', 'a\\nb', { regex: true })).toEqual([])
  })

  it('matches nothing for a pattern that does not compile, and says why', () => {
    expect(spans('(((', '(', { regex: true })).toEqual([])
    expect(findError('(', { ...opts, regex: true })).toBeTruthy()
    expect(findError('(', opts)).toBeNull()
    expect(findError('a+', { ...opts, regex: true })).toBeNull()
  })
})

describe('replacementFor / replaceAll', () => {
  it('is literal for a plain query, even with $ in it', () => {
    const [m] = findMatches('price', 'price', opts)
    expect(replacementFor('price', m, 'price', '$1 cost', opts)).toBe('$1 cost')
  })

  it('expands capture groups against the match it replaces', () => {
    const text = 'let a = 1; let b = 2'
    const o = { ...opts, regex: true }
    const ms = findMatches(text, 'let (\\w)', o)
    expect(ms.map((m) => replacementFor(text, m, 'let (\\w)', 'const $1', o))).toEqual(['const a', 'const b'])
    expect(replaceAll(text, ms, 'let (\\w)', 'const $1', o)).toBe('const a = 1; const b = 2')
  })

  it('evaluates lookbehinds in the full text', () => {
    const text = 'xa ya'
    const o = { ...opts, regex: true }
    const ms = findMatches(text, '(?<=y)a', o)
    expect(replaceAll(text, ms, '(?<=y)a', 'B', o)).toBe('xa yB')
  })
})

describe('selectionQuery', () => {
  it('takes a single-line, non-blank selection', () => {
    expect(selectionQuery('foo bar', 0, 3)).toBe('foo')
  })

  it('refuses empty, blank, multi-line and very long selections', () => {
    expect(selectionQuery('foo', 1, 1)).toBeNull()
    expect(selectionQuery('a   b', 1, 4)).toBeNull()
    expect(selectionQuery('a\nb', 0, 3)).toBeNull()
    expect(selectionQuery('x'.repeat(300), 0, 300)).toBeNull()
  })
})
