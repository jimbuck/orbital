import { describe, expect, it } from 'vitest'
import type { Repo, RailFolder, RailItem } from '@shared/types'
import { beforeIdAt, dropTargetFor, railRows, sameDropTarget, type RailOver, type RailRow } from './folders'

const repo = (id: string): Repo => ({ id, name: id, repoPath: `C:/${id}`, defaultAgentId: 'claude', addedAt: 0 })
const folder = (id: string, repoIds: string[] = [], collapsed = false): RailFolder => ({
  id,
  name: id,
  collapsed,
  repoIds
})
const p = (id: string): RailItem => ({ kind: 'repo', id })
const f = (id: string): RailItem => ({ kind: 'folder', id })

/** Rows by id, a folder as `id[its repos]`. */
const view = (rows: RailRow[]): string[] =>
  rows.map((r) => (r.kind === 'repo' ? r.id : `${r.id}[${r.repos.map((x) => x.id).join(' ')}]`))

describe('railRows', () => {
  it('lists the top level in rail order, folders anywhere among the repos', () => {
    const repos = [repo('a'), repo('b'), repo('c'), repo('d')]
    const rows = railRows(repos, [folder('work', ['d', 'a']), folder('empty')], [p('c'), f('work'), p('b'), f('empty')])
    // Inside a folder the order is the folder's own, not the repos' incoming order.
    expect(view(rows)).toEqual(['c', 'work[d a]', 'b', 'empty[]'])
  })

  it('hands back the very same repo objects, so a folder changes nothing about a repo', () => {
    const a = repo('a')
    const b = repo('b')
    const rows = railRows([a, b], [folder('work', ['a'])], [f('work'), p('b')])
    expect(rows[0].kind === 'folder' && rows[0].repos[0]).toBe(a)
    expect(rows[1].kind === 'repo' && rows[1].repo).toBe(b)
  })

  it('skips ids that no longer name anything, and a filed repo listed at the top level too', () => {
    const rows = railRows(
      [repo('a'), repo('b')],
      [folder('work', ['gone', 'a'])],
      [p('missing'), f('missing'), p('a'), f('work'), p('b'), p('b')]
    )
    expect(view(rows)).toEqual(['work[a]', 'b'])
  })

  it('still lists whatever the rail order leaves out, folders first', () => {
    const rows = railRows([repo('a'), repo('b'), repo('c')], [folder('work', ['c']), folder('play')], [p('b')])
    expect(view(rows)).toEqual(['b', 'work[c]', 'play[]', 'a'])
  })
})

/**
 * The rail the drop tests drag across:
 *
 *   a
 *   work    (open)       b, c
 *   d
 *   shut    (collapsed)  e
 *   empty   (open)
 */
const rows = railRows(
  ['a', 'b', 'c', 'd', 'e'].map(repo),
  [folder('work', ['b', 'c']), folder('shut', ['e'], true), folder('empty')],
  [p('a'), f('work'), p('d'), f('shut'), f('empty')]
)
const nothing: RailOver = { repo: null, folder: null }
const overRepo = (id: string, lowerHalf = false, inFolder?: string): RailOver => ({
  repo: { id, lowerHalf },
  // Over a filed repo the pointer is below its folder's header.
  folder: inFolder ? { id: inFolder, lowerHalf: true, edge: null } : null
})
const overFolder = (id: string, edge: 'top' | 'bottom' | null = null, lowerHalf = edge === 'bottom'): RailOver => ({
  repo: null,
  folder: { id, lowerHalf, edge }
})
const top = (index: number): { kind: 'slot'; folderId: null; index: number } => ({ kind: 'slot', folderId: null, index })
const inside = (folderId: string, index: number): { kind: 'slot'; folderId: string; index: number } => ({
  kind: 'slot',
  folderId,
  index
})

