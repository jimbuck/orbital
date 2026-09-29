import { describe, expect, it } from 'vitest'
import {
  applyDisplayChange,
  computeFoldRanges,
  displayToRealOffset,
  filterHtmlLines,
  pruneFolds,
  rangeToFold,
  realToDisplayOffset,
  shiftFolds,
  visibleLines
} from './folding'

const SRC = ['function a() {', '  if (x) {', '    y()', '  }', '}', '', 'const b = 1'].join('\n')
const lines = SRC.split('\n')

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

describe('visibleLines / rangeToFold / pruneFolds', () => {
  const ranges = computeFoldRanges(lines, 2)
  it('skips folded lines, outer fold winning over inner', () => {
    expect(visibleLines(lines.length, ranges, new Set([1]))).toEqual([0, 1, 3, 4, 5, 6])
    expect(visibleLines(lines.length, ranges, new Set([0, 1]))).toEqual([0, 4, 5, 6])
  })
  it('picks the innermost enclosing unfolded range', () => {
    expect(rangeToFold(ranges, new Set(), 2)).toEqual({ start: 1, end: 2 })
    expect(rangeToFold(ranges, new Set([1]), 2)).toEqual({ start: 0, end: 3 })
    expect(rangeToFold(ranges, new Set(), 6)).toBeNull()
  })
  it('prunes folds that no longer start a range', () => {
    expect([...pruneFolds(new Set([0, 2, 9]), ranges)]).toEqual([0])
  })
})

describe('filterHtmlLines', () => {
  it('drops hidden line pieces and keeps the wrapper', () => {
    const html = '<pre><code><span class="line">a</span>\n<span class="line">b</span>\n<span class="line">c</span>\n<span class="line"></span></code></pre>'
    expect(filterHtmlLines(html, [0, 2], 3)).toBe(
      '<pre><code><span class="line">a</span>\n<span class="line">c</span>\n<span class="line"></span></code></pre>'
    )
  })
})

describe('applyDisplayChange', () => {
  const ranges = computeFoldRanges(lines, 2)
  const visible = visibleLines(lines.length, ranges, new Set([0]))
  // display: "function a() {\n}\n\nconst b = 1"
  const display = visible.map((i) => lines[i]).join('\n')

  it('maps a typed character back into the real text', () => {
    const next = display.replace('const b', 'const bb')
    const r = applyDisplayChange(SRC, visible, next)
    expect(r.value).toBe(SRC.replace('const b', 'const bb'))
    expect(r.rejected).toBe(false)
  })

  it('refuses a lone Backspace that would eat the fold', () => {
    const at = display.indexOf('\n}') + 1 // the newline before "}"
    const r = applyDisplayChange(SRC, visible, display.slice(0, at - 1) + display.slice(at))
    expect(r.rejected).toBe(true)
    expect(r.value).toBe(SRC)
    expect(r.unfold).toEqual({ from: 0, to: 4 })
  })

  it('puts Enter at the end of a folded line after the fold', () => {
    const at = 'function a() {'.length
    const r = applyDisplayChange(SRC, visible, display.slice(0, at) + '\n' + display.slice(at))
    expect(r.value).toBe(['function a() {', '  if (x) {', '    y()', '  }', '', '}', '', 'const b = 1'].join('\n'))
    expect(r.lineDelta).toBe(1)
  })

  it('shifts and drops folds around an edit', () => {
    expect([...shiftFolds(new Set([2, 5, 8]), 4, 6, 3)].sort()).toEqual([2, 11].sort())
  })
})

describe('offset mapping', () => {
  const ranges = computeFoldRanges(lines, 2)
  const visible = visibleLines(lines.length, ranges, new Set([0]))
  it('round-trips visible offsets and clamps a hidden caret to the fold line', () => {
    const real = SRC.indexOf('const b') + 2
    const disp = realToDisplayOffset(SRC, visible, real)
    expect(disp).toBe('function a() {\n}\n\nconst b = 1'.indexOf('const b') + 2)
    expect(displayToRealOffset(SRC, visible, disp)).toBe(real)
    expect(realToDisplayOffset(SRC, visible, SRC.indexOf('y()'))).toBe('function a() {'.length)
  })
})
