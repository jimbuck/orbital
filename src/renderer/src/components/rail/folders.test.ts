import { describe, expect, it } from 'vitest'
import type { Project, Repo, RailFolder, RailItem, Worktree } from '@shared/types'
import {
  beforeIdAt,
  dropAction,
  dropTargetFor,
  folderOf,
  foldersIn,
  placeOf,
  projectRollup,
  projectRowById,
  projectRowOfRepo,
  projectRows,
  railRows,
  repoPathLabel,
  sameDropTarget,
  type DropTarget,
  type MemberRow,
  type OverZone,
  type ProjectRow,
  type RailDrag,
  type RailOver,
  type RailRow
} from './folders'

/* ---- Fixtures ------------------------------------------------------------- */

const repo = (id: string, projectId: string, repoPath = `C:/${projectId}/${id}`): Repo => ({
  id,
  name: id,
  repoPath,
  defaultAgentId: 'claude',
  addedAt: 0,
  projectId
})
const project = (id: string, repoIds: string[], homeRepoId: string | null = null): Project => ({
  id,
  name: id.toUpperCase(),
  rootPath: `C:/${id}`,
  homeRepoId,
  managedBlock: true,
  codeWorkspace: false,
  repoIds,
  createdAt: 0
})
const p = (id: string): RailItem => ({ kind: 'project', id })
const f = (id: string): RailItem => ({ kind: 'folder', id })
const r = (id: string): RailItem => ({ kind: 'repo', id })
/** A folder of projects. A bare string among its rows is a project id. */
const folder = (
  id: string,
  rows: Array<string | RailItem> = [],
  collapsed = false,
  parentId: string | null = null
): RailFolder => ({
  id,
  name: id,
  collapsed,
  projectId: null,
  parentId,
  items: rows.map((row) => (typeof row === 'string' ? p(row) : row))
})
/** A folder among `projectId`'s repos. A bare string among its rows is a repo id. */
const repoFolder = (
  id: string,
  projectId: string,
  rows: Array<string | RailItem> = [],
  collapsed = false,
  parentId: string | null = null
): RailFolder => ({
  id,
  name: id,
  collapsed,
  projectId,
  parentId,
  items: rows.map((row) => (typeof row === 'string' ? r(row) : row))
})

/** Project `id` holding one repo `r-<id>`: a flat row. */
const flatProject = (id: string): { project: Project; repos: Repo[] } => ({
  project: project(id, [`r-${id}`]),
  repos: [repo(`r-${id}`, id)]
})

/** Rows by id: a folder as `id[its rows]`, a group as `id{home|its rows}`, nested as they nest. */
const view = (rows: RailRow[]): string[] => {
  const member = (m: MemberRow): string => (m.kind === 'folder' ? `${m.id}[${m.items.map(member).join(' ')}]` : m.id)
  const one = (x: RailRow): string =>
    x.kind === 'folder'
      ? `${x.id}[${x.items.map(one).join(' ')}]`
      : x.kind === 'flat'
        ? x.id
        : `${x.id}{${x.home?.id ?? ''}|${x.items.map(member).join(' ')}}`
  return rows.map(one)
}

/* ---- railRows ------------------------------------------------------------- */

describe('railRows', () => {
  it('draws a one-repo project with no home flat, and everything else as a group', () => {
    const projects = [
      project('a', ['ra']),
      project('g', ['g1', 'g2']),
      project('h', ['h0', 'h1'], 'h0'),
      project('solo', ['s0'], 's0'),
      project('empty', [])
    ]
    const repos = [repo('ra', 'a'), repo('g1', 'g'), repo('g2', 'g'), repo('h0', 'h'), repo('h1', 'h'), repo('s0', 'solo')]
    const rows = railRows(projects, repos, [], [], {})
    expect(view(rows)).toEqual(['a', 'g{|g1 g2}', 'h{h0|h1}', 'solo{s0|}', 'empty{|}'])
    // The home is the header, never listed again among the members.
    const h = rows[2] as Extract<ProjectRow, { kind: 'group' }>
    expect(h.home?.id).toBe('h0')
    expect(h.members.map((m) => m.id)).toEqual(['h1'])
  })

  it("keeps the project's own member order, home anywhere in it", () => {
    const projects = [project('g', ['g3', 'g1', 'g2'], 'g1')]
    const repos = [repo('g1', 'g'), repo('g2', 'g'), repo('g3', 'g')]
    expect(view(railRows(projects, repos, [], [], {}))).toEqual(['g{g1|g3 g2}'])
  })

  it('appends a repo that names a project its repoIds forgot, and never draws a repo with no project', () => {
    const projects = [project('g', ['g1', 'g2'])]
    const repos = [repo('g1', 'g'), repo('g2', 'g'), repo('late', 'g'), repo('lost', 'nowhere')]
    expect(view(railRows(projects, repos, [], [], {}))).toEqual(['g{|g1 g2 late}'])
    // The forgotten one can be what makes a project a group.
    const one = [project('a', ['ra'])]
    expect(view(railRows(one, [repo('ra', 'a'), repo('rb', 'a')], [], [], {}))).toEqual(['a{|ra rb}'])
  })

  it('skips repo ids that name nothing, and a home it cannot resolve is no home', () => {
    const projects = [project('g', ['gone', 'g1', 'g2'], 'gone')]
    const repos = [repo('g1', 'g'), repo('g2', 'g')]
    expect(view(railRows(projects, repos, [], [], {}))).toEqual(['g{|g1 g2}'])
  })

  it('opens a group unless it was closed by hand', () => {
    const projects = [project('g', ['g1', 'g2']), project('k', ['k1', 'k2'])]
    const repos = [repo('g1', 'g'), repo('g2', 'g'), repo('k1', 'k'), repo('k2', 'k')]
    const rows = railRows(projects, repos, [], [], { k: false, g1: true })
    expect(rows.map((r) => (r.kind === 'group' ? r.open : null))).toEqual([true, false])
  })

  it('lists the top level in rail order, folders anywhere among the projects', () => {
    const fx = ['a', 'b', 'c'].map(flatProject)
    const rows = railRows(
      fx.map((x) => x.project),
      fx.flatMap((x) => x.repos),
      [folder('work', ['b'])],
      [p('c'), f('work'), p('a')],
      {}
    )
    expect(view(rows)).toEqual(['c', 'work[b]', 'a'])
  })

  it('hands back the very same objects', () => {
    const fx = flatProject('a')
    const g = project('g', ['g1', 'g2'])
    const gRepos = [repo('g1', 'g'), repo('g2', 'g')]
    const work = folder('work', ['g'])
    const rows = railRows([fx.project, g], [...fx.repos, ...gRepos], [work], [], {})
    const [fRow, aRow] = rows
    expect(fRow.kind === 'folder' && fRow.folder).toBe(work)
    const inner = fRow.kind === 'folder' ? fRow.items[0] : null
    expect(inner?.kind === 'group' && inner.project).toBe(g)
    expect(inner?.kind === 'group' && inner.members[1]).toBe(gRepos[1])
    expect(aRow.kind === 'flat' && aRow.repo).toBe(fx.repos[0])
    expect(aRow.kind === 'flat' && aRow.project).toBe(fx.project)
  })

  it('skips ids that no longer name anything, and a filed project listed at the top level too', () => {
    const fx = ['a', 'b'].map(flatProject)
    const rows = railRows(
      fx.map((x) => x.project),
      fx.flatMap((x) => x.repos),
      [folder('work', ['b', 'gone'])],
      [p('ghost'), f('work'), p('b'), p('a'), f('vanished')],
      {}
    )
    expect(view(rows)).toEqual(['work[b]', 'a'])
  })

  it('still lists whatever the rail order leaves out, folders first', () => {
    const fx = ['a', 'b', 'c'].map(flatProject)
    const rows = railRows(
      fx.map((x) => x.project),
      fx.flatMap((x) => x.repos),
      [folder('work', ['b']), folder('play')],
      [p('c')],
      {}
    )
    expect(view(rows)).toEqual(['c', 'work[b]', 'play[]', 'a'])
  })
})