describe('dropTargetFor: dragging a repo', () => {
  const drag = (id: string): { kind: 'repo'; id: string } => ({ kind: 'repo', id })

  it('reorders the top level: above a repo from its upper half, below from its lower', () => {
    expect(dropTargetFor(drag('d'), rows, overRepo('a'))).toEqual(top(0))
    expect(dropTargetFor(drag('a'), rows, overRepo('d', true))).toEqual(top(3))
  })

  it('reorders inside a folder the same way', () => {
    expect(dropTargetFor(drag('c'), rows, overRepo('b', false, 'work'))).toEqual(inside('work', 0))
    expect(dropTargetFor(drag('b'), rows, overRepo('c', true, 'work'))).toEqual(inside('work', 2))
  })

  it('moves between the top level and a folder, to the place it is dropped at', () => {
    // Loose, in beside a filed repo; filed, out beside a loose one.
    expect(dropTargetFor(drag('a'), rows, overRepo('c', false, 'work'))).toEqual(inside('work', 1))
    expect(dropTargetFor(drag('b'), rows, overRepo('d'))).toEqual(top(2))
    expect(dropTargetFor(drag('e'), rows, overRepo('b', true, 'work'))).toEqual(inside('work', 1))
  })

  it('goes into a folder from its header, after the repos already there', () => {
    expect(dropTargetFor(drag('a'), rows, overFolder('work'))).toEqual({ kind: 'into', folderId: 'work' })
    expect(dropTargetFor(drag('a'), rows, overFolder('shut'))).toEqual({ kind: 'into', folderId: 'shut' })
    expect(dropTargetFor(drag('b'), rows, overFolder('empty'))).toEqual({ kind: 'into', folderId: 'empty' })
  })

  it('slips in above a folder from the top edge of its header', () => {
    expect(dropTargetFor(drag('d'), rows, overFolder('work', 'top'))).toEqual(top(1))
    // Also the way out of that very folder.
    expect(dropTargetFor(drag('b'), rows, overFolder('work', 'top'))).toEqual(top(1))
  })

  it('slips in below a folder from its bottom edge, unless the folder is showing repos there', () => {
    expect(dropTargetFor(drag('a'), rows, overFolder('shut', 'bottom'))).toEqual(top(4))
    expect(dropTargetFor(drag('a'), rows, overFolder('empty', 'bottom'))).toEqual(top(5))
    // Open with repos: just below the header is inside the folder.
    expect(dropTargetFor(drag('a'), rows, overFolder('work', 'bottom'))).toEqual({ kind: 'into', folderId: 'work' })
  })

  it('goes last when dropped below every row', () => {
    expect(dropTargetFor(drag('a'), rows, nothing)).toEqual(top(5))
    expect(dropTargetFor(drag('c'), rows, nothing)).toEqual(top(5))
  })

  it('offers nothing where the drop would change nothing', () => {
    // On itself, and the slots on either side of it, at the top level...
    expect(dropTargetFor(drag('d'), rows, overRepo('d'))).toBeNull()
    expect(dropTargetFor(drag('d'), rows, overFolder('shut', 'top'))).toBeNull()
    expect(dropTargetFor(drag('a'), rows, overFolder('work', 'top'))).toBeNull()
    // ...and inside a folder.
    expect(dropTargetFor(drag('c'), rows, overRepo('c', true, 'work'))).toBeNull()
    expect(dropTargetFor(drag('c'), rows, overRepo('b', true, 'work'))).toBeNull()
    expect(dropTargetFor(drag('b'), rows, overRepo('c', false, 'work'))).toBeNull()
    // Onto the header of the folder it is already in.
    expect(dropTargetFor(drag('b'), rows, overFolder('work'))).toBeNull()
    expect(dropTargetFor(drag('e'), rows, overFolder('shut'))).toBeNull()
  })

  it('ignores a row this rail does not have', () => {
    expect(dropTargetFor(drag('a'), rows, overRepo('elsewhere'))).toBeNull()
    expect(dropTargetFor(drag('a'), rows, overFolder('elsewhere'))).toBeNull()
  })
})

describe('dropTargetFor: dragging a folder', () => {
  const drag = (id: string): { kind: 'folder'; id: string } => ({ kind: 'folder', id })

  it('goes above or below a loose repo', () => {
    expect(dropTargetFor(drag('shut'), rows, overRepo('a'))).toEqual(top(0))
    expect(dropTargetFor(drag('work'), rows, overRepo('d', true))).toEqual(top(3))
  })

  it('goes above or below another folder, never into it', () => {
    expect(dropTargetFor(drag('empty'), rows, overFolder('work', null, false))).toEqual(top(1))
    expect(dropTargetFor(drag('empty'), rows, overFolder('work', null, true))).toEqual(top(2))
    // Over a repo inside a folder counts as below that folder's header.
    expect(dropTargetFor(drag('empty'), rows, overRepo('c', false, 'work'))).toEqual(top(2))
  })

  it('goes last when dropped below every row', () => {
    expect(dropTargetFor(drag('work'), rows, nothing)).toEqual(top(5))
  })

  it('offers nothing for the slots that leave it where it is', () => {
    // Over itself or its own repos, below the row above, above the row below.
    expect(dropTargetFor(drag('work'), rows, overFolder('work', null, true))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overRepo('b', false, 'work'))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overRepo('a', true))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overRepo('d'))).toBeNull()
    // Already last, dropped below every row.
    expect(dropTargetFor(drag('empty'), rows, nothing)).toBeNull()
  })

  it('ignores a folder this rail does not have', () => {
    expect(dropTargetFor(drag('elsewhere'), rows, overRepo('a'))).toBeNull()
  })
})

describe('beforeIdAt', () => {
  it('names the row a slot sits before, or nothing at the end of a list', () => {
    expect(beforeIdAt(rows, top(0))).toBe('a')
    expect(beforeIdAt(rows, top(1))).toBe('work')
    expect(beforeIdAt(rows, top(5))).toBeNull()
    expect(beforeIdAt(rows, inside('work', 1))).toBe('c')
    expect(beforeIdAt(rows, inside('work', 2))).toBeNull()
  })

  it('puts a repo dropped into a folder at its end', () => {
    expect(beforeIdAt(rows, { kind: 'into', folderId: 'work' })).toBeNull()
  })
})

describe('sameDropTarget', () => {
  it('compares by what the drop would do', () => {
    expect(sameDropTarget(null, null)).toBe(true)
    expect(sameDropTarget(top(1), top(1))).toBe(true)
    expect(sameDropTarget(inside('a', 1), inside('a', 1))).toBe(true)
    expect(sameDropTarget({ kind: 'into', folderId: 'a' }, { kind: 'into', folderId: 'a' })).toBe(true)
    expect(sameDropTarget({ kind: 'into', folderId: 'a' }, { kind: 'into', folderId: 'b' })).toBe(false)
    expect(sameDropTarget(top(1), top(2))).toBe(false)
    // The same index in a different list is a different place.
    expect(sameDropTarget(top(1), inside('a', 1))).toBe(false)
    expect(sameDropTarget(inside('a', 1), inside('b', 1))).toBe(false)
    expect(sameDropTarget({ kind: 'into', folderId: 'a' }, inside('a', 0))).toBe(false)
    expect(sameDropTarget(top(0), null)).toBe(false)
  })
})
