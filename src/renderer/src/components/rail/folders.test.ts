import { describe, expect, it } from 'vitest'
import type { Project, Repo, RailFolder, RailItem, Worktree } from '@shared/types'
import {
  beforeIdAt,
  dropAction,
  dropTargetFor,
  projectRollup,
  railRows,
  repoPathLabel,
  sameDropTarget,
  type DropTarget,
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
  repoIds,
  createdAt: 0
})
const folder = (id: string, projectIds: string[] = [], collapsed = false): RailFolder => ({
  id,
  name: id,
  collapsed,
  projectIds
})
const p = (id: string): RailItem => ({ kind: 'project', id })
const f = (id: string): RailItem => ({ kind: 'folder', id })

/** Project `id` holding one repo `r-<id>`: a flat row. */
const flatProject = (id: string): { project: Project; repos: Repo[] } => ({
  project: project(id, [`r-${id}`]),
  repos: [repo(`r-${id}`, id)]
})

/** Rows by id: a folder as `id[...]`, a group as `id{home|members}`. */
const view = (rows: RailRow[]): string[] =>
  rows.map((r) => {
    const one = (x: ProjectRow): string =>
      x.kind === 'flat' ? x.id : `${x.id}{${x.home?.id ?? ''}|${x.members.map((m) => m.id).join(' ')}}`
    return r.kind === 'folder' ? `${r.id}[${r.projects.map(one).join(' ')}]` : one(r)
  })

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
    const inner = fRow.kind === 'folder' ? fRow.projects[0] : null
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
  zone: 'top' | 'middle' | 'bottom' | 'body' = lowerHalf ? 'bottom' : 'top'
): RailOver => ({
  repo: null,
  project: { id, lowerHalf, zone },
  // Over a filed project the pointer is below its folder's header.
  folder: inFolder ? { id: inFolder, lowerHalf: true, edge: null } : null
})
const overFolder = (id: string, edge: 'top' | 'bottom' | null = null, lowerHalf = edge === 'bottom'): RailOver => ({
  repo: null,
  project: null,
  folder: { id, lowerHalf, edge }
})
const top = (index: number): DropTarget => ({ kind: 'slot', folderId: null, index })
const inside = (folderId: string, index: number): DropTarget => ({ kind: 'slot', folderId, index })

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

  it('goes into a folder from its header, after the projects already there', () => {
    expect(dropTargetFor(drag('a'), rows, overFolder('work'))).toEqual({ kind: 'into', folderId: 'work' })
    expect(dropTargetFor(drag('a'), rows, overFolder('shut'))).toEqual({ kind: 'into', folderId: 'shut' })
    expect(dropTargetFor(drag('b'), rows, overFolder('empty'))).toEqual({ kind: 'into', folderId: 'empty' })
  })

  it('slips in above a folder from the top edge of its header', () => {
    expect(dropTargetFor(drag('d'), rows, overFolder('work', 'top'))).toEqual(top(1))
    expect(dropTargetFor(drag('b'), rows, overFolder('work', 'top'))).toEqual(top(1))
  })

  it('slips in below a folder from its bottom edge, unless the folder is showing projects there', () => {
    expect(dropTargetFor(drag('a'), rows, overFolder('shut', 'bottom'))).toEqual(top(4))
    expect(dropTargetFor(drag('a'), rows, overFolder('empty', 'bottom'))).toEqual(top(5))
    expect(dropTargetFor(drag('a'), rows, overFolder('work', 'bottom'))).toEqual({ kind: 'into', folderId: 'work' })
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
    expect(dropTargetFor(drag('b'), rows, overFolder('work'))).toBeNull()
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

describe('dropTargetFor: dragging a folder', () => {
  const drag = (id: string): RailDrag => ({ kind: 'folder', id })

  it('goes above or below a loose project', () => {
    expect(dropTargetFor(drag('shut'), rows, overProject('a'))).toEqual(top(0))
    expect(dropTargetFor(drag('work'), rows, overProject('d', true))).toEqual(top(3))
  })

  it('goes above or below another folder, never into it', () => {
    expect(dropTargetFor(drag('empty'), rows, overFolder('work', null, false))).toEqual(top(1))
    expect(dropTargetFor(drag('empty'), rows, overFolder('work', null, true))).toEqual(top(2))
    expect(dropTargetFor(drag('empty'), rows, overProject('c', false, 'work'))).toEqual(top(2))
  })

  it('goes last when dropped below every row', () => {
    expect(dropTargetFor(drag('work'), rows, nothing)).toEqual(top(5))
  })

  it('offers nothing for the slots that leave it where it is', () => {
    expect(dropTargetFor(drag('work'), rows, overFolder('work', null, true))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overProject('b', false, 'work'))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overProject('a', true))).toBeNull()
    expect(dropTargetFor(drag('work'), rows, overProject('d'))).toBeNull()
    expect(dropTargetFor(drag('empty'), rows, nothing)).toBeNull()
  })

  it('ignores a folder this rail does not have', () => {
    expect(dropTargetFor(drag('elsewhere'), rows, overProject('a'))).toBeNull()
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
type Zone = 'top' | 'middle' | 'bottom' | 'body'
const onProject = (id: string, zone: Zone, inFolder?: string): RailOver => ({
  repo: null,
  project: { id, zone, lowerHalf: zone === 'bottom' || zone === 'body' },
  folder: inFolder ? { id: inFolder, lowerHalf: true, edge: null } : null
})
const onMember = (repoId: string, projectId: string, lowerHalf: boolean, inFolder?: string): RailOver => ({
  repo: { id: repoId, lowerHalf },
  project: { id: projectId, zone: 'body', lowerHalf: true },
  folder: inFolder ? { id: inFolder, lowerHalf: true, edge: null } : null
})
const onFolder = (id: string, edge: 'top' | 'bottom' | null = null): RailOver => ({
  repo: null,
  project: null,
  folder: { id, lowerHalf: edge === 'bottom', edge }
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
    for (const zone of ['top', 'middle', 'bottom', 'body'] as Zone[]) {
      expect(dropTargetFor(rdrag('r-a'), grouped, onProject('a', zone))).toBeNull()
    }
  })

  it("4: a member over its own project's header top detaches it to just above; elsewhere nothing", () => {
    expect(dropTargetFor(rdrag('g2'), grouped, onProject('g', 'top'))).toEqual(top(1))
    expect(dropTargetFor(rdrag('h1'), grouped, onProject('h', 'top', 'team'))).toEqual(inside('team', 0))
    for (const zone of ['middle', 'bottom', 'body'] as Zone[]) {
      expect(dropTargetFor(rdrag('g2'), grouped, onProject('g', zone))).toBeNull()
    }
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
    expect(dropTargetFor(rdrag('r-a'), grouped, onFolder('team'))).toEqual({ kind: 'into', folderId: 'team' })
    expect(dropTargetFor(rdrag('r-z'), grouped, onFolder('team', 'top'))).toEqual(top(2))
    // Already in it, flat: nothing. A member of a filed group: detach into the same folder.
    expect(dropTargetFor(rdrag('r-t'), grouped, onFolder('team'))).toBeNull()
    expect(dropTargetFor(rdrag('h1'), grouped, onFolder('team'))).toEqual({ kind: 'into', folderId: 'team' })
  })

  it('10: over empty rail goes last', () => {
    expect(dropTargetFor(rdrag('r-a'), grouped, nothing)).toEqual(top(7))
    expect(dropTargetFor(rdrag('g1'), grouped, nothing)).toEqual(top(7))
    // A flat row already last: nothing.
    expect(dropTargetFor(rdrag('r-z'), grouped, nothing)).toBeNull()
  })

  it('refuses a repo the rail does not draw, and the home (which is a header, not a row)', () => {
    expect(dropTargetFor(rdrag('nope'), grouped, onProject('g', 'middle'))).toBeNull()
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
    expect(beforeIdAt(rows, { kind: 'into', folderId: 'work' })).toBeNull()
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
    expect(sameDropTarget({ kind: 'into', folderId: 'a' }, { kind: 'into', folderId: 'a' })).toBe(true)
    expect(sameDropTarget({ kind: 'into', folderId: 'a' }, { kind: 'into', folderId: 'b' })).toBe(false)
    expect(sameDropTarget(top(1), top(2))).toBe(false)
    expect(sameDropTarget(top(1), inside('a', 1))).toBe(false)
    expect(sameDropTarget(inside('a', 1), inside('b', 1))).toBe(false)
    expect(sameDropTarget({ kind: 'into', folderId: 'a' }, inside('a', 0))).toBe(false)
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
  it('moves a folder along the top level, and nothing else', () => {
    expect(dropAction({ kind: 'folder', id: 'team' }, grouped, top(0))).toEqual({
      op: 'placeRailFolder',
      folderId: 'team',
      beforeId: 'a'
    })
    expect(dropAction({ kind: 'folder', id: 'team' }, grouped, { kind: 'into', folderId: 'team' })).toBeNull()
  })

  it('places a project into a folder or a slot, and never joins it to another', () => {
    const drag: RailDrag = { kind: 'project', id: 'g' }
    expect(dropAction(drag, grouped, { kind: 'into', folderId: 'team' })).toEqual({
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
    expect(dropAction(rdrag('r-a'), grouped, { kind: 'into', folderId: 'team' })).toEqual({
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
    expect(dropAction(rdrag('d1'), grouped, { kind: 'into', folderId: 'team' })).toEqual({
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
      beforeRepoId: null,
      forms: false,
      dissolves: null
    })
    expect(dropAction(rdrag('r-a'), grouped, join('z'))).toEqual({
      op: 'addRepoToProject',
      projectId: 'z',
      repoId: 'r-a',
      beforeRepoId: null,
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
      beforeRepoId: 'g2',
      forms: false,
      dissolves: null
    })
    expect(dropAction(rdrag('d2'), grouped, repoSlot('duo', 0))).toEqual({
      op: 'addRepoToProject',
      projectId: 'duo',
      repoId: 'd2',
      beforeRepoId: 'd1',
      forms: false,
      dissolves: null
    })
    expect(dropAction(rdrag('d1'), grouped, repoSlot('g', 3))).toMatchObject({ beforeRepoId: null, dissolves: 'duo' })
  })

  it('refuses a repo the rail does not draw', () => {
    expect(dropAction(rdrag('nope'), grouped, top(0))).toBeNull()
    expect(dropAction(rdrag('r-a'), grouped, join('nowhere'))).toBeNull()
  })
})