/* ---- Rollup and labels ---------------------------------------------------- */

const wt = (
  id: string,
  projectId: string,
  repoId: string | null,
  kind: Worktree['kind'],
  status: Worktree['status'] = 'idle'
): Worktree => ({
  id,
  repoId,
  projectId,
  kind,
  name: id,
  path: `C:/${id}`,
  branch: 'main',
  status,
  taskId: null,
  layout: { type: 'pane', paneId: 'x' },
  createdAt: 0,
  panes: []
})

describe('projectRollup', () => {
  it("is the home's root for the session, its linked worktrees under it, and everything else hidden", () => {
    const h = project('h', ['home', 'api'], 'home')
    const worktrees = [
      wt('root', 'h', 'home', 'root', 'working'),
      wt('adr', 'h', 'home', 'linked', 'needs_attention'),
      wt('api-root', 'h', 'api', 'root'),
      wt('api-feat', 'h', 'api', 'linked', 'needs_attention'),
      wt('other', 'x', 'elsewhere', 'root', 'error')
    ]
    const r = projectRollup(h, worktrees)
    expect(r.session?.id).toBe('root')
    expect(r.homeLinked.map((w) => w.id)).toEqual(['adr'])
    // The session's own 'working' never rolls up; another project's error is not ours.
    expect(r.hidden).toBe('needs_attention')
    expect(r.needsYou).toBe(2)
  })

  it('is the folder session without a home, with no home worktrees', () => {
    const g = project('g', ['g1', 'g2'])
    const worktrees = [wt('folder', 'g', null, 'folder', 'needs_attention'), wt('g1-root', 'g', 'g1', 'root', 'working')]
    const r = projectRollup(g, worktrees)
    expect(r.session?.id).toBe('folder')
    expect(r.homeLinked).toEqual([])
    expect(r.hidden).toBe('working')
    expect(r.needsYou).toBe(0)
  })

  it('has no session until main makes one', () => {
    expect(projectRollup(project('g', []), []).session).toBeNull()
  })
})

describe('repoPathLabel', () => {
  it('is relative inside the root, a dot at it, and absolute outside it', () => {
    expect(repoPathLabel('C:\\Projects\\acme\\api', 'C:\\Projects\\acme')).toBe('./api')
    expect(repoPathLabel('C:\\Projects\\acme\\libs\\ui', 'C:\\Projects\\acme\\')).toBe('./libs/ui')
    expect(repoPathLabel('C:\\Projects\\acme', 'C:\\Projects\\acme')).toBe('.')
    expect(repoPathLabel('D:\\work\\billing', 'C:\\Projects\\acme')).toBe('D:\\work\\billing')
    // A sibling whose name starts with the root's is not inside it.
    expect(repoPathLabel('C:\\Projects\\acme-old', 'C:\\Projects\\acme')).toBe('C:\\Projects\\acme-old')
  })

  it('matches either separator, and case only where the OS ignores it', () => {
    expect(repoPathLabel('c:/projects/ACME/api', 'C:\\Projects\\acme', true)).toBe('./api')
    expect(repoPathLabel('/home/me/Acme/api', '/home/me/acme', false)).toBe('/home/me/Acme/api')
    expect(repoPathLabel('/home/me/acme/api', '/home/me/acme', false)).toBe('./api')
  })
})

/* ---- Drag and drop: projects and folders ---------------------------------- */

/*
 * The flat layout the project and folder rules are pinned on:
 *
 *   a
 *   work    [b, c]
 *   d
 *   shut    [e]   (collapsed)
 *   empty   (open)
 */
const flats = ['a', 'b', 'c', 'd', 'e'].map(flatProject)
const rows = railRows(
  flats.map((x) => x.project),
  flats.flatMap((x) => x.repos),
  [folder('work', ['b', 'c']), folder('shut', ['e'], true), folder('empty')],
  [p('a'), f('work'), p('d'), f('shut'), f('empty')],
  {}
)
const nothing: RailOver = { repo: null, project: null, folder: null }
const overProject = (
  id: string,
  lowerHalf = false,
  inFolder?: string,
  zone: OverZone = lowerHalf ? 'bottom' : 'top'
): RailOver => ({
  repo: null,
  project: { id, lowerHalf, zone },
  // Over a filed project the pointer is below its folder's header.
  folder: inFolder ? { id: inFolder, zone: 'body' } : null
})
const overFolder = (id: string, zone: OverZone = 'middle'): RailOver => ({
  repo: null,
  project: null,
  folder: { id, zone }
})
const top = (index: number): DropTarget => ({ kind: 'slot', folderId: null, index })
const inside = (folderId: string, index: number): DropTarget => ({ kind: 'slot', folderId, index })
const into = (folderId: string): DropTarget => ({ kind: 'into', folderId })

