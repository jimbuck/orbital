import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@shared/types'
import { layoutGraph } from './commitGraph'

/** A commit with just the fields the layout reads. */
function c(hash: string, ...parents: string[]): GitCommit {
  return { hash, parents, author: '', email: '', timestamp: 0, subject: hash, refs: [], isHead: false }
}

describe('layoutGraph', () => {
  it('keeps a linear history in one lane', () => {
    const rows = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1])
    // Only the first row is a tip: every later commit was awaited from above.
    expect(rows.map((r) => r.tip)).toEqual([true, false, false])
    expect(rows[0].outbound).toEqual([{ from: 0, to: 0, color: 0 }])
    expect(rows[1].through).toEqual([])
    // The root commit has nothing below it.
    expect(rows[2].outbound).toEqual([])
    expect(rows.every((r) => !r.merge)).toBe(true)
  })

  it("forks a merge's second parent into its own lane and joins it back", () => {
    //  m (merge of b and f)
    //  |\
    //  b f
    //  |/
    //  a
    const rows = layoutGraph([c('m', 'b', 'f'), c('b', 'a'), c('f', 'a'), c('a')])
    const [m, b, f, a] = rows
    expect(m.lane).toBe(0)
    expect(m.merge).toBe(true)
    expect(m.outbound).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 0, to: 1, color: 1 }
    ])
    // b sits in lane 0 with the feature lane passing beside it.
    expect(b.lane).toBe(0)
    expect(b.through).toEqual([{ lane: 1, color: 1 }])
    expect(b.width).toBe(2)
    // f is the feature lane's node; its parent `a` is already awaited by lane
    // 0, so the feature lane ends here with a line curving into lane 0.
    expect(f.lane).toBe(1)
    expect(f.outbound).toEqual([{ from: 1, to: 0, color: 0 }])
    expect(f.through).toEqual([{ lane: 0, color: 0 }])
    // a is reached by lane 0 alone, and the freed lane no longer counts.
    expect(a.lane).toBe(0)
    expect(a.width).toBe(1)
  })

  it('gives a second branch tip its own lane and joins the shared parent', () => {
    //  b f   (two tips, no merge yet — e.g. HEAD plus a branch decorating the log)
    //  |/
    //  a
    const rows = layoutGraph([c('b', 'a'), c('f', 'a'), c('a')])
    const [b, f, a] = rows
    expect(b.lane).toBe(0)
    expect(f.lane).toBe(1)
    expect(f.color).toBe(1)
    expect(f.tip).toBe(true)
    expect(f.outbound).toEqual([{ from: 1, to: 0, color: 0 }])
    expect(a.lane).toBe(0)
    expect(a.through).toEqual([])
  })

  it('reuses a freed lane instead of growing rightwards forever', () => {
    // Two merges in a row: the second feature branch takes lane 1 again once
    // the first has rejoined.
    const rows = layoutGraph([
      c('m2', 'm1', 'g'),
      c('g', 'm1'),
      c('m1', 'b', 'f'),
      c('f', 'a'),
      c('b', 'a'),
      c('a')
    ])
    expect(Math.max(...rows.map((r) => r.width))).toBe(2)
    // g's lane (1) rejoins at m1; f is then handed lane 1 afresh.
    expect(rows[1].outbound).toEqual([{ from: 1, to: 0, color: 0 }])
    expect(rows[3].lane).toBe(1)
  })

  it('joins a merge parent that another lane is already heading for', () => {
    //  m  (merge of x and y, both of which point at p)
    //  x y
    //  |/
    //  p
    const rows = layoutGraph([c('m', 'x', 'y'), c('x', 'p'), c('y', 'p'), c('p')])
    expect(rows[2].outbound).toEqual([{ from: 1, to: 0, color: 0 }])
    expect(rows[3]).toMatchObject({ lane: 0, width: 1, through: [] })
  })

  it('cycles colours per allocated lane', () => {
    const rows = layoutGraph([c('m', 'a', 'b'), c('a'), c('b')])
    expect(rows[0].outbound.map((e) => e.color)).toEqual([0, 1])
    expect(rows[2].color).toBe(1)
  })
})
