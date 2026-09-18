/**
 * In-file find: where every occurrence of a query is, in the two coordinate
 * systems the editor needs.
 *
 * Offsets (`start`/`end`) are what the textarea's selection API speaks, so the
 * caret can be put on a match and left there when the find bar closes. Line and
 * column are what the highlight overlay is drawn in — the code view is
 * monospace with `wrap="off"`, so a rectangle at `column` ch on `line` sits
 * exactly over its text, the same assumption the line gutter's `ch` widths
 * already make.
 *
 * Columns are TAB-EXPANDED, i.e. what the browser actually renders, not the
 * character index. A file indented with tabs would otherwise have every
 * highlight on the wrong side of the screen.
 */

export interface FindMatch {
  /** Offsets into the source text — what setSelectionRange takes. */
  start: number
  end: number
  /** 1-based line the match is on. A query cannot contain a newline, so it is one line. */
  line: number
  /** Tab-expanded column of the match's first character, 0-based. */
  column: number
  /** Tab-expanded width, in columns. */
  width: number
}

export interface FindOptions {
  caseSensitive: boolean
  /** Columns a tab advances to the next multiple of — the CSS `tab-size`. */
  tabSize: number
}

/** The CSS initial value for `tab-size`, and what the editor renders with. */
export const DEFAULT_TAB_SIZE = 8

/** Read a computed `tab-size` (`"8"`, or a length this code cannot use) as columns. */
export function parseTabSize(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10)
  // A length value ("32px") parses to a number that is not a column count, but
  // there is no way to tell the two apart from the string alone — clamping to a
  // sane range is enough to keep the arithmetic from going strange.
  return Number.isFinite(n) && n >= 1 && n <= 16 ? n : DEFAULT_TAB_SIZE
}

/**
 * Every non-overlapping occurrence of `query` in `text`, in document order.
 *
 * An empty query has no matches — a find box you have not typed in yet should
 * report nothing, not every position in the file. Matching is plain substring,
 * not regex: the box is for finding a symbol, and a stray `(` turning into a
 * syntax error (or a catastrophic backtrack) is a poor trade for the one person
 * who wanted a character class.
 */
export function findMatches(text: string, query: string, { caseSensitive, tabSize }: FindOptions): FindMatch[] {
  if (!query) return []
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const out: FindMatch[] = []

  // One forward walk for the line/column bookkeeping: the matches come out of
  // indexOf in increasing order, so the cursor never has to go back.
  let line = 1
  let column = 0
  let cursor = 0
  const advanceTo = (offset: number): void => {
    for (; cursor < offset; cursor++) {
      const ch = text[cursor]
      if (ch === '\n') {
        line += 1
        column = 0
      } else if (ch === '\t') {
        column = (Math.floor(column / tabSize) + 1) * tabSize
      } else {
        column += 1
      }
    }
  }

  let from = 0
  for (;;) {
    const start = haystack.indexOf(needle, from)
    if (start === -1) break
    const end = start + needle.length
    advanceTo(start)
    const startColumn = column
    const startLine = line
    advanceTo(end)
    out.push({ start, end, line: startLine, column: startColumn, width: column - startColumn })
    // Non-overlapping: "aa" in "aaaa" is two matches, not three.
    from = end
  }
  return out
}

/**
 * The match to step to from `caret`, wrapping at the ends.
 *
 * Forward lands on the first match starting at or after the caret, backward on
 * the last one starting before it — so Enter from wherever you were editing
 * goes on from there, rather than restarting at the top of the file. Returns -1
 * when there is nothing to step to.
 */
export function nextMatchIndex(matches: readonly FindMatch[], caret: number, forward: boolean): number {
  if (matches.length === 0) return -1
  if (forward) {
    const i = matches.findIndex((m) => m.start >= caret)
    return i === -1 ? 0 : i
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].start < caret) return i
  }
  return matches.length - 1
}
