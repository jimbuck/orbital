/**
 * Code folding for the plain-textarea editor.
 *
 * A textarea cannot hide lines, so folding works on a DISPLAY copy of the file:
 * the textarea shows the source with the folded lines removed, and every edit
 * made in it is mapped back onto the real text. That makes two coordinate
 * spaces — the DOCUMENT (the real text: its lines and offsets) and the DISPLAY
 * (what is on screen: rows, and offsets into the shown text) — and a
 * `FoldProjection` is the one thing that knows how they relate. Callers build
 * one per text-and-folds and ask it; they never hold the mapping themselves.
 *
 * Lines and rows are 0-based. Fold ranges are structural, not language-
 * specific: shiki gives us tokens, not a syntax tree, so ranges come from
 * indentation (which covers braces, Python, YAML, JSON, HTML ...) and, for
 * Markdown, from heading levels.
 */
import { expandedWidth, indentOf } from './columns'

/** Lines `start + 1 .. end` (inclusive) collapse into line `start`. */
export interface FoldRange {
  start: number
  end: number
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
    if (indent < 0) continue // blank line: takes no part in the structure
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

/** A line that can fold, and where its marker goes. */
export interface FoldMarker {
  /** Display row the line is on. */
  row: number
  /** The document line: what to pass back to `toggle`. */
  line: number
  folded: boolean
}

/** Where a fold's `...` chip goes: after its header line, on screen. */
export interface FoldChip {
  /** Display row of the fold's header (the line that stays visible). */
  row: number
  /** The header's document line: what to pass back to `toggle`. */
  line: number
  /** Column the chip starts at: one space past the header's text. */
  column: number
  /** How many lines are hidden. */
  hidden: number
}

/** What an edit made in the display text means for the document. */
export interface FoldEdit {
  /** The full document text afterwards. Unchanged when `rejected`. */
  value: string
  /** Document offset the caret belongs at afterwards. */
  caret: number
  /**
   * The folds afterwards: moved to follow the lines the edit added or removed,
   * or — when `rejected` — with the fold the edit ran into opened.
   */
  folds: ReadonlySet<number>
  /**
   * The edit would have eaten the newline in front of a folded block (Backspace
   * or Delete beside a fold). Nothing is deleted; the fold opens instead, so
   * nobody deletes code they cannot see.
   */
  rejected: boolean
}

/**
 * One text with some of its ranges folded: what is on screen, and how every
 * position on screen relates to the document.
 */
export interface FoldProjection {
  /** The text to show. The document text itself when nothing is folded. */
  readonly text: string
  /** Whether anything is hidden. */
  readonly isFolded: boolean
  /** The folds in effect, by header line: the ones asked for that still start a range. */
  readonly folds: ReadonlySet<number>
  /** Lines in the document, and rows on screen. */
  readonly lineCount: number
  readonly rowCount: number
  /** The document line shown on a row. */
  lineAt(row: number): number
  /** The row a document line is on, or -1 while it is hidden in a fold. */
  rowOf(line: number): number
  /** The document line a display offset (a textarea caret) is on. */
  lineAtOffset(displayOffset: number): number
  /** Display offset -> document offset. */
  toDocument(displayOffset: number): number
  /** Document offset -> display offset; one inside a fold lands at the end of the fold's header. */
  toDisplay(documentOffset: number): number
  /** Every line on screen that starts a range, in row order. */
  readonly markers: readonly FoldMarker[]
  /** One chip per fold on screen. A fold nested in a folded range is hidden with it. */
  readonly chips: readonly FoldChip[]
  /**
   * Shiki's markup for the document, cut down to the lines on screen. Shiki
   * emits one `<span class="line">` per line joined by literal newlines, and a
   * token cannot contain one, so its lines are this text's lines.
   */
  filterHtml(html: string): string
  /** The folds with the innermost open range around `line` folded, or null when there is none. */
  fold(line: number): ReadonlySet<number> | null
  /** The folds with the range starting at `line` flipped. */
  toggle(line: number): ReadonlySet<number>
  /** The folds with every fold hiding `line` opened. */
  reveal(line: number): ReadonlySet<number>
  /**
   * Apply an edit made in the display text — `next` is the textarea's new
   * value — to the document.
   *
   * The edit is recovered as a common-prefix / common-suffix diff, exactly the
   * splice a textarea `input` event describes, and its two ends are mapped to
   * the document. A range that spans a fold therefore deletes the folded lines
   * too (a deliberate selection-delete does what it says), but a lone
   * Backspace/Delete next to a fold is refused, and Enter at the end of a
   * folded line opens the new line AFTER the fold rather than inside it.
   */
  edit(next: string): FoldEdit
}

export const NO_FOLDS: ReadonlySet<number> = new Set()

const NO_MARKERS: readonly FoldMarker[] = []
const NO_CHIPS: readonly FoldChip[] = []

/** Offset each of `count` lines starts at, each being followed by one newline. */
function startsOf(count: number, length: (i: number) => number): number[] {
  const starts = new Array<number>(count)
  let acc = 0
  for (let i = 0; i < count; i++) {
    starts[i] = acc
    acc += length(i) + 1
  }
  return starts
}

/** Index of the last entry of an ascending list that is <= `value` (0 when none is). */
function lastAtOrBefore(sorted: readonly number[], value: number): number {
  let lo = 0
  let hi = sorted.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sorted[mid] <= value) lo = mid
    else hi = mid - 1
  }
  return lo
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return n
}

