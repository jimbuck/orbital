import type { JSX } from 'react'

/**
 * Text with some of it picked out — the matched characters of a fuzzy hit in
 * the palette, the matched substrings of a content-search line.
 *
 * One component for both so a match looks the same wherever it is shown, and
 * so the off-by-one hazards of slicing around ranges live in one place.
 */

/**
 * Collapse a sorted list of matched character indices into `[start, end)`
 * ranges. Fuzzy matching reports individual characters; this is what turns a
 * run of them into one highlighted span rather than a row of single letters.
 */
export function positionsToRanges(positions: number[] | undefined): [number, number][] {
  if (!positions || positions.length === 0) return []
  const out: [number, number][] = []
  let start = positions[0]
  let prev = positions[0]
  for (let i = 1; i < positions.length; i++) {
    const p = positions[i]
    if (p === prev + 1) {
      prev = p
      continue
    }
    out.push([start, prev + 1])
    start = p
    prev = p
  }
  out.push([start, prev + 1])
  return out
}

export function Marked({
  text,
  ranges,
  className = 'font-bold text-accent'
}: {
  text: string
  /** `[start, end)` offsets into `text`. Assumed sorted and non-overlapping. */
  ranges: [number, number][]
  /** Classes for the highlighted spans. */
  className?: string
}): JSX.Element {
  if (ranges.length === 0) return <>{text}</>
  const parts: JSX.Element[] = []
  let at = 0
  for (const [start, end] of ranges) {
    // Defensive against ranges that overlap or run backwards: a bad range must
    // drop its highlight, never drop or duplicate the text around it.
    const from = Math.max(at, Math.min(start, text.length))
    const to = Math.max(from, Math.min(end, text.length))
    if (from > at) parts.push(<span key={`p${at}`}>{text.slice(at, from)}</span>)
    if (to > from) {
      parts.push(
        <span key={`m${from}`} className={className}>
          {text.slice(from, to)}
        </span>
      )
    }
    at = to
  }
  if (at < text.length) parts.push(<span key={`p${at}`}>{text.slice(at)}</span>)
  return <>{parts}</>
}