describe('dropTargetFor: dragging a project', () => {
  const drag = (id: string): RailDrag => ({ kind: 'project', id })

  it('reorders the top level: above a project from its upper half, below from its lower', () => {
    expect(dropTargetFor(drag('d'), rows, overProject('a'))).toEqual(top(0))
    expect(dropTargetFor(drag('a'), rows, overProject('d', true))).toEqual(top(3))
  })

  it('goes after a project when over its body, and never merges into it', () => {
    expect(dropTargetFor(drag('a'), rows, overProject('d', true, undefined, 'body'))).toEqual(top(3))
    expect(dropTargetFor(drag('d'), rows, overProject('a', false, undefined, 'middle'))).toEqual(top(0))
  })

  it('reorders inside a folder the same way', () => {
    expect(dropTargetFor(drag('c'), rows, overProject('b', false, 'work'))).toEqual(inside('work', 0))
    expect(dropTargetFor(drag('b'), rows, overProject('c', true, 'work'))).toEqual(inside('work', 2))
  })

  it('moves between the top level and a folder, to the place it is dropped at', () => {
    expect(dropTargetFor(drag('a'), rows, overProject('c', false, 'work'))).toEqual(inside('work', 1))
    expect(dropTargetFor(drag('b'), rows, overProject('d'))).toEqual(top(2))
    expect(dropTargetFor(drag('e'), rows, overProject('b', true, 'work'))).toEqual(inside('work', 1))
  })

  it('goes into a folder from its header or the gaps between its rows, after the projects already there', () => {
    expect(dropTargetFor(drag('a'), rows, overFolder('work'))).toEqual(into('work'))
    expect(dropTargetFor(drag('a'), rows, overFolder('work', 'body'))).toEqual(into('work'))
    expect(dropTargetFor(drag('a'), rows, overFolder('shut'))).toEqual(into('shut'))
    expect(dropTargetFor(drag('b'), rows, overFolder('empty'))).toEqual(into('empty'))
  })

  it('slips in above a folder from the top edge of its header', () => {
    expect(dropTargetFor(drag('d'), rows, overFolder('work', 'top'))).toEqual(top(1))
    expect(dropTargetFor(drag('b'), rows, overFolder('work', 'top'))).toEqual(top(1))
  })

  it('slips in below a folder from its bottom edge, unless the folder is showing projects there', () => {
    expect(dropTargetFor(drag('a'), rows, overFolder('shut', 'bottom'))).toEqual(top(4))
    expect(dropTargetFor(drag('a'), rows, overFolder('empty', 'bottom'))).toEqual(top(5))
    expect(dropTargetFor(drag('a'), rows, overFolder('work', 'bottom'))).toEqual(into('work'))
  })

  it("goes to the end of its own folder from that folder's header, and stays put between its rows", () => {
    expect(dropTargetFor(drag('b'), rows, overFolder('work'))).toEqual(inside('work', 2))
    expect(dropTargetFor(drag('b'), rows, overFolder('work', 'bottom'))).toEqual(inside('work', 2))
    expect(dropTargetFor(drag('b'), rows, overFolder('work', 'body'))).toBeNull()
    // Already last there: nothing to do.
    expect(dropTargetFor(drag('c'), rows, overFolder('work'))).toBeNull()
  })

  it('goes last when dropped below every row', () => {
    expect(dropTargetFor(drag('a'), rows, nothing)).toEqual(top(5))
    expect(dropTargetFor(drag('c'), rows, nothing)).toEqual(top(5))
  })

  it('offers nothing where the drop would change nothing', () => {
    expect(dropTargetFor(drag('d'), rows, overProject('d'))).toBeNull()
    expect(dropTargetFor(drag('d'), rows, overProject('d', true, undefined, 'body'))).toBeNull()
    expect(dropTargetFor(drag('d'), rows, overFolder('shut', 'top'))).toBeNull()
    expect(dropTargetFor(drag('a'), rows, overFolder('work', 'top'))).toBeNull()
    expect(dropTargetFor(drag('c'), rows, overProject('c', true, 'work'))).toBeNull()
    expect(dropTargetFor(drag('c'), rows, overProject('b', true, 'work'))).toBeNull()
    expect(dropTargetFor(drag('b'), rows, overProject('c', false, 'work'))).toBeNull()
    expect(dropTargetFor(drag('e'), rows, overFolder('shut'))).toBeNull()
  })

  it('ignores a row this rail does not have', () => {
    expect(dropTargetFor(drag('a'), rows, overProject('elsewhere'))).toBeNull()
    expect(dropTargetFor(drag('a'), rows, overFolder('elsewhere'))).toBeNull()
    expect(dropTargetFor(drag('elsewhere'), rows, overProject('a'))).toBeNull()
  })

  it('ignores the member repo under the pointer', () => {
    const over = { ...overProject('d', true, undefined, 'body'), repo: { id: 'r-d', lowerHalf: false } }
    expect(dropTargetFor(drag('a'), rows, over)).toEqual(top(3))
  })
})

describe('dropTargetFor: dragging a folder of projects', () => {
  const drag = (id: string): RailDrag => ({ kind: 'folder', id })

  it('goes above or below a loose project', () => {
    expect(dropTargetFor(drag('shut'), rows, overProject('a'))).toEqual(top(0))
    expect(dropTargetFor(drag('work'), rows, overProject('d', true))).toEqual(top(3))
  })

  it("goes above or below another folder from the edges of that folder's header", () => {
    expect(dropTargetFor(drag('empty'), rows, overFolder('work', 'top'))).toEqual(top(1))
    expect(dropTargetFor(drag('work'), rows, overFolder('shut', 'bottom'))).toEqual(top(4))
  })

  it('goes into another folder from its header, and beside a project filed in one', () => {
    expect(dropTargetFor(drag('empty'), rows, overFolder('work'))).toEqual(into('work'))
    expect(dropTargetFor(drag('empty'), rows, overFolder('shut'))).toEqual(into('shut'))
    // An open folder's rows are just below its header, so its bottom edge is "into" as well.
    expect(dropTargetFor(drag('empty'), rows, overFolder('work', 'bottom'))).toEqual(into('work'))
    expect(dropTargetFor(drag('empty'), rows, overProject('c', false, 'work'))).toEqual(inside('work', 1))
    expect(dropTargetFor(drag('shut'), rows, overProject('c', true, 'work'))).toEqual(inside('work', 2))
  })

  it('goes last when dropped below every row', () => {
    expect(dropTargetFor(drag('work'), rows, nothing)).toEqual(top(5))
  })

  it('never goes inside itself, and offers nothing for the slots that leave it where it is', () => {
    expect(dropTargetFor(drag('work'), rows, overFolder('work'))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overFolder('work', 'body'))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overProject('b', false, 'work'))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overProject('a', true))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overProject('d'))).toBeNull()
    expect(dropTargetFor(drag('empty'), rows, nothing)).toBeNull()
  })

  it('ignores a folder this rail does not have', () => {
    expect(dropTargetFor(drag('elsewhere'), rows, overProject('a'))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overFolder('elsewhere'))).toBeNull()
  })
})

