/**
 * Code folding for the plain-textarea editor.
 *
 * A textarea cannot hide lines, so folding works on a DISPLAY copy of the file:
 * the textarea shows the source with the folded lines removed, and every edit
 * made in it is mapped back onto the real text (`applyDisplayChange`). Line
 * numbers here are 0-based indexes into `value.split('\n')` unless noted.
 *
 * Fold ranges are structural, not language-specific: shiki gives us tokens, not
 * a syntax tree, so ranges come from indentation (which covers braces, Python,
 * YAML, JSON, HTML ...) and, for Markdown, from heading levels.
 */

/** Lines `start + 1 .. end` (inclusive) collapse into line `start`. */
export interface FoldRange {
  start: number
  end: number
}

function indentOf(line: string, tabSize: number): number {
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') col += 1
    else if (ch === '\t') col = (Math.floor(col / tabSize) + 1) * tabSize
    else return col
  }
  return -1 // blank line: takes no part in the structure
}

/** Ranges from indentation: a line followed by deeper lines folds those lines. */
function indentRanges(lines: readonly string[], tabSize: number): FoldRange[] {
  const out: FoldRange[] = []
  const stack: { line: number; indent: number }[] = []
  let lastContent = -1
  const close = (indent: number): void => {
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      const top = stack.pop()!
      if (lastContent > top.line) out.push({ start: top.line, end: lastContent })
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const indent = indentOf(lines[i], tabSize)
    if (indent < 0) continue
    close(indent)
    stack.push({ line: i, indent })
    lastContent = i
  }
  close(-1)
  return out
}

