import type { GitCommit } from '@shared/types'

/**
 * Lane layout for a commit graph, the way `git log --graph` draws one: each
 * commit gets a lane (column); a lane carries on down to the commit's first
 * parent, a merge's other parents fork off into their own lanes, and a lane
 * ends by curving into another when the commit it wanted next is already that
 * lane's next stop.
 *
 * Pure and row-local so the modal can render each row as its own small SVG:
 * everything a row draws is in its GraphRow — which lanes pass straight
 * through, and where this node's parent lines leave the row (`outbound`).
 *
 * The input must be in topological order, newest first (`git log
 * --topo-order`), so a parent never appears before its child: a lane's
 * "waiting for hash X" promise is always resolved further down.
 */

/** Number of distinct lane colours; lanes cycle through them in allocation order. */
export const GRAPH_COLOR_COUNT = 6

export interface GraphEdge {
  /** Lane at the top of the segment — always the node's lane. */
  from: number
  /** Lane at the bottom of the segment. */
  to: number
  color: number
}

export interface GraphRow {
  /** Lane holding this commit's node. */
  lane: number
  /** Colour index of the node and of the line continuing to its first parent. */
  color: number
  /** True for a merge (more than one parent) — drawn as a hollow node. */
  merge: boolean
  /**
   * True when nothing above pointed at this commit (a branch tip, or the
   * first row of a page) — there is no line arriving from the row above.
   */
  tip: boolean
  /** Lines from the node to the row's bottom edge, one per parent. */
  outbound: GraphEdge[]
  /** Lanes that pass this row untouched, top edge to bottom edge. */
  through: { lane: number; color: number }[]
  /** Lanes this row touches, for sizing: max lane index + 1. */
  width: number
}

interface Lane {
  /** The commit this lane is waiting to reach. */
  hash: string
  color: number
}

export function layoutGraph(commits: readonly GitCommit[]): GraphRow[] {
  const active: (Lane | null)[] = []
  let nextColor = 0
  const allocColor = (): number => nextColor++ % GRAPH_COLOR_COUNT
  const freeSlot = (): number => {
    const i = active.indexOf(null)
    return i === -1 ? active.length : i
  }
  const laneWaitingFor = (hash: string): number => active.findIndex((a) => a?.hash === hash)

  const rows: GraphRow[] = []
  for (const c of commits) {
    // 1. The node sits in the lane that was waiting for this commit, or a new
    //    one (a branch tip nothing above it points at). At most one lane can
    //    be waiting: a parent already awaited is joined, never awaited twice.
    let lane = laneWaitingFor(c.hash)
    let color: number
    const tip = lane === -1
    if (tip) {
      lane = freeSlot()
      color = allocColor()
      active[lane] = { hash: c.hash, color }
    } else {
      color = active[lane]!.color
    }

    // 2. Every other live lane carries straight through this row.
    const through: { lane: number; color: number }[] = []
    active.forEach((a, i) => {
      if (a && i !== lane) through.push({ lane: i, color: a.color })
    })

    // 3. Parents: the first inherits this lane, unless another lane is already
    //    heading there, in which case this lane ends by joining it. The rest
    //    (a merge's other sides) likewise join or fork into a fresh lane.
    const outbound: GraphEdge[] = []
    const [first, ...rest] = c.parents
    if (first === undefined) {
      active[lane] = null
    } else {
      const j = laneWaitingFor(first)
      if (j !== -1) {
        outbound.push({ from: lane, to: j, color: active[j]!.color })
        active[lane] = null
      } else {
        active[lane] = { hash: first, color }
        outbound.push({ from: lane, to: lane, color })
      }
    }
    for (const p of rest) {
      const j = laneWaitingFor(p)
      if (j !== -1) {
        outbound.push({ from: lane, to: j, color: active[j]!.color })
      } else {
        const m = freeSlot()
        const col = allocColor()
        active[m] = { hash: p, color: col }
        outbound.push({ from: lane, to: m, color: col })
      }
    }

    // Keep the lane array tight so a freed right-hand lane does not widen every later row.
    while (active.length > 0 && active[active.length - 1] === null) active.pop()

    const touched = [lane, ...outbound.map((e) => e.to), ...through.map((t) => t.lane)]
    rows.push({
      lane,
      color,
      merge: c.parents.length > 1,
      tip,
      outbound,
      through,
      width: Math.max(...touched) + 1
    })
  }
  return rows
}
