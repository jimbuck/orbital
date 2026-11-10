import { existsSync } from 'node:fs'
import { isPtyTabType, type TabType, type TabConfig, type Tab } from '@shared/types'
import { runtime, repo } from './runtime'
import { safeWrite } from './db/database'
import { removePane } from './services/layout'
import { startPtyTab } from './services/agents/launch'
import { pruneBriefings, briefingKey, deleteBriefing } from './services/agents/briefing'
import { prunePastedImages } from './services/pasted-images'
import { ptyExited, resetWorktree, tabsClosed } from './status'

/** Tab and pane plumbing shared by the IPC handlers and the CLI control channel. */

/** Create a tab in a Worktree (resolving the target pane) and start its PTY if PTY-backed. */
export function createTabInWorktree(worktreeId: string, paneId: string | null, type: TabType, config?: TabConfig): Tab {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree) throw new Error(`worktree ${worktreeId} not found`)
  const targetPane = paneId ?? repo.panes.firstPaneId(worktreeId)
  if (!targetPane) throw new Error(`worktree ${worktreeId} has no pane`)
  const tab = repo.tabs.create({ worktreeId, paneId: targetPane, type, config })
  startPtyTab(worktree, tab)
  return tab
}

/**
 * Let go of what the runtime holds for a tab that is about to be removed: its
 * PTY and, for an agent, its briefing file. The row and the status bookkeeping
 * are the caller's next two steps (see {@link closeTab}).
 */
export function releaseTabRuntime(tab: Pick<Tab, 'id' | 'worktreeId' | 'type'>): void {
  if (isPtyTabType(tab.type)) runtime.terminals.kill(tab.id)
  if (tab.type === 'agent') deleteBriefing(tab.worktreeId, tab.id)
}

/**
 * Close a tab: PTY, briefing, row, and its share of the Worktree's status.
 * Closing the last tab leaves the (now empty) pane in place — it shows the
 * "Open a terminal" prompt. Panes only collapse when a tab is dragged out.
 */
export function closeTab(tabId: string): void {
  const tab = repo.tabs.get(tabId)
  if (!tab) return
  releaseTabRuntime(tab)
  repo.tabs.remove(tabId)
  tabsClosed(tab.worktreeId, [tabId])
}

/**
 * Close a pane and every tab in it, collapsing the layout to its sibling.
 * Refuses the Worktree's last pane.
 */
export function closePane(worktreeId: string, paneId: string): void {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree) return
  if (worktree.panes.length <= 1) throw new Error('cannot close the last pane')
  const tabs = repo.tabs.inPane(paneId)
  for (const tab of tabs) releaseTabRuntime(tab)
  const next = removePane(worktree.layout, paneId)
  if (next) repo.worktrees.setLayout(worktreeId, next)
  repo.panes.remove(paneId) // cascades the pane's tabs
  tabsClosed(
    worktreeId,
    tabs.map((t) => t.id)
  )
}

/**
 * What a PTY's own exit means for its tab. An agent session that ends on its
 * own (`/exit`, or a crash) closes its tab; a plain terminal keeps its tab and
 * goes idle. TerminalManager.kill() does NOT emit 'exit', so this fires only
 * on a real process exit, never on worktree or app teardown.
 */
export function watchPtyExits(): void {
  runtime.terminals.on('exit', (e: { tabId: string }) => {
    // Nothing awaits this handler, so a DB failure here has nowhere to go but
    // uncaughtException — log it instead (safeWrite) and let the next event
    // re-derive the worktree's status.
    safeWrite('terminal exit', () => {
      const tab = repo.tabs.get(e.tabId)
      if (!tab) return
      if (tab.type === 'agent') closeTab(tab.id)
      else ptyExited(tab.id)
    })
  })
}

export function killWorktreeTerminals(worktreeId: string): void {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree) return
  for (const pane of worktree.panes) {
    for (const tab of pane.tabs) {
      if (isPtyTabType(tab.type)) runtime.terminals.kill(tab.id)
    }
  }
}

/** Drop an empty pane, collapsing the layout to its sibling — never the Worktree's last pane. */
export function collapseIfEmpty(worktreeId: string, paneId: string): void {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree || worktree.panes.length <= 1) return
  const pane = worktree.panes.find((p) => p.id === paneId)
  if (!pane || pane.tabs.length > 0) return
  const next = removePane(worktree.layout, paneId)
  if (next) repo.worktrees.setLayout(worktreeId, next)
  repo.panes.remove(paneId)
}

/**
 * Terminals start fresh across restarts (PRD §5): scrollback does not persist,
 * so respawn a clean PTY for every terminal tab and reset its status to idle.
 * An agent tab's PTY is fresh too, but the agent inside it picks its previous
 * conversation back up (see agentSession) — a reopened workspace should look
 * like the one that was closed, mid-task and all.
 */
export function resumeTerminals(): void {
  const keepBriefings = new Set<string>()
  for (const worktree of repo.worktrees.list()) {
    // Track every current agent tab so the prune below only drops orphans.
    for (const pane of worktree.panes) {
      for (const tab of pane.tabs) {
        if (tab.type === 'agent') keepBriefings.add(briefingKey(worktree.id, tab.id))
      }
    }
    // A worktree may have been removed externally while the app was closed;
    // node-pty throws synchronously on a missing cwd, so skip such Worktrees.
    if (!existsSync(worktree.path)) continue
    // Every PTY below is fresh, so whatever status its tab was left in is
    // stale. Reset before spawning: a launch that fails then reports its own
    // error on top. Boot must not die on one worktree's status write (see safeWrite).
    safeWrite('resume reset status', () => resetWorktree(worktree.id))
    for (const pane of worktree.panes) {
      for (const tab of pane.tabs) {
        if (!isPtyTabType(tab.type)) continue
        try {
          // spawnAgent owns its own error handling; spawnTerminal can throw synchronously.
          startPtyTab(worktree, tab)
        } catch (err) {
          console.error(`failed to respawn ${tab.type} ${tab.id}:`, err)
        }
      }
    }
  }
  // Drop briefing files left behind by tabs/worktrees removed while the app was closed.
  pruneBriefings(keepBriefings)
  prunePastedImages()
}