/** Markdown: a heading folds everything up to the next heading of the same or higher level. */
function markdownRanges(lines: readonly string[]): FoldRange[] {
  const out: FoldRange[] = []
  const stack: { line: number; level: number }[] = []
  let fence: string | null = null
  let lastContent = -1
  const finish = (top: { line: number }, end: number): void => {
    if (end > top.line) out.push({ start: top.line, end })
  }
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    const fenceMatch = /^\s*(```+|~~~+)/.exec(text)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
    }
    const heading = fence === null && !fenceMatch ? /^(#{1,6})\s/.exec(text) : null
    if (heading) {
      const level = heading[1].length
      while (stack.length > 0 && stack[stack.length - 1].level >= level) finish(stack.pop()!, lastContent)
      stack.push({ line: i, level })
    }
    if (text.trim() !== '') lastContent = i
  }
  while (stack.length > 0) finish(stack.pop()!, lastContent)
  return out
}

/**
 * Every foldable range in the file, keyed by start line. A line starts at most
 * one range; where both an outer and an inner block would start on the same
 * line the outer (larger) one wins.
 */
export function computeFoldRanges(lines: readonly string[], tabSize: number, lang?: string | null): Map<number, FoldRange> {
  const ranges = lang === 'markdown' ? markdownRanges(lines) : indentRanges(lines, tabSize)
  const map = new Map<number, FoldRange>()
  for (const r of ranges) {
    const prev = map.get(r.start)
    if (!prev || r.end > prev.end) map.set(r.start, r)
  }
  return map
}

/** Real line indexes that are on screen, in order — the display-line -> real-line map. */
export function visibleLines(lineCount: number, ranges: ReadonlyMap<number, FoldRange>, folded: ReadonlySet<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < lineCount; ) {
    out.push(i)
    const r = folded.has(i) ? ranges.get(i) : undefined
    i = r ? r.end + 1 : i + 1
  }
  return out
}

/** Keep only folds that still start a range. */
export function pruneFolds(folded: ReadonlySet<number>, ranges: ReadonlyMap<number, FoldRange>): Set<number> {
  const out = new Set<number>()
  for (const f of folded) if (ranges.has(f)) out.add(f)
  return out
}

/**
 * The range a fold command should act on for a caret line: the innermost
 * not-yet-folded range that contains it (starting on it, if one does).
 */
export function rangeToFold(
  ranges: ReadonlyMap<number, FoldRange>,
  folded: ReadonlySet<number>,
  line: number
): FoldRange | null {
  let best: FoldRange | null = null
  for (const r of ranges.values()) {
    if (folded.has(r.start) || r.start > line || r.end < line) continue
    if (!best || r.start > best.start) best = r
  }
  return best
}

/**
 * Drop every line of shiki's `<pre><code>` markup that is hidden. Shiki emits
 * one `<span class="line">` per line joined by literal newlines, and a token
 * cannot contain one, so splitting on '\n' is a line split. The last piece (the
 * mirror's spare trailing line) is never hidden, so the closing tags survive.
 */
export function filterHtmlLines(html: string, visible: readonly number[], lineCount: number): string {
  if (visible.length === lineCount) return html
  const pieces = html.split('\n')
  const keep = new Set(visible)
  return pieces.filter((_, i) => i >= lineCount || keep.has(i)).join('\n')
}

export interface DisplayChange {
  /** The full real text after the edit. */
  value: string
  /** Real offset the caret belongs at afterwards. */
  caret: number
  /**
   * The edit would have eaten the newline in front of a folded block (Backspace
   * or Delete beside a fold). `value` is unchanged; the caller should unfold
   * `unfold` (real line span) instead of deleting code nobody can see.
   */
  rejected: boolean
  /** Real lines the edit replaced (inclusive) and the net line count change. */
  startLine: number
  endLine: number
  lineDelta: number
  unfold: { from: number; to: number } | null
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return n
}

/**
 * Apply an edit made in the display text to the real text.
 *
 * The edit is recovered as a common-prefix / common-suffix diff — exactly the
 * splice a textarea `input` event describes — and its two ends are mapped from
 * display offsets to real offsets. A range that spans a fold therefore deletes
 * the folded lines too (a deliberate selection-delete does what it says), but a
 * lone Backspace/Delete next to a fold is refused, and Enter at the end of a
 * folded line opens the new line AFTER the fold rather than inside it.
 */
export function applyDisplayChange(value: string, visible: readonly number[], newDisplay: string): DisplayChange {
  const lines = value.split('\n')
  const realStarts: number[] = []
  let acc = 0
  for (const l of lines) {
    realStarts.push(acc)
    acc += l.length + 1
  }
  const dispStarts: number[] = []
  acc = 0
  for (const i of visible) {
    dispStarts.push(acc)
    acc += lines[i].length + 1
  }
  const oldLen = acc - 1

  // Splice: common prefix / suffix between the old and new display text.
  const oldDisplay = visible.map((i) => lines[i]).join('\n')
  const max = Math.min(oldDisplay.length, newDisplay.length)
  let p = 0
  while (p < max && oldDisplay.charCodeAt(p) === newDisplay.charCodeAt(p)) p++
  let s = 0
  while (s < max - p && oldDisplay.charCodeAt(oldLen - 1 - s) === newDisplay.charCodeAt(newDisplay.length - 1 - s)) s++
  const oldEnd = oldLen - s
  const ins = newDisplay.slice(p, newDisplay.length - s)

  const locate = (off: number): number => {
    let lo = 0
    let hi = dispStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (dispStarts[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const startD = locate(p)
  const endD = locate(oldEnd)
  const startLine = visible[startD]
  const endLine = visible[endD]
  const realStart = realStarts[startLine] + (p - dispStarts[startD])
  const realEnd = realStarts[endLine] + (oldEnd - dispStarts[endD])

  const spansHidden = endLine - startLine > endD - startD
  if (spansHidden && oldEnd - p <= 1) {
    return {
      value,
      caret: realStart,
      rejected: true,
      startLine,
      endLine,
      lineDelta: 0,
      unfold: { from: startLine, to: endLine }
    }
  }

  let from = realStart
  let to = realEnd
  let fromLine = startLine
  let toLine = endLine
  if (p === oldEnd && ins.startsWith('\n')) {
    // Insertion at the end of a display line that has a fold under it.
    const nextReal = startD + 1 < visible.length ? visible[startD + 1] : lines.length
    const lastHidden = nextReal - 1
    if (lastHidden > startLine && p - dispStarts[startD] === lines[startLine].length) {
      from = to = realStarts[lastHidden] + lines[lastHidden].length
      fromLine = toLine = lastHidden
    }
  }
  return {
    value: value.slice(0, from) + ins + value.slice(to),
    caret: from + ins.length,
    rejected: false,
    startLine: fromLine,
    endLine: toLine,
    lineDelta: countNewlines(ins) - countNewlines(value.slice(from, to)),
    unfold: null
  }
}

/** Move fold start lines to follow an edit that replaced lines `startLine..endLine`. */
export function shiftFolds(folded: ReadonlySet<number>, startLine: number, endLine: number, delta: number): Set<number> {
  const out = new Set<number>()
  for (const f of folded) {
    if (f <= startLine) out.add(f)
    else if (f > endLine) out.add(f + delta)
  }
  return out
}

/** Real offset -> display offset; a caret inside a fold lands at the end of the fold's line. */
export function realToDisplayOffset(value: string, visible: readonly number[] | null, offset: number): number {
  if (!visible) return offset
  const lines = value.split('\n')
  let acc = 0
  let realLine = 0
  let col = 0
  for (let i = 0; i < lines.length; i++) {
    if (offset <= acc + lines[i].length) {
      realLine = i
      col = offset - acc
      break
    }
    acc += lines[i].length + 1
    realLine = i
    col = lines[i].length
  }
  let d = 0
  let disp = 0
  for (let k = 0; k < visible.length; k++) {
    if (visible[k] > realLine) break
    d = k
    if (k > 0) disp += lines[visible[k - 1]].length + 1
  }
  const at = visible[d]
  return disp + (at === realLine ? col : lines[at].length)
}

/** Display offset -> real offset. */
export function displayToRealOffset(value: string, visible: readonly number[] | null, offset: number): number {
  if (!visible) return offset
  const lines = value.split('\n')
  const realStarts: number[] = []
  let acc = 0
  for (const l of lines) {
    realStarts.push(acc)
    acc += l.length + 1
  }
  let disp = 0
  for (const i of visible) {
    const len = lines[i].length
    if (offset <= disp + len) return realStarts[i] + (offset - disp)
    disp += len + 1
  }
  return value.length
}

/** Rendered width of a line in columns, expanding tabs the way the browser does. */
export function expandedWidth(text: string, tabSize: number): number {
  let col = 0
  for (let i = 0; i < text.length; i++) col = text[i] === '\t' ? (Math.floor(col / tabSize) + 1) * tabSize : col + 1
  return col
}

/**
 * Height of one editor line, and the top edge of DISPLAY line `displayLine`
 * (0-based) in the editor's content box: py-3 then 1.6 line-heights per line.
 *
 * These are `em`/`ch` lengths, so they only land on the text when the element
 * they are set on has the editor's own font size. An overlay that shrinks its
 * font (a small chip label) must be wrapped in a box that is positioned with
 * these and keeps the inherited font: `1.6em` inside `text-[10px]` is 16px, not
 * 19.2px, and everything drifts up by 3.2px per line above it.
 */
export const EDITOR_LINE_HEIGHT = '1.6em'
export function editorLineTop(displayLine: number): string {
  return `calc(0.75rem + ${displayLine} * ${EDITOR_LINE_HEIGHT})`
}

/** Where a fold's `...` chip goes: after its header line, on screen. */
export interface FoldChip {
  /** Real line of the fold's header (the line that stays visible). */
  line: number
  /** Its index in the display text, which is what the screen position follows. */
  displayLine: number
  /** Column (in `ch`) the chip starts at: one space past the header's text. */
  column: number
  /** How many lines are hidden. */
  hidden: number
}

/** One chip per folded range that is on screen. A fold nested in a folded range is hidden with it. */
export function foldChips(
  lines: readonly string[],
  visible: readonly number[],
  ranges: ReadonlyMap<number, FoldRange>,
  folded: ReadonlySet<number>,
  tabSize: number
): FoldChip[] {
  const out: FoldChip[] = []
  visible.forEach((real, displayLine) => {
    const r = folded.has(real) ? ranges.get(real) : undefined
    // A CRLF file's `\r` takes no room on screen.
    const text = lines[real].endsWith('\r') ? lines[real].slice(0, -1) : lines[real]
    if (r) out.push({ line: real, displayLine, column: expandedWidth(text, tabSize) + 1, hidden: r.end - r.start })
  })
  return out
}
