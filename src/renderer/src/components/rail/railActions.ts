import { isPtyTabType, type Worktree } from '@shared/types'
import { useStore } from '@renderer/store'
import { fireAndForget } from '@renderer/lib/bridge'
import type { RailAction } from './folders'

/**
 * Carrying out what a drop or a rail menu decided: the one main call it comes
 * down to, the confirm some of them need first, and what the rail's live
 * region says afterwards. Drag and menu share all three, so the two routes to
 * the same change cannot drift apart.
 */

/** Open terminal and agent tabs in a worktree: what closes with it. */
export function ptyCount(worktree: Worktree | null | undefined): number {
  if (!worktree) return 0
  return worktree.panes.reduce((n, pane) => n + pane.tabs.filter((t) => isPtyTabType(t.type)).length, 0)
}

/** A project's folder session, if it has one. */
export function folderSessionOf(worktrees: Worktree[], projectId: string): Worktree | undefined {
  return worktrees.find((w) => w.kind === 'folder' && w.projectId === projectId)
}

/** `its 1 open terminal` / `its 3 open terminals`. */
export function openTerminals(n: number): string {
  return `its ${n} open terminal${n === 1 ? '' : 's'}`
}

/** `1 repo` / `3 repos`. */
export function repoCount(n: number): string {
  return `${n} repo${n === 1 ? '' : 's'}`
}

/** `1 worktree needs you` / `3 worktrees need you`. */
export function needsYouLabel(n: number): string {
  return n === 1 ? '1 worktree needs you' : `${n} worktrees need you`
}

export interface DissolveConfirm {
  message: string
  hint: string
  confirmLabel: string
}

/**
 * The confirm a move needs when it would close a folder session with open
 * terminals: taking a repo out of a two-repo group with no home sends the
 * group back to a plain repo row, and its session goes with it. Null when
 * nothing would be lost.
 */
export function dissolveConfirm(action: RailAction): DissolveConfirm | null {
  if (action.op !== 'detachRepo' && action.op !== 'addRepoToProject') return null
  if (!action.dissolves) return null
  const s = useStore.getState()
  const t = ptyCount(folderSessionOf(s.worktrees, action.dissolves))
  if (t === 0) return null
  const repo = s.repos.find((r) => r.id === action.repoId)?.name ?? 'this repo'
  const name = s.projects.find((p) => p.id === action.dissolves)?.name ?? 'the project'
  return {
    message: `Take ${repo} out of "${name}"?`,
    hint: `"${name}" is left with one repo, so it goes back to a plain repo row. Its project session closes, along with ${openTerminals(t)}.`,
    confirmLabel: 'Take Out'
  }
}

/** What the live region says once `action` is done, worked out from the state before it ran. */
function messageFor(action: RailAction): string {
  if (action.op !== 'detachRepo' && action.op !== 'addRepoToProject') return ''
  const s = useStore.getState()
  const repo = s.repos.find((r) => r.id === action.repoId)
  const repoName = repo?.name ?? 'The repo'
  const nameOf = (pid: string | null | undefined): string => s.projects.find((p) => p.id === pid)?.name ?? 'the project'
  const tail = action.dissolves ? ` ${nameOf(action.dissolves)} is now a plain repo row.` : ''
  if (action.op === 'detachRepo') return `${repoName} removed from ${nameOf(repo?.projectId)}.${tail}`
  if (repo?.projectId === action.projectId) return `${repoName} moved in ${nameOf(action.projectId)}.`
  if (action.forms) {
    const other = s.repos.find((r) => r.projectId === action.projectId)?.name ?? 'its new sibling'
    return `${repoName} and ${other} are now a project. Name it.${tail}`
  }
  return `${repoName} added to ${nameOf(action.projectId)}.${tail}`
}

/**
 * Run a rail action against main. A move that forms a new project opens the
 * new header and its name field, the way a new folder opens into its name.
 */
export function runRailAction(action: RailAction): void {
  const { announceRail, setExpanded, setRenamingProject } = useStore.getState()
  const message = messageFor(action)
  const done = (): void => {
    if (message) announceRail(message)
  }
  switch (action.op) {
    case 'placeRailFolder':
      fireAndForget(window.orbital.placeRailFolder(action.folderId, action.beforeId))
      return
    case 'placeProject':
      fireAndForget(window.orbital.placeProject(action.projectId, action.folderId, action.beforeId))
      return
    case 'detachRepo':
      fireAndForget(window.orbital.detachRepo(action.repoId, action.folderId, action.beforeId).then(done))
      return
    case 'addRepoToProject':
      fireAndForget(
        window.orbital.addRepoToProject(action.projectId, action.repoId, action.beforeRepoId).then(() => {
          if (action.forms) {
            setExpanded(action.projectId, true)
            setRenamingProject(action.projectId)
          }
          done()
        })
      )
  }
}

/** Make `repoId` its project's home, and say so. */
export function makeHome(projectId: string, repoId: string): void {
  const s = useStore.getState()
  const repo = s.repos.find((r) => r.id === repoId)?.name ?? 'The repo'
  const project = s.projects.find((p) => p.id === projectId)?.name ?? 'the project'
  fireAndForget(
    window.orbital
      .setProjectHome(projectId, repoId)
      .then(() => s.announceRail(`${repo} is now the home repo of ${project}.`))
  )
}
