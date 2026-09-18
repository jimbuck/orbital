/**
 * Orbital — fuzzy subsequence matching.
 *
 * One scorer shared by the command palette (labels, worktree names, task
 * titles) and the main-process file search, so a query ranks the same wherever
 * it is typed. Nothing here imports Node or Electron.
 *
 * The match is a plain left-to-right subsequence scan rather than the full
 * dynamic-programming alignment fzf-style tools use. That matters because the
 * file search runs this over every tracked path in every Worktree on each
 * keystroke: an O(n·m) alignment per candidate turns a 100k-path workspace into
 * a visible stall, while a greedy scan stays linear in the target. The cost is
 * that a pathological target ("aXa" queried with "aa") can score lower than its
 * best possible alignment — acceptable for ranking a list a human is about to
 * read.
 */

/** Characters after which the next character starts a new "word". */
const SEPARATORS = new Set(['/', '\\', '-', '_', '.', ' ', ':', '@'])

export interface FuzzyResult {
  /** Higher is a better match. Only comparable between candidates of one query. */
  score: number
  /** Indices in the target matched by the query, in order — for highlighting. */
  positions: number[]
}

/** Whether `index` in `target` begins a word (string start, or after a separator). */
function startsWord(target: string, index: number): boolean {
  return index === 0 || SEPARATORS.has(target[index - 1])
}

/**
 * What one matched character is worth. The bonuses encode what people actually
 * aim at when they type an abbreviation: the starts of words, and runs of
 * characters typed together.
 */
function charScore(target: string, index: number, lastMatch: number): number {
  let score = 1
  // A run of consecutive matches is the strongest signal there is — it means
  // the user typed a literal fragment of the target.
  if (index === lastMatch + 1) score += 6
  if (index === 0) score += 10
  else if (SEPARATORS.has(target[index - 1])) score += 8
  else {
    // camelCase boundary: `S` in `TabStrip`.
    const prev = target[index - 1]
    const here = target[index]
    if (prev === prev.toLowerCase() && here !== here.toLowerCase()) score += 6
  }
  return score
}

/**
 * Score `query` against `target`, or null when `query` is not a subsequence of
 * it. An empty query matches everything with score 0, so callers can use the
 * same code path for the unfiltered list.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (query === '') return { score: 0, positions: [] }
  if (query.length > target.length) return null

  const q = query.toLowerCase()
  const t = target.toLowerCase()

  // The latest index each query character may be matched at while the rest of
  // the query still fits after it. One backward pass, and it doubles as the
  // "is this a subsequence at all" test. The forward pass below needs it
  // because its word-start preference moves a match later in the target, and
  // without a ceiling that hop can jump past the only position that leaves room
  // for the characters still to come — turning a perfectly good match into a
  // miss ("store" against "src/renderer/store.ts" would take the `t` of `.ts`).
  const latest = new Array<number>(q.length)
  let ceiling = t.length - 1
  for (let qi = q.length - 1; qi >= 0; qi--) {
    const at = t.lastIndexOf(q[qi], ceiling)
    if (at === -1) return null
    latest[qi] = at
    ceiling = at - 1
  }

  const positions: number[] = []
  let score = 0
  let from = 0
  let lastMatch = -2

  for (let qi = 0; qi < q.length; qi++) {
    let at = t.indexOf(q[qi], from)
    if (at === -1) return null
    // Greedy takes the first occurrence, which loses the word-start bonus for a
    // query like "cp" against "Compare Palette" (the `p` of `Compare` wins over
    // the `p` of `Palette`). Peek ahead: if a word-start occurrence of the same
    // character sits close by, and taking it still leaves room for the rest of
    // the query, prefer it. Bounded twice over — by `latest` and by a fixed
    // window — so this stays a tie-break rather than a search.
    // ...but never at the cost of breaking a run. A character that continues
    // the previous match means the user is typing a literal fragment, which
    // outranks any word start further along ("stage" must stay inside "Stage",
    // not hop to the `A` of "All").
    if (!startsWord(target, at) && at !== lastMatch + 1) {
      const limit = Math.min(latest[qi], at + 24)
      for (let j = t.indexOf(q[qi], at + 1); j !== -1 && j <= limit; j = t.indexOf(q[qi], j + 1)) {
        if (startsWord(target, j)) {
          at = j
          break
        }
      }
    }
    positions.push(at)
    score += charScore(target, at, lastMatch)
    lastMatch = at
    from = at + 1
  }

  // Tighter matches win: the fewer unmatched characters the target carries, the
  // more of it the user actually typed.
  score += Math.max(0, 12 - Math.floor((target.length - q.length) / 4))
  return { score, positions }
}

/**
 * Score `query` against a `/`-separated path, favouring matches in the file
 * name. Someone typing `store` means `src/renderer/src/store.ts`, not the
 * deepest file under a `store/` directory — unless they typed a separator
 * themselves, in which case the whole-path match speaks for itself and wins on
 * its own score.
 */
export function fuzzyMatchPath(query: string, path: string): FuzzyResult | null {
  const full = fuzzyMatch(query, path)
  const cut = path.lastIndexOf('/')
  if (cut === -1) return full

  const base = fuzzyMatch(query, path.slice(cut + 1))
  if (!base) return full
  const shifted: FuzzyResult = {
    score: base.score + 15,
    positions: base.positions.map((p) => p + cut + 1)
  }
  return !full || shifted.score >= full.score ? shifted : full
}
