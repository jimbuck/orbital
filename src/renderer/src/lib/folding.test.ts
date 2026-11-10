import { describe, expect, it } from 'vitest'
import { computeFoldRanges, foldProjection, NO_FOLDS, type FoldProjection } from './folding'

const SRC = ['function a() {', '  if (x) {', '    y()', '  }', '}', '', 'const b = 1'].join('\n')
const lines = SRC.split('\n')

/** SRC with the given lines folded. */
const project = (folds: number[] = [], src = SRC, tabSize = 2, lang?: string): FoldProjection =>
  foldProjection(src, new Set(folds), { tabSize, lang })
const rowsOf = (p: FoldProjection): number[] => Array.from({ length: p.rowCount }, (_, row) => p.lineAt(row))

describe('computeFoldRanges', () => {
  it('folds indented blocks and leaves the closing line visible', () => {
    const r = computeFoldRanges(lines, 2)
    expect(r.get(0)).toEqual({ start: 0, end: 3 })
    expect(r.get(1)).toEqual({ start: 1, end: 2 })
    expect(r.has(2)).toBe(false)
    expect(r.has(6)).toBe(false)
  })

  it('does not swallow trailing blank lines and counts tabs by tab size', () => {
    const r = computeFoldRanges(['a', '\tb', '', '', 'c'], 4)
    expect(r.get(0)).toEqual({ start: 0, end: 1 })
  })

  it('folds markdown by heading level, skipping fenced code', () => {
    const src = ['# A', 'text', '## B', '```', '# nope', '```', '# C', 'x']
    const r = computeFoldRanges(src, 2, 'markdown')
    expect(r.get(0)).toEqual({ start: 0, end: 5 })
    expect(r.get(2)).toEqual({ start: 2, end: 5 })
    expect(r.get(6)).toEqual({ start: 6, end: 7 })
    expect(r.has(4)).toBe(false)
  })
})