/**
 * Repo `value` with the ranges starting at the `folded` lines collapsed.
 * `tabSize` and `lang` decide where the ranges are (see `computeFoldRanges`).
 *
 * The line tables are built once, on first use, and shared by every question
 * asked of the projection; with nothing folded and no offset asked about none
 * is built at all, and the projection is the identity.
 */
export function foldProjection(
  value: string,
  folded: ReadonlySet<number>,
  options: { tabSize: number; lang?: string | null }
): FoldProjection {
  const lines = value.split('\n')
  const lineCount = lines.length
  const ranges = computeFoldRanges(lines, options.tabSize, options.lang)

  // An edit can leave a fold pointing at a line that no longer starts a block.
  let folds = NO_FOLDS
  if (folded.size > 0) {
    const kept = new Set<number>()
    for (const f of folded) if (ranges.has(f)) kept.add(f)
    if (kept.size > 0) folds = kept
  }
  const isFolded = folds.size > 0

  // Document lines on screen, in order: the row -> line map. Null is the identity.
  let rows: number[] | null = null
  if (isFolded) {
    rows = []
    for (let i = 0; i < lineCount; ) {
      rows.push(i)
      const r = folds.has(i) ? ranges.get(i) : undefined
      i = r ? r.end + 1 : i + 1
    }
  }
  const shown = rows
  const rowCount = shown ? shown.length : lineCount
  const text = shown ? shown.map((i) => lines[i]).join('\n') : value
  const lineAt = (row: number): number => (shown ? shown[row] : row)

  let lineStartsCache: number[] | null = null
  const lineStarts = (): number[] => (lineStartsCache ??= startsOf(lineCount, (i) => lines[i].length))
  let rowStartsCache: number[] | null = null
  const rowStarts = (): number[] =>
    shown ? (rowStartsCache ??= startsOf(shown.length, (r) => lines[shown[r]].length)) : lineStarts()
  const rowAtOffset = (displayOffset: number): number => lastAtOrBefore(rowStarts(), displayOffset)

  const toDocument = (displayOffset: number): number => {
    if (!shown) return displayOffset
    if (displayOffset > text.length) return value.length
    const row = rowAtOffset(displayOffset)
    return lineStarts()[shown[row]] + (displayOffset - rowStarts()[row])
  }

  const toDisplay = (documentOffset: number): number => {
    if (!shown) return documentOffset
    const line = lastAtOrBefore(lineStarts(), documentOffset)
    const column = Math.min(documentOffset - lineStarts()[line], lines[line].length)
    // The last row at or above the line: the line itself, or its fold's header.
    const row = lastAtOrBefore(shown, line)
    const at = shown[row]
    return rowStarts()[row] + (at === line ? column : lines[at].length)
  }

  const markers = (): readonly FoldMarker[] => {
    if (ranges.size === 0) return NO_MARKERS
    const out: FoldMarker[] = []
    for (let row = 0; row < rowCount; row++) {
      const line = lineAt(row)
      if (ranges.has(line)) out.push({ row, line, folded: folds.has(line) })
    }
    return out
  }

  const chips = (): readonly FoldChip[] => {
    if (!shown) return NO_CHIPS
    const out: FoldChip[] = []
    shown.forEach((line, row) => {
      const r = folds.has(line) ? ranges.get(line) : undefined
      if (!r) return
      // A CRLF file's `\r` takes no room on screen.
      const header = lines[line].endsWith('\r') ? lines[line].slice(0, -1) : lines[line]
      out.push({ row, line, column: expandedWidth(header, options.tabSize) + 1, hidden: r.end - r.start })
    })
    return out
  }

  /**
   * The folds after an edit that replaced lines `startLine..endLine`, changing
   * the count by `delta`. A fold above the edit stays, one below moves with its
   * line, and one whose header the edit ran through is dropped — except the
   * header on `startLine`, which was edited in place and keeps its fold for as
   * long as it still starts a block.
   *
   * `endLineIntact` says the edit stopped at the very start of `endLine` and
   * left it a whole line: lines inserted in front of it, or whole lines deleted
   * above it. That line was pushed, not edited, so a fold on it moves too. It
   * matters because of how a textarea reports Enter at the end of a line: as a
   * newline inserted at the start of the NEXT line.
   */
  const shifted = (startLine: number, endLine: number, delta: number, endLineIntact: boolean): ReadonlySet<number> => {
    const out = new Set<number>()
    for (const f of folds) {
      if (f > endLine || (f === endLine && endLineIntact)) out.add(f + delta)
      else if (f <= startLine) out.add(f)
    }
    return out
  }

  const edit = (next: string): FoldEdit => {
    if (!shown) return { value: next, caret: next.length, folds, rejected: false }
    const docStarts = lineStarts()
    const dispStarts = rowStarts()
    const oldLen = text.length

    // Splice: common prefix / suffix between the old and new display text.
    const max = Math.min(oldLen, next.length)
    let p = 0
    while (p < max && text.charCodeAt(p) === next.charCodeAt(p)) p++
    let s = 0
    while (s < max - p && text.charCodeAt(oldLen - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++
    const oldEnd = oldLen - s
    const ins = next.slice(p, next.length - s)

    const startRow = rowAtOffset(p)
    const endRow = rowAtOffset(oldEnd)
    const startLine = shown[startRow]
    const endLine = shown[endRow]
    const docStart = docStarts[startLine] + (p - dispStarts[startRow])
    const docEnd = docStarts[endLine] + (oldEnd - dispStarts[endRow])

    const spansHidden = endLine - startLine > endRow - startRow
    if (spansHidden && oldEnd - p <= 1) {
      const opened = new Set(folds)
      for (const f of folds) if (f >= startLine && f < endLine) opened.delete(f)
      return { value, caret: docStart, folds: opened, rejected: true }
    }

    let from = docStart
    let to = docEnd
    let fromLine = startLine
    let toLine = endLine
    if (p === oldEnd && ins.startsWith('\n')) {
      // Insertion at the end of a display line that has a fold under it.
      const nextShown = startRow + 1 < shown.length ? shown[startRow + 1] : lineCount
      const lastHidden = nextShown - 1
      if (lastHidden > startLine && p - dispStarts[startRow] === lines[startLine].length) {
        from = to = docStarts[lastHidden] + lines[lastHidden].length
        fromLine = toLine = lastHidden
      }
    }
    const lineDelta = countNewlines(ins) - countNewlines(value.slice(from, to))
    // Whether what follows the edit is still line `toLine`, whole: the edit
    // ended at its first character, and what now precedes it ends a line.
    const endLineIntact =
      to === docStarts[toLine] && (ins === '' ? from === docStarts[fromLine] : ins.endsWith('\n'))
    return {
      value: value.slice(0, from) + ins + value.slice(to),
      caret: from + ins.length,
      folds: shifted(fromLine, toLine, lineDelta, endLineIntact),
      rejected: false
    }
  }

  let markersCache: readonly FoldMarker[] | null = null
  let chipsCache: readonly FoldChip[] | null = null

  return {
    text,
    isFolded,
    folds,
    lineCount,
    rowCount,
    lineAt,
    rowOf: (line) => (shown ? shown.indexOf(line) : line),
    lineAtOffset: (displayOffset) => lineAt(rowAtOffset(displayOffset)),
    toDocument,
    toDisplay,
    get markers() {
      return (markersCache ??= markers())
    },
    get chips() {
      return (chipsCache ??= chips())
    },
    filterHtml: (html) => {
      if (!shown) return html
      const keep = new Set(shown)
      // The last piece (the mirror's spare trailing line) is never hidden, so
      // the closing tags survive.
      return html
        .split('\n')
        .filter((_, i) => i >= lineCount || keep.has(i))
        .join('\n')
    },
    fold: (line) => {
      // The innermost not-yet-folded range that contains the line (starting on
      // it, if one does).
      let best: FoldRange | null = null
      for (const r of ranges.values()) {
        if (folds.has(r.start) || r.start > line || r.end < line) continue
        if (!best || r.start > best.start) best = r
      }
      return best ? new Set(folds).add(best.start) : null
    },
    toggle: (line) => {
      const out = new Set(folds)
      if (!out.delete(line)) out.add(line)
      return out
    },
    reveal: (line) => {
      const out = new Set(folds)
      for (const f of folds) {
        const r = ranges.get(f)
        if (r && r.start < line && line <= r.end) out.delete(f)
      }
      return out
    },
    edit
  }
}
