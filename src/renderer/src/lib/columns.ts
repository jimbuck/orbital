/**
 * Columns: where a character is drawn on a monospace, wrap-off line.
 *
 * A column is a TAB-EXPANDED cell, not a character index — a tab advances to
 * the next multiple of the tab size, the way the browser renders it. Everything
 * that draws over the editor's text (find highlights, fold chips) or reads a
 * line's indentation works in these, so the arithmetic lives here once.
 */

/** The CSS initial value for `tab-size`. */
export const DEFAULT_TAB_SIZE = 8

/** Read a computed `tab-size` (`"8"`, or a length this code cannot use) as columns. */
export function parseTabSize(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10)
  // A length value ("32px") parses to a number that is not a column count, but
  // there is no way to tell the two apart from the string alone — clamping to a
  // sane range is enough to keep the arithmetic from going strange.
  return Number.isFinite(n) && n >= 1 && n <= 16 ? n : DEFAULT_TAB_SIZE
}

/** The column the next character starts at, after `ch` drawn at `column`. */
export function columnAfter(column: number, ch: string, tabSize: number): number {
  return ch === '\t' ? (Math.floor(column / tabSize) + 1) * tabSize : column + 1
}

/** Rendered width of a line (or the start of one) in columns. */
export function expandedWidth(text: string, tabSize: number): number {
  let column = 0
  for (let i = 0; i < text.length; i++) column = columnAfter(column, text[i], tabSize)
  return column
}

/** The column a line's first non-blank character sits at, or -1 for a blank line. */
export function indentOf(line: string, tabSize: number): number {
  let column = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch !== ' ' && ch !== '\t') return column
    column = columnAfter(column, ch, tabSize)
  }
  return -1
}
