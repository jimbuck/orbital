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
  /** Only matches with no word character on either side ("Match Whole Word"). */
  wholeWord?: boolean
  /** Treat the query as a JavaScript regular expression. */
  regex?: boolean
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

/** A word character, in the sense "Match Whole Word" draws its boundaries with. */
const WORD = /[\p{L}\p{N}_$]/u

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch)
}

/** True when `start..end` has no word character pressed up against either end. */
function atWordBounds(text: string, start: number, end: number): boolean {
  return !isWordChar(text[start - 1]) && !isWordChar(text[end])
}

/**
 * The query as a RegExp with the given extra flags, or null when it does not
 * compile. Multiline, so `^` and `$` mean the start and end of a LINE — which is
 * what someone typing them into a code editor's find box means.
 */
function compile(query: string, caseSensitive: boolean, flags: string): RegExp | null {
  try {
    return new RegExp(query, `${flags}m${caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
}

/** Why a regex query cannot be searched for, or null when it can (or is not a regex). */
export function findError(query: string, { regex, caseSensitive }: FindOptions): string | null {
  if (!regex || !query) return null
  try {
    new RegExp(query, `m${caseSensitive ? '' : 'i'}`)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid regular expression'
  }
}

/** Raw [start, end) spans of every match, before the line/column bookkeeping. */
function rawSpans(text: string, query: string, { caseSensitive, wholeWord, regex }: FindOptions): [number, number][] {
  const out: [number, number][] = []
  if (regex) {
    const re = compile(query, caseSensitive, 'g')
    if (!re) return out
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index
      const end = start + m[0].length
      // An empty match (`^`, `a*`) is a position, not something to highlight or
      // replace — and left alone it would spin exec on the same index forever.
      if (end === start) {
        re.lastIndex = start + 1
        continue
      }
      // Matches stay on one line: the highlights are drawn a line at a time,
      // and a replacement that ate a newline would shift every fold below it.
      if (m[0].includes('\n')) continue
      if (wholeWord && !atWordBounds(text, start, end)) continue
      out.push([start, end])
    }
    return out
  }
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  let from = 0
  for (;;) {
    const start = haystack.indexOf(needle, from)
    if (start === -1) break
    const end = start + needle.length
    if (wholeWord && !atWordBounds(text, start, end)) {
      // Not a word here, but one could still start inside it ("aa" in "a aa").
      from = start + 1
      continue
    }
    out.push([start, end])
    // Non-overlapping: "aa" in "aaaa" is two matches, not three.
    from = end
  }
  return out
}

/**
 * Every non-overlapping occurrence of `query` in `text`, in document order.
 *
 * An empty query has no matches — a find box you have not typed in yet should
 * report nothing, not every position in the file. Plain substring by default;
 * regex only when asked for, and a pattern that does not compile matches
 * nothing (see `findError` for the reason to show). Matches never span lines.
 */
export function findMatches(text: string, query: string, options: FindOptions): FindMatch[] {
  if (!query) return []
  const { tabSize } = options
  const out: FindMatch[] = []

  // One forward walk for the line/column bookkeeping: the matches come out in
  // increasing order, so the cursor never has to go back.
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

  for (const [start, end] of rawSpans(text, query, options)) {
    advanceTo(start)
    const startColumn = column
    const startLine = line
    advanceTo(end)
    out.push({ start, end, line: startLine, column: startColumn, width: column - startColumn })
  }
  return out
}

/**
 * The text a match is replaced with. Literal for a plain query; for a regex,
 * `$1`, `$&`, `$<name>` and friends expand against THIS match, evaluated in the
 * full text so lookbehinds and anchors see what they saw when it was found.
 */
export function replacementFor(
  text: string,
  match: Pick<FindMatch, 'start' | 'end'>,
  query: string,
  replacement: string,
  { regex, caseSensitive }: FindOptions
): string {
  if (!regex) return replacement
  // Sticky and non-global: String.replace then honours lastIndex, so it
  // replaces the one match that starts exactly here and nothing else.
  const re = compile(query, caseSensitive, 'y')
  if (!re) return replacement
  re.lastIndex = match.start
  const out = text.replace(re, replacement)
  return out.slice(match.start, out.length - (text.length - match.end))
}

/** `text` with every match swapped for its replacement, in one pass. */
export function replaceAll(
  text: string,
  matches: readonly Pick<FindMatch, 'start' | 'end'>[],
  query: string,
  replacement: string,
  options: FindOptions
): string {
  let out = ''
  let last = 0
  for (const m of matches) {
    out += text.slice(last, m.start) + replacementFor(text, m, query, replacement, options)
    last = m.end
  }
  return out + text.slice(last)
}

/**
 * The text a selection highlights elsewhere in the file, or null when it should
 * not: an empty or multi-line selection, blank space, or something so long that
 * a second copy of it is not what anyone is looking for.
 */
export function selectionQuery(text: string, start: number, end: number): string | null {
  if (end <= start || end - start > 200) return null
  const selected = text.slice(start, end)
  if (selected.includes('\n') || !selected.trim()) return null
  return selected
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