describe('foldProjection: what is on screen', () => {
  it('is the document itself with nothing folded', () => {
    const p = project()
    expect(p.isFolded).toBe(false)
    expect(p.text).toBe(SRC)
    expect(p.rowCount).toBe(p.lineCount)
    expect(rowsOf(p)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(p.rowOf(4)).toBe(4)
    expect(p.toDocument(17)).toBe(17)
    expect(p.toDisplay(17)).toBe(17)
    expect(p.chips).toEqual([])
    expect(p.folds).toBe(NO_FOLDS)
  })

  it('hides the lines under a fold, the outer fold winning over an inner one', () => {
    expect(rowsOf(project([1]))).toEqual([0, 1, 3, 4, 5, 6])
    expect(rowsOf(project([0, 1]))).toEqual([0, 4, 5, 6])
    const p = project([0])
    expect(p.isFolded).toBe(true)
    expect(p.text).toBe('function a() {\n}\n\nconst b = 1')
    expect(p.rowCount).toBe(4)
    expect(p.lineCount).toBe(7)
  })

  it('says which row a line is on, and that a folded line is on none', () => {
    const p = project([0])
    expect(p.rowOf(0)).toBe(0)
    expect(p.rowOf(2)).toBe(-1)
    expect(p.rowOf(4)).toBe(1)
    expect(p.rowOf(6)).toBe(3)
  })

  it('drops folds that no longer start a range', () => {
    expect([...project([0, 2, 9]).folds]).toEqual([0])
    // None left: not folded at all.
    expect(project([2, 9]).isFolded).toBe(false)
    expect(project([2, 9]).folds).toBe(NO_FOLDS)
  })

  it('lists a marker for every line on screen that starts a range', () => {
    expect(project().markers).toEqual([
      { row: 0, line: 0, folded: false },
      { row: 1, line: 1, folded: false }
    ])
    // The inner block is hidden with the outer one.
    expect(project([0]).markers).toEqual([{ row: 0, line: 0, folded: true }])
    expect(project([1]).markers).toEqual([
      { row: 0, line: 0, folded: false },
      { row: 1, line: 1, folded: true }
    ])
  })

  it('cuts highlighted markup down to the lines on screen, keeping the wrapper', () => {
    const src = ['a {', '  b', '}'].join('\n')
    const html =
      '<pre><code><span class="line">a {</span>\n<span class="line">  b</span>\n<span class="line">}</span>\n<span class="line"></span></code></pre>'
    expect(project([0], src).filterHtml(html)).toBe(
      '<pre><code><span class="line">a {</span>\n<span class="line">}</span>\n<span class="line"></span></code></pre>'
    )
    expect(project([], src).filterHtml(html)).toBe(html)
  })
})

describe('foldProjection: changing the folds', () => {
  it('folds the innermost open range around a line', () => {
    expect([...project().fold(2)!]).toEqual([1])
    // With the inner one already folded, the next one out.
    expect([...project([1]).fold(2)!].sort()).toEqual([0, 1])
    expect(project().fold(6)).toBeNull()
  })

  it('toggles the range starting at a line', () => {
    expect([...project().toggle(1)]).toEqual([1])
    expect([...project([0, 1]).toggle(1)]).toEqual([0])
  })

  it('opens every fold hiding a line, and no others', () => {
    const src = ['a {', '  b {', '    c', '  }', '}', 'd {', '  e', '}'].join('\n')
    const p = project([0, 1, 5], src)
    expect(p.rowOf(2)).toBe(-1)
    expect([...p.reveal(2)]).toEqual([5])
    // A fold's own header is on screen, so revealing it opens nothing.
    expect([...p.reveal(5)].sort()).toEqual([0, 1, 5])
  })
})

describe('foldProjection: offsets', () => {
  const p = project([0])
  const display = p.text

  it('round-trips offsets that are on screen', () => {
    const doc = SRC.indexOf('const b') + 2
    const disp = p.toDisplay(doc)
    expect(disp).toBe(display.indexOf('const b') + 2)
    expect(p.toDocument(disp)).toBe(doc)
    expect(p.toDocument(0)).toBe(0)
    expect(p.toDocument(display.length)).toBe(SRC.length)
  })

  it('lands an offset inside a fold at the end of the fold header', () => {
    expect(p.toDisplay(SRC.indexOf('y()'))).toBe('function a() {'.length)
  })

  it('maps every on-screen character to itself in the document', () => {
    for (let i = 0; i < display.length; i++) {
      expect(SRC[p.toDocument(i)]).toBe(display[i])
      expect(p.toDisplay(p.toDocument(i))).toBe(i)
    }
  })

  it('clamps offsets past either text to its end', () => {
    expect(p.toDocument(display.length + 50)).toBe(SRC.length)
    expect(p.toDisplay(SRC.length + 50)).toBe(display.length)
  })

  it('says which document line a caret is on', () => {
    expect(p.lineAtOffset(0)).toBe(0)
    expect(p.lineAtOffset(display.indexOf('}'))).toBe(4)
    expect(p.lineAtOffset(display.length)).toBe(6)
    // Unfolded, a row is its line.
    expect(project().lineAtOffset(SRC.indexOf('y()'))).toBe(2)
    // The start of a line belongs to that line, the newline before it to the one above.
    expect(project().lineAtOffset(SRC.indexOf('  if'))).toBe(1)
    expect(project().lineAtOffset(SRC.indexOf('  if') - 1)).toBe(0)
  })
})

describe('foldProjection: edits made in the display text', () => {
  const p = project([0])
  // display: "function a() {\n}\n\nconst b = 1"
  const display = p.text

  it('maps a typed character back into the document', () => {
    const e = p.edit(display.replace('const b', 'const bb'))
    expect(e.value).toBe(SRC.replace('const b', 'const bb'))
    expect(e.rejected).toBe(false)
    expect(e.caret).toBe(SRC.indexOf('const b') + 'const bb'.length)
    expect([...e.folds]).toEqual([0])
  })

  it('refuses a lone Backspace that would eat the fold, and opens it instead', () => {
    const at = display.indexOf('\n}') + 1 // the newline before "}"
    const e = p.edit(display.slice(0, at - 1) + display.slice(at))
    expect(e.rejected).toBe(true)
    expect(e.value).toBe(SRC)
    expect([...e.folds]).toEqual([])
    expect(e.caret).toBe('function a() {'.length)
  })

  it('deletes the folded lines with a selection that spans them', () => {
    // Select from inside the header to inside the closing brace line and type x.
    const from = 'function'.length
    const to = display.indexOf('}') + 1
    const e = p.edit(display.slice(0, from) + 'x' + display.slice(to))
    expect(e.rejected).toBe(false)
    expect(e.value).toBe('functionx\n\nconst b = 1')
    // The fold's block is gone, and so is the fold.
    expect(project([...e.folds], e.value).isFolded).toBe(false)
  })

  it('puts Enter at the end of a folded line after the fold', () => {
    const at = 'function a() {'.length
    const e = p.edit(display.slice(0, at) + '\n' + display.slice(at))
    expect(e.value).toBe(['function a() {', '  if (x) {', '    y()', '  }', '', '}', '', 'const b = 1'].join('\n'))
    expect([...e.folds]).toEqual([0])
  })

  it('moves the folds below an edit with the lines it adds or removes', () => {
    const src = ['head', 'a {', '  1', '}', 'b {', '  2', '}'].join('\n')
    const q = project([1, 4], src)
    // q.text: "head\na {\n}\nb {\n}". Two new lines, typed into the first.
    const added = q.edit(q.text.replace('head', 'he\nx\nad'))
    expect([...added.folds].sort()).toEqual([3, 6])
    expect(project([...added.folds], added.value).text).toBe('he\nx\nad\na {\n}\nb {\n}')
    // Remove the first block's header line and what it hides: the second fold
    // moves up two lines, and the first has no block left to fold.
    const removed = q.edit(q.text.replace('a {\n', ''))
    expect(removed.value).toBe(['head', '}', 'b {', '  2', '}'].join('\n'))
    expect([...project([...removed.folds], removed.value).folds]).toEqual([2])
  })

  it('is a plain replace with nothing folded', () => {
    const e = project().edit('new text')
    expect(e).toMatchObject({ value: 'new text', rejected: false })
  })
})

describe('foldProjection: chips', () => {
  // Four blocks; the third holds a nested one.
  const src = [
    'function a() {', //  0
    '  one()', //         1
    '}', //               2
    'function b() {', //  3
    '  two()', //         4
    '}', //               5
    'function c() {', //  6
    '  if (x) {', //      7
    '    three()', //     8
    '  }', //             9
    '}', //              10
    '\tfunction d() {', // 11
    '\t\tfour()', //     12
    '\t}' //             13
  ].join('\n')
  const chipsFor = (folds: number[]): FoldProjection['chips'] => project(folds, src, 4).chips

  it('places a chip on its header ROW, however many folds sit above it', () => {
    const chips = chipsFor([0, 3, 7, 11])
    expect(chips.map((c) => [c.line, c.row])).toEqual([
      [0, 0],
      [3, 2], // line 3, one hidden line above
      [7, 5], // line 7, two hidden lines above
      [11, 8] // line 11, four hidden lines above
    ])
    expect(chips.map((c) => c.hidden)).toEqual([1, 1, 1, 1])
  })

  it('starts a chip one column past the header text, with tabs expanded', () => {
    const [a, d] = chipsFor([0, 11])
    expect(a.column).toBe('function a() {'.length + 1)
    expect(d.column).toBe(4 + 'function d() {'.length + 1)
  })

  it('does not count a CRLF line ending as a column', () => {
    expect(project([0], ['a {\r', '  b\r', '}'].join('\n'), 4).chips[0].column).toBe('a {'.length + 1)
  })

  it('shows only the outer chip of a nested fold, and the inner one again once the outer opens', () => {
    expect(chipsFor([6, 7]).map((c) => c.line)).toEqual([6])
    expect(chipsFor([7]).map((c) => [c.line, c.row])).toEqual([[7, 7]])
  })
})