/*
 * Folders in folders:
 *
 *   0  a
 *   1  outer [
 *        0  b
 *        1  inner [ c ]
 *        2  deep  [ leaf [ d ] ]
 *      ]
 *   2  e
 */
const nested = (() => {
  const fx = ['a', 'b', 'c', 'd', 'e'].map(flatProject)
  return railRows(
    fx.map((x) => x.project),
    fx.flatMap((x) => x.repos),
    [
      folder('outer', ['b', f('inner'), f('deep')]),
      folder('inner', ['c'], false, 'outer'),
      folder('deep', [f('leaf')], false, 'outer'),
      folder('leaf', ['d'], false, 'deep')
    ],
    [p('a'), f('outer'), p('e')],
    {}
  )
})()

describe('folders in folders', () => {
  const fdrag = (id: string): RailDrag => ({ kind: 'folder', id })
  const pdrag = (id: string): RailDrag => ({ kind: 'project', id })

  it('lists a folder inside the folder that files it, and not again at the top', () => {
    expect(view(nested)).toEqual(['a', 'outer[b inner[c] deep[leaf[d]]]', 'e'])
    expect(projectRows(nested).map((row) => row.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(folderOf(nested, 'c')).toBe('inner')
    expect(folderOf(nested, 'a')).toBeNull()
    expect(foldersIn(nested, null).map((x) => [x.folder.id, x.depth])).toEqual([
      ['outer', 0],
      ['inner', 1],
      ['deep', 1],
      ['leaf', 2]
    ])
    expect(placeOf(nested, 'folder', 'leaf')).toEqual({ folderId: 'deep', ids: ['leaf'], index: 0 })
    expect(placeOf(nested, 'project', 'b')).toEqual({ folderId: 'outer', ids: ['b', 'inner', 'deep'], index: 0 })
  })

  it('lists a folder once even when the folders name each other in a loop', () => {
    const fx = flatProject('a')
    const looped = railRows(
      [fx.project],
      fx.repos,
      [folder('one', [f('two')], false, 'two'), folder('two', [f('one'), 'a'], false, 'one')],
      [],
      {}
    )
    expect(view(looped)).toEqual(['one[two[a]]'])
  })

  it('places a project among the rows of a nested folder, folders counting as rows', () => {
    // Over c, which is in inner, which is in outer: the innermost folder is what the pointer reports.
    expect(dropTargetFor(pdrag('a'), nested, overProject('c', false, 'inner'))).toEqual(inside('inner', 0))
    expect(dropTargetFor(pdrag('a'), nested, overFolder('inner', 'top'))).toEqual(inside('outer', 1))
    expect(dropTargetFor(pdrag('a'), nested, overFolder('inner'))).toEqual(into('inner'))
    expect(dropTargetFor(pdrag('e'), nested, overFolder('leaf'))).toEqual(into('leaf'))
    expect(beforeIdAt(nested, inside('outer', 1))).toBe('inner')
    expect(dropAction(pdrag('a'), nested, inside('outer', 1))).toEqual({
      op: 'placeProject',
      projectId: 'a',
      folderId: 'outer',
      beforeId: 'inner'
    })
  })

  it("gets a project below an open folder that is last in its list by dropping on the list's own header", () => {
    // deep is open and last in outer, so there is no row of outer below it to drop beside.
    expect(dropTargetFor(pdrag('b'), nested, overFolder('outer'))).toEqual(inside('outer', 3))
    expect(dropAction(pdrag('b'), nested, inside('outer', 3))).toMatchObject({ folderId: 'outer', beforeId: null })
  })

  it('moves a folder into, out of and between folders', () => {
    expect(dropTargetFor(fdrag('inner'), nested, overFolder('deep'))).toEqual(into('deep'))
    expect(dropTargetFor(fdrag('inner'), nested, overProject('a'))).toEqual(top(0))
    expect(dropTargetFor(fdrag('leaf'), nested, overProject('b', false, 'outer'))).toEqual(inside('outer', 0))
    expect(dropTargetFor(fdrag('leaf'), nested, nothing)).toEqual(top(3))

    expect(dropAction(fdrag('inner'), nested, into('deep'))).toEqual({
      op: 'placeRailFolder',
      folderId: 'inner',
      parentId: 'deep',
      beforeId: null
    })
    expect(dropAction(fdrag('leaf'), nested, inside('outer', 0))).toEqual({
      op: 'placeRailFolder',
      folderId: 'leaf',
      parentId: 'outer',
      beforeId: 'b'
    })
  })

  it('never puts a folder inside itself, at any depth', () => {
    expect(dropTargetFor(fdrag('outer'), nested, overFolder('inner'))).toBeNull()
    expect(dropTargetFor(fdrag('outer'), nested, overProject('c', false, 'inner'))).toBeNull()
    expect(dropTargetFor(fdrag('deep'), nested, overFolder('leaf'))).toBeNull()
    expect(dropTargetFor(fdrag('deep'), nested, overProject('d', true, 'leaf'))).toBeNull()
    // And the action refuses it even if asked.
    expect(dropAction(fdrag('outer'), nested, into('leaf'))).toBeNull()
    expect(dropAction(fdrag('outer'), nested, inside('inner', 0))).toBeNull()
  })
})

/* ---- Drag and drop: repos ------------------------------------------------- */

/*
 * The grouped layout the repo rules are pinned on (top level):
 *
 *   0  a                 flat (r-a)
 *   1  g {| g1 g2 g3}    group, no home, open
 *   2  team [            folder
 *        0  h {h0| h1}   group with a home, open
 *        1  t            flat (r-t)
 *      ]
 *   3  k {| k1 k2}       group, no home, CLOSED
 *   4  duo {| d1 d2}     group, no home, two repos (dissolves when one leaves)
 *   5  solo {s0|}        a home and nothing else
 *   6  z                 flat (r-z)
 */
const grouped = (() => {
  const projects = [
    project('a', ['r-a']),
    project('g', ['g1', 'g2', 'g3']),
    project('h', ['h0', 'h1'], 'h0'),
    project('t', ['r-t']),
    project('k', ['k1', 'k2']),
    project('duo', ['d1', 'd2']),
    project('solo', ['s0'], 's0'),
    project('z', ['r-z'])
  ]
  const repos = [
    repo('r-a', 'a'),
    repo('g1', 'g'),
    repo('g2', 'g'),
    repo('g3', 'g'),
    repo('h0', 'h'),
    repo('h1', 'h'),
    repo('r-t', 't'),
    repo('k1', 'k'),
    repo('k2', 'k'),
    repo('d1', 'duo'),
    repo('d2', 'duo'),
    repo('s0', 'solo'),
    repo('r-z', 'z')
  ]
  return railRows(
    projects,
    repos,
    [folder('team', ['h', 't'])],
    [p('a'), p('g'), f('team'), p('k'), p('duo'), p('solo'), p('z')],
    { k: false }
  )
})()

const rdrag = (id: string): RailDrag => ({ kind: 'repo', id })
const onProject = (id: string, zone: OverZone, inFolder?: string): RailOver => ({
  repo: null,
  project: { id, zone, lowerHalf: zone === 'bottom' || zone === 'body' },
  folder: inFolder ? { id: inFolder, zone: 'body' } : null
})
const onMember = (repoId: string, projectId: string, lowerHalf: boolean, inFolder?: string): RailOver => ({
  repo: { id: repoId, lowerHalf },
  project: { id: projectId, zone: 'body', lowerHalf: true },
  folder: inFolder ? { id: inFolder, zone: 'body' } : null
})
const onFolder = (id: string, zone: OverZone = 'middle'): RailOver => ({
  repo: null,
  project: null,
  folder: { id, zone }
})
const join = (projectId: string): DropTarget => ({ kind: 'join', projectId })
const repoSlot = (projectId: string, index: number): DropTarget => ({ kind: 'repoSlot', projectId, index })

describe('dropTargetFor: dragging a repo (spec §2.3, rows 1–10)', () => {
  it('1: over itself is nothing', () => {
    expect(dropTargetFor(rdrag('g2'), grouped, onMember('g2', 'g', false))).toBeNull()
    expect(dropTargetFor(rdrag('g2'), grouped, onMember('g2', 'g', true))).toBeNull()
  })

  it('2: over member i of a group is a slot among its members, by halves', () => {
    expect(dropTargetFor(rdrag('r-a'), grouped, onMember('g2', 'g', false))).toEqual(repoSlot('g', 1))
    expect(dropTargetFor(rdrag('r-a'), grouped, onMember('g2', 'g', true))).toEqual(repoSlot('g', 2))
    expect(dropTargetFor(rdrag('h1'), grouped, onMember('g1', 'g', false))).toEqual(repoSlot('g', 0))
    expect(dropTargetFor(rdrag('r-t'), grouped, onMember('h1', 'h', true, 'team'))).toEqual(repoSlot('h', 1))
  })

  it('2: reorders inside its own group, except into the two slots that leave it where it is', () => {
    expect(dropTargetFor(rdrag('g1'), grouped, onMember('g3', 'g', true))).toEqual(repoSlot('g', 3))
    expect(dropTargetFor(rdrag('g3'), grouped, onMember('g1', 'g', false))).toEqual(repoSlot('g', 0))
    expect(dropTargetFor(rdrag('g2'), grouped, onMember('g1', 'g', true))).toBeNull()
    expect(dropTargetFor(rdrag('g2'), grouped, onMember('g3', 'g', false))).toBeNull()
  })

  it('3: a flat row over its own project is nothing, whatever the zone', () => {
    for (const zone of ['top', 'middle', 'bottom', 'body'] as OverZone[]) {
      expect(dropTargetFor(rdrag('r-a'), grouped, onProject('a', zone))).toBeNull()
    }
  })

  it("4: a member over its own project's header top detaches it to just above", () => {
    expect(dropTargetFor(rdrag('g2'), grouped, onProject('g', 'top'))).toEqual(top(1))
    expect(dropTargetFor(rdrag('h1'), grouped, onProject('h', 'top', 'team'))).toEqual(inside('team', 0))
  })

  it("4: the rest of its own header sends it to the end of the project's list; between its rows it stays", () => {
    expect(dropTargetFor(rdrag('g2'), grouped, onProject('g', 'middle'))).toEqual(repoSlot('g', 3))
    expect(dropTargetFor(rdrag('g2'), grouped, onProject('g', 'bottom'))).toEqual(repoSlot('g', 3))
    expect(dropTargetFor(rdrag('g2'), grouped, onProject('g', 'body'))).toBeNull()
    // Already last: nothing.
    expect(dropTargetFor(rdrag('g3'), grouped, onProject('g', 'middle'))).toBeNull()
  })

  it('5: over the top of another project goes before it', () => {
    expect(dropTargetFor(rdrag('r-z'), grouped, onProject('g', 'top'))).toEqual(top(1))
    expect(dropTargetFor(rdrag('g1'), grouped, onProject('t', 'top', 'team'))).toEqual(inside('team', 1))
    // A member never stays put by a slot: even just below its own group it detaches.
    expect(dropTargetFor(rdrag('g1'), grouped, onFolder('team', 'top'))).toEqual(top(2))
    expect(dropTargetFor(rdrag('k1'), grouped, onProject('duo', 'top'))).toEqual(top(4))
  })

  it('5: a flat row keeps the no-op check: the slot just below itself is nothing', () => {
    expect(dropTargetFor(rdrag('r-a'), grouped, onProject('g', 'top'))).toBeNull()
  })

  it('6: over the middle of another project joins it, flat or group', () => {
    expect(dropTargetFor(rdrag('r-a'), grouped, onProject('z', 'middle'))).toEqual(join('z'))
    expect(dropTargetFor(rdrag('r-a'), grouped, onProject('g', 'middle'))).toEqual(join('g'))
    expect(dropTargetFor(rdrag('g1'), grouped, onProject('k', 'middle'))).toEqual(join('k'))
    expect(dropTargetFor(rdrag('g1'), grouped, onProject('solo', 'middle'))).toEqual(join('solo'))
  })

  it('7: over the bottom joins a project showing members, else goes after it', () => {
    expect(dropTargetFor(rdrag('r-z'), grouped, onProject('g', 'bottom'))).toEqual(join('g'))
    // Closed, a home-only project, and a flat row show no members there.
    expect(dropTargetFor(rdrag('r-z'), grouped, onProject('k', 'bottom'))).toEqual(top(4))
    expect(dropTargetFor(rdrag('g1'), grouped, onProject('solo', 'bottom'))).toEqual(top(6))
    expect(dropTargetFor(rdrag('g1'), grouped, onProject('a', 'bottom'))).toEqual(top(1))
  })

  it("8: over a project's body joins a group, and goes after a flat row", () => {
    expect(dropTargetFor(rdrag('r-a'), grouped, onProject('duo', 'body'))).toEqual(join('duo'))
    expect(dropTargetFor(rdrag('r-a'), grouped, onProject('h', 'body', 'team'))).toEqual(join('h'))
    expect(dropTargetFor(rdrag('g1'), grouped, onProject('z', 'body'))).toEqual(top(7))
    expect(dropTargetFor(rdrag('r-a'), grouped, onProject('t', 'body', 'team'))).toEqual(inside('team', 2))
  })

  it("9: over a folder header follows the folder rule; a member may always go into its project's folder", () => {
    expect(dropTargetFor(rdrag('r-a'), grouped, onFolder('team'))).toEqual(into('team'))
    expect(dropTargetFor(rdrag('r-z'), grouped, onFolder('team', 'top'))).toEqual(top(2))
    // Already last in it, flat: nothing. A member of a filed group: detach into the same folder.
    expect(dropTargetFor(rdrag('r-t'), grouped, onFolder('team'))).toBeNull()
    expect(dropTargetFor(rdrag('h1'), grouped, onFolder('team'))).toEqual(into('team'))
  })

  it('10: over empty rail goes last', () => {
    expect(dropTargetFor(rdrag('r-a'), grouped, nothing)).toEqual(top(7))
    expect(dropTargetFor(rdrag('g1'), grouped, nothing)).toEqual(top(7))
    // A flat row already last: nothing.
    expect(dropTargetFor(rdrag('r-z'), grouped, nothing)).toBeNull()
  })

  it('refuses a repo the rail does not draw, and the home (which is a header, not a row)', () => {
    expect(dropTargetFor(rdrag('nope'), grouped, onProject('g', 'middle'))).toBeNull()
    expect(dropTargetFor(rdrag('h0'), grouped, onProject('g', 'middle'))).toBeNull()
  })
})

/*
 * Folders among a project's repos:
 *
 *   0  a                       flat (r-a)
 *   1  hq {home|               group with a home
 *        0  api
 *        1  games [            a folder of hq's repos
 *             0  ion
 *             1  engines [ volt ]
 *             2  keep
 *           ]
 *        2  sites [ ]          empty
 *        3  web
 *      }
 *   2  duo {| d1 d2}           group, no home, two repos
 */
const filed = (() => {
  const projects = [
    project('a', ['r-a']),
    project('hq', ['home', 'api', 'ion', 'volt', 'keep', 'web'], 'home'),
    project('duo', ['d1', 'd2'])
  ]
  const repos = [
    repo('r-a', 'a'),
    ...['home', 'api', 'ion', 'volt', 'keep', 'web'].map((id) => repo(id, 'hq')),
    repo('d1', 'duo'),
    repo('d2', 'duo')
  ]
  const folders = [
    repoFolder('games', 'hq', ['ion', f('engines'), 'keep']),
    repoFolder('engines', 'hq', ['volt'], false, 'games'),
    repoFolder('sites', 'hq')
  ]
  return railRows(projects, repos, folders, [p('a'), p('hq'), p('duo')], {}, {
    // The home is listed like any repo, though it is drawn as the header.
    hq: [r('home'), r('api'), f('games'), f('sites'), r('web')]
  })
})()

/** Over a row inside one of hq's folders: the folder is the innermost block, inside hq's body. */
const inHq = (over: Partial<RailOver>): RailOver => ({
  repo: null,
  folder: null,
  ...over,
  project: { id: 'hq', zone: 'body', lowerHalf: true }
})

describe("folders among a project's repos", () => {
  const fdrag = (id: string): RailDrag => ({ kind: 'folder', id })

  it("draws the project's folders under its header, the home never among them", () => {
    expect(view(filed)).toEqual(['a', 'hq{home|api games[ion engines[volt] keep] sites[] web}', 'duo{|d1 d2}'])
    const hq = projectRowById(filed, 'hq') as Extract<ProjectRow, { kind: 'group' }>
    // The flat order reads top to bottom through the folders.
    expect(hq.members.map((m) => m.id)).toEqual(['api', 'ion', 'volt', 'keep', 'web'])
    expect(foldersIn(filed, 'hq').map((x) => [x.folder.id, x.depth])).toEqual([
      ['games', 0],
      ['engines', 1],
      ['sites', 0]
    ])
    expect(foldersIn(filed, null)).toEqual([])
    expect(placeOf(filed, 'repo', 'volt')).toEqual({ folderId: 'engines', ids: ['volt'], index: 0 })
    expect(placeOf(filed, 'repo', 'api')).toEqual({ folderId: null, ids: ['api', 'games', 'sites', 'web'], index: 0 })
    // A project's folders are its own: they are no row of the rail's lists.
    expect(folderOf(filed, 'hq')).toBeNull()
    expect(projectRowOfRepo(filed, 'volt')?.id).toBe('hq')
  })

  it("falls back to the project's repo order, folders first, for whatever its list leaves out", () => {
    const projects = [project('hq', ['home', 'api', 'ion', 'web'], 'home')]
    const repos = ['home', 'api', 'ion', 'web'].map((id) => repo(id, 'hq'))
    const folders = [repoFolder('games', 'hq', ['ion', 'gone', r('home')]), folder('rail', ['hq'])]
    // No list sent for hq at all, a repo id that names nothing, and the home filed in a folder.
    expect(view(railRows(projects, repos, folders, [], {}))).toEqual(['rail[hq{home|games[ion] api web}]'])
    // A folder of another project is not drawn in this one.
    const stray = [repoFolder('theirs', 'other', ['api'])]
    expect(view(railRows(projects, repos, stray, [], {}, { hq: [f('theirs'), r('web')] }))).toEqual([
      'hq{home|web api ion}'
    ])
  })

  it('a flat project draws as its repo, folders or not', () => {
    const fx = flatProject('a')
    expect(view(railRows([fx.project], fx.repos, [repoFolder('x', 'a', ['r-a'])], [], {}))).toEqual(['a'])
  })

  it('places a repo beside a member wherever that member is filed', () => {
    const overIon = inHq({ repo: { id: 'ion', lowerHalf: false }, folder: { id: 'games', zone: 'body' } })
    expect(dropTargetFor(rdrag('api'), filed, overIon)).toEqual(inside('games', 0))
    expect(dropTargetFor(rdrag('r-a'), filed, overIon)).toEqual(inside('games', 0))
    const underVolt = inHq({ repo: { id: 'volt', lowerHalf: true }, folder: { id: 'engines', zone: 'body' } })
    expect(dropTargetFor(rdrag('web'), filed, underVolt)).toEqual(inside('engines', 1))
    // At the top of the project's list a folder is a row like any other.
    const underApi = inHq({ repo: { id: 'api', lowerHalf: true } })
    expect(dropTargetFor(rdrag('keep'), filed, underApi)).toEqual(repoSlot('hq', 1))
    expect(beforeIdAt(filed, repoSlot('hq', 1))).toBe('games')
    // The two slots around itself still change nothing.
    const underIon = inHq({ repo: { id: 'ion', lowerHalf: true }, folder: { id: 'games', zone: 'body' } })
    expect(dropTargetFor(rdrag('ion'), filed, underIon)).toBeNull()
  })

  it("files a repo in one of the project's folders from the folder's header", () => {
    expect(dropTargetFor(rdrag('api'), filed, inHq({ folder: { id: 'sites', zone: 'middle' } }))).toEqual(into('sites'))
    expect(dropTargetFor(rdrag('api'), filed, inHq({ folder: { id: 'engines', zone: 'middle' } }))).toEqual(
      into('engines')
    )
    // From another project, or a plain repo row, that is joining the project too.
    expect(dropTargetFor(rdrag('d1'), filed, inHq({ folder: { id: 'games', zone: 'middle' } }))).toEqual(into('games'))
    expect(dropTargetFor(rdrag('r-a'), filed, inHq({ folder: { id: 'sites', zone: 'body' } }))).toEqual(into('sites'))
    // The edges of the header slip it in beside the folder instead.
    expect(dropTargetFor(rdrag('web'), filed, inHq({ folder: { id: 'games', zone: 'top' } }))).toEqual(repoSlot('hq', 1))
    expect(dropTargetFor(rdrag('api'), filed, inHq({ folder: { id: 'sites', zone: 'bottom' } }))).toEqual(
      repoSlot('hq', 3)
    )
    expect(dropTargetFor(rdrag('web'), filed, inHq({ folder: { id: 'engines', zone: 'top' } }))).toEqual(
      inside('games', 1)
    )
  })

  it("takes a repo out of a folder: to the end of the project from its header, or of the folder from the folder's", () => {
    expect(dropTargetFor(rdrag('ion'), filed, onProject('hq', 'middle'))).toEqual(repoSlot('hq', 4))
    expect(dropTargetFor(rdrag('volt'), filed, onProject('hq', 'body'))).toEqual(repoSlot('hq', 4))
    expect(dropTargetFor(rdrag('ion'), filed, inHq({ folder: { id: 'games', zone: 'middle' } }))).toEqual(
      inside('games', 3)
    )
    // Between the rows of the list it is already in, it stays.
    expect(dropTargetFor(rdrag('ion'), filed, inHq({ folder: { id: 'games', zone: 'body' } }))).toBeNull()
    expect(dropTargetFor(rdrag('api'), filed, onProject('hq', 'body'))).toBeNull()
    // Dragged above its project's header it still detaches, from however deep.
    expect(dropTargetFor(rdrag('volt'), filed, onProject('hq', 'top'))).toEqual(top(1))
  })

  it("moves a folder of repos within its project's lists, and nowhere else", () => {
    const overApi = inHq({ repo: { id: 'api', lowerHalf: false } })
    expect(dropTargetFor(fdrag('sites'), filed, overApi)).toEqual(repoSlot('hq', 0))
    expect(dropTargetFor(fdrag('sites'), filed, inHq({ folder: { id: 'games', zone: 'middle' } }))).toEqual(
      into('games')
    )
    expect(dropTargetFor(fdrag('engines'), filed, onProject('hq', 'middle'))).toEqual(repoSlot('hq', 4))
    expect(dropTargetFor(fdrag('engines'), filed, inHq({ folder: { id: 'sites', zone: 'middle' } }))).toEqual(
      into('sites')
    )
    // Not into itself, not out of its project, not into the rail's lists.
    expect(dropTargetFor(fdrag('games'), filed, inHq({ folder: { id: 'engines', zone: 'middle' } }))).toBeNull()
    const overVolt = inHq({ repo: { id: 'volt', lowerHalf: false }, folder: { id: 'engines', zone: 'body' } })
    expect(dropTargetFor(fdrag('games'), filed, overVolt)).toBeNull()
    expect(dropTargetFor(fdrag('games'), filed, onProject('duo', 'middle'))).toBeNull()
    expect(dropTargetFor(fdrag('games'), filed, onMember('d1', 'duo', false))).toBeNull()
    expect(dropTargetFor(fdrag('games'), filed, onProject('a', 'top'))).toBeNull()
    expect(dropTargetFor(fdrag('games'), filed, nothing)).toBeNull()
    // Above its own project's header, and between rows of the list it is in: nothing.
    expect(dropTargetFor(fdrag('games'), filed, onProject('hq', 'top'))).toBeNull()
    expect(dropTargetFor(fdrag('games'), filed, onProject('hq', 'body'))).toBeNull()
  })

  it("treats a project's folders as part of the project when a project or a folder of projects is dragged", () => {
    const overGames = inHq({ folder: { id: 'games', zone: 'middle' } })
    expect(dropTargetFor({ kind: 'project', id: 'duo' }, filed, overGames)).toBeNull()
    expect(dropTargetFor({ kind: 'project', id: 'a' }, filed, overGames)).toEqual(top(2))
  })

  it('turns those drops into moves inside the project', () => {
    expect(dropAction(rdrag('api'), filed, into('sites'))).toEqual({
      op: 'addRepoToProject',
      projectId: 'hq',
      repoId: 'api',
      folderId: 'sites',
      beforeId: null,
      forms: false,
      dissolves: null
    })
    expect(dropAction(rdrag('web'), filed, inside('games', 1))).toEqual({
      op: 'addRepoToProject',
      projectId: 'hq',
      repoId: 'web',
      folderId: 'games',
      beforeId: 'engines',
      forms: false,
      dissolves: null
    })
    // Joining from a two-repo group with no home dissolves that group.
    expect(dropAction(rdrag('d1'), filed, into('games'))).toMatchObject({
      op: 'addRepoToProject',
      projectId: 'hq',
      folderId: 'games',
      dissolves: 'duo'
    })
    expect(dropAction(fdrag('sites'), filed, repoSlot('hq', 0))).toEqual({
      op: 'placeRailFolder',
      folderId: 'sites',
      parentId: null,
      beforeId: 'api'
    })
    expect(dropAction(fdrag('engines'), filed, into('sites'))).toEqual({
      op: 'placeRailFolder',
      folderId: 'engines',
      parentId: 'sites',
      beforeId: null
    })
    // Never across kinds: a project into a folder of repos, or a folder of repos into the rail or another project.
    expect(dropAction({ kind: 'project', id: 'a' }, filed, into('games'))).toBeNull()
    expect(dropAction(fdrag('games'), filed, top(0))).toBeNull()
    expect(dropAction(fdrag('games'), filed, repoSlot('duo', 0))).toBeNull()
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

  it('puts a project dropped into a folder, or a repo joining a project, at the end', () => {
    expect(beforeIdAt(rows, into('work'))).toBeNull()
    expect(beforeIdAt(grouped, join('g'))).toBeNull()
  })

  it('names the member a repo slot sits before', () => {
    expect(beforeIdAt(grouped, repoSlot('g', 0))).toBe('g1')
    expect(beforeIdAt(grouped, repoSlot('g', 2))).toBe('g3')
    expect(beforeIdAt(grouped, repoSlot('g', 3))).toBeNull()
    expect(beforeIdAt(grouped, repoSlot('h', 0))).toBe('h1')
  })
})

describe('sameDropTarget', () => {
  it('compares by what the drop would do', () => {
    expect(sameDropTarget(null, null)).toBe(true)
    expect(sameDropTarget(top(1), top(1))).toBe(true)
    expect(sameDropTarget(inside('a', 1), inside('a', 1))).toBe(true)
    expect(sameDropTarget(into('a'), into('a'))).toBe(true)
    expect(sameDropTarget(into('a'), into('b'))).toBe(false)
    expect(sameDropTarget(top(1), top(2))).toBe(false)
    expect(sameDropTarget(top(1), inside('a', 1))).toBe(false)
    expect(sameDropTarget(inside('a', 1), inside('b', 1))).toBe(false)
    expect(sameDropTarget(into('a'), inside('a', 0))).toBe(false)
    expect(sameDropTarget(top(0), null)).toBe(false)
  })

  it('tells joins and repo slots apart by project and index', () => {
    expect(sameDropTarget(join('g'), join('g'))).toBe(true)
    expect(sameDropTarget(join('g'), join('k'))).toBe(false)
    expect(sameDropTarget(repoSlot('g', 1), repoSlot('g', 1))).toBe(true)
    expect(sameDropTarget(repoSlot('g', 1), repoSlot('g', 2))).toBe(false)
    expect(sameDropTarget(repoSlot('g', 1), repoSlot('k', 1))).toBe(false)
    expect(sameDropTarget(join('g'), repoSlot('g', 0))).toBe(false)
  })
})

/* ---- dropAction (spec §2.4) ----------------------------------------------- */

describe('dropAction', () => {
  it('moves a folder to a slot or into another folder, and never into itself', () => {
    expect(dropAction({ kind: 'folder', id: 'team' }, grouped, top(0))).toEqual({
      op: 'placeRailFolder',
      folderId: 'team',
      parentId: null,
      beforeId: 'a'
    })
    expect(dropAction({ kind: 'folder', id: 'empty' }, rows, into('work'))).toEqual({
      op: 'placeRailFolder',
      folderId: 'empty',
      parentId: 'work',
      beforeId: null
    })
    expect(dropAction({ kind: 'folder', id: 'team' }, grouped, into('team'))).toBeNull()
    expect(dropAction({ kind: 'folder', id: 'team' }, grouped, join('g'))).toBeNull()
    expect(dropAction({ kind: 'folder', id: 'team' }, grouped, repoSlot('g', 0))).toBeNull()
  })

  it('places a project into a folder or a slot, and never joins it to another', () => {
    const drag: RailDrag = { kind: 'project', id: 'g' }
    expect(dropAction(drag, grouped, into('team'))).toEqual({
      op: 'placeProject',
      projectId: 'g',
      folderId: 'team',
      beforeId: null
    })
    expect(dropAction(drag, grouped, inside('team', 1))).toEqual({
      op: 'placeProject',
      projectId: 'g',
      folderId: 'team',
      beforeId: 't'
    })
    expect(dropAction(drag, grouped, join('k'))).toBeNull()
    expect(dropAction(drag, grouped, repoSlot('k', 0))).toBeNull()
  })

  it('places a flat row as its project', () => {
    expect(dropAction(rdrag('r-a'), grouped, top(4))).toEqual({
      op: 'placeProject',
      projectId: 'a',
      folderId: null,
      beforeId: 'duo'
    })
    expect(dropAction(rdrag('r-a'), grouped, into('team'))).toEqual({
      op: 'placeProject',
      projectId: 'a',
      folderId: 'team',
      beforeId: null
    })
  })

  it('detaches a member placed anywhere, and says when that dissolves its group', () => {
    expect(dropAction(rdrag('g2'), grouped, top(0))).toEqual({
      op: 'detachRepo',
      repoId: 'g2',
      folderId: null,
      beforeId: 'a',
      dissolves: null
    })
    expect(dropAction(rdrag('d1'), grouped, into('team'))).toEqual({
      op: 'detachRepo',
      repoId: 'd1',
      folderId: 'team',
      beforeId: null,
      dissolves: 'duo'
    })
    // A home keeps a group a group, whatever is left in it.
    expect(dropAction(rdrag('h1'), grouped, top(0))).toMatchObject({ op: 'detachRepo', dissolves: null })
  })

  it('joins a project last; forms a project when the target is flat', () => {
    expect(dropAction(rdrag('r-a'), grouped, join('g'))).toEqual({
      op: 'addRepoToProject',
      projectId: 'g',
      repoId: 'r-a',
      folderId: null,
      beforeId: null,
      forms: false,
      dissolves: null
    })
    expect(dropAction(rdrag('r-a'), grouped, join('z'))).toEqual({
      op: 'addRepoToProject',
      projectId: 'z',
      repoId: 'r-a',
      folderId: null,
      beforeId: null,
      forms: true,
      dissolves: null
    })
    expect(dropAction(rdrag('d2'), grouped, join('z'))).toMatchObject({ forms: true, dissolves: 'duo' })
  })

  it('inserts at a repo slot, which in its own group is a reorder that dissolves nothing', () => {
    expect(dropAction(rdrag('r-a'), grouped, repoSlot('g', 1))).toEqual({
      op: 'addRepoToProject',
      projectId: 'g',
      repoId: 'r-a',
      folderId: null,
      beforeId: 'g2',
      forms: false,
      dissolves: null
    })
    expect(dropAction(rdrag('d2'), grouped, repoSlot('duo', 0))).toEqual({
      op: 'addRepoToProject',
      projectId: 'duo',
      repoId: 'd2',
      folderId: null,
      beforeId: 'd1',
      forms: false,
      dissolves: null
    })
    expect(dropAction(rdrag('d1'), grouped, repoSlot('g', 3))).toMatchObject({ beforeId: null, dissolves: 'duo' })
  })

  it('refuses a repo the rail does not draw, and a folder it does not have', () => {
    expect(dropAction(rdrag('nope'), grouped, top(0))).toBeNull()
    expect(dropAction(rdrag('r-a'), grouped, join('nowhere'))).toBeNull()
    expect(dropAction(rdrag('r-a'), grouped, into('nowhere'))).toBeNull()
  })
})
