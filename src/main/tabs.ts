import { existsSync } from 'node:fs'
import { isPtyTabType, type TabType, type TabConfig, type Tab } from '@shared/types'
import { runtime, repo } from './runtime'
import { safeWrite } from './db/database'
import { removePane } from './services/layout'
import { startPtyTab } from './services/agents/launch'
import { pruneBriefings, briefingKey } from './services/agents/briefing'
import { prunePastedImages } from './services/pasted-images'

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

export function killWorktreeTerminals(worktreeId: string): void {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree) return
  for (const pane of worktree.panes) {
    for (const tab of pane.tabs) {
      if (isPtyTabType(tab.type)) runtime.terminals.kill(tab.id)
    }
  }
}

export function killPaneTerminals(paneId: string): void {
  for (const tab of repo.tabs.inPane(paneId)) {
    if (isPtyTabType(tab.type)) runtime.terminals.kill(tab.id)
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
    for (const pane of worktree.panes) {
      for (const tab of pane.tabs) {
        if (!isPtyTabType(tab.type)) continue
        try {
          repo.tabs.updateStatus(tab.id, 'idle')
          // spawnAgent owns its own error handling; spawnTerminal can throw synchronously.
          startPtyTab(worktree, tab)
        } catch (err) {
          console.error(`failed to respawn ${tab.type} ${tab.id}:`, err)
        }
      }
    }
    // Boot must not die on one worktree's status write (see safeWrite).
    safeWrite('resume recompute status', () => repo.worktrees.recomputeStatus(worktree.id))
  }
  // Drop briefing files left behind by tabs/worktrees removed while the app was closed.
  pruneBriefings(keepBriefings)
  prunePastedImages()
}
