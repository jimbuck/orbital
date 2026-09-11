import {
  IPC,
  isPtyTabType,
  type TabType,
  type TabConfig,
  type Tab,
  type SplitDirection,
  type SplitWhere
} from '@shared/types'
import { runtime, repo } from '../runtime'
import { writeTx } from '../db/database'
import { splitAt, removePane, setRatio, edgeToSplit } from '../services/layout'
import { deleteBriefing } from '../services/agents/briefing'
import { collapseIfEmpty, createTabInWorktree, killPaneTerminals } from '../tabs'
import { forgetTabStatus } from '../status'
import { handle, broadcast, broadcastAll } from './handle'

/** Tabs and panes: open / close / move / split, and the split ratios. */
export function register(): void {
  const h = handle
  h(IPC.createTab, (_e, worktreeId: string, paneId: string | null, type: TabType, config?: TabConfig) => {
    const tab = createTabInWorktree(worktreeId, paneId, type, config)
    broadcast()
    return tab
  })

  h(IPC.closeTab, (_e, tabId: string) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    if (isPtyTabType(tab.type)) runtime.terminals.kill(tabId)
    if (tab.type === 'agent') deleteBriefing(tab.worktreeId, tabId)
    forgetTabStatus(tabId)
    repo.tabs.remove(tabId)
    // Closing the last tab leaves the (now empty) pane in place — it shows the
    // "Open a terminal" prompt. Panes only collapse when a tab is dragged out.
    repo.worktrees.recomputeStatus(tab.worktreeId)
    broadcastAll()
  })

  h(IPC.renameTab, (_e, tabId: string, title: string) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    // An empty title clears the override; JSON.stringify drops the undefined key.
    repo.tabs.updateConfig(tabId, { ...tab.config, title: title.trim() || undefined })
    broadcast()
  })

  h(IPC.updateTabConfig, (_e, tabId: string, patch: Partial<TabConfig>) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    repo.tabs.updateConfig(tabId, { ...tab.config, ...patch })
    broadcast()
  })

  h(IPC.setActiveTab, (_e, paneId: string, tabId: string) => {
    repo.tabs.setActive(paneId, tabId)
    broadcast()
  })

  /**
   * A tab belongs to exactly one worktree for its whole life. EditorTab and
   * TerminalTab read `tab.worktreeId` on that basis, and `tabs.move` updates
   * only `pane_id` — so a move into another worktree's pane would leave a tab
   * whose stored worktree disagrees with the pane rendering it. The renderer
   * cannot produce such a drag today (PaneGroup only shows one worktree's
   * panes), but an invariant main depends on is main's to enforce.
   */
  const assertPaneInWorktree = (tab: Tab, paneId: string): void => {
    const owner = repo.panes.worktreeIdOf(paneId)
    if (!owner) throw new Error(`pane ${paneId} not found`)
    if (owner !== tab.worktreeId) throw new Error('a tab cannot move to a pane in another worktree')
  }

  h(IPC.moveTab, (_e, tabId: string, targetPaneId: string) => {
    const tab = repo.tabs.get(tabId)
    if (!tab || tab.paneId === targetPaneId) return
    assertPaneInWorktree(tab, targetPaneId)
    const source = tab.paneId
    repo.tabs.move(tabId, targetPaneId)
    collapseIfEmpty(tab.worktreeId, source)
    broadcast()
  })

  h(IPC.splitPane, (_e, worktreeId: string, paneId: string, dir: SplitDirection, where: SplitWhere) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) throw new Error(`worktree ${worktreeId} not found`)
    const pane = writeTx(() => {
      const created = repo.panes.create(worktreeId)
      repo.worktrees.setLayout(worktreeId, splitAt(worktree.layout, paneId, dir, where, created.id))
      return created
    })
    broadcast()
    return pane
  })

  h(IPC.closePane, (_e, worktreeId: string, paneId: string) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) return
    if (worktree.panes.length <= 1) throw new Error('cannot close the last pane')
    killPaneTerminals(paneId)
    const next = removePane(worktree.layout, paneId)
    if (next) repo.worktrees.setLayout(worktreeId, next)
    repo.panes.remove(paneId) // cascades the pane's tabs
    repo.worktrees.recomputeStatus(worktreeId)
    broadcastAll()
  })

  h(IPC.moveTabToEdge, (_e, tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom') => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    const worktree = repo.worktrees.get(tab.worktreeId)
    if (!worktree) return
    // Splitting at a pane from another worktree would be a no-op on this
    // worktree's layout, leaving the fresh pane orphaned outside it.
    assertPaneInWorktree(tab, targetPaneId)
    const source = tab.paneId
    const { dir, where } = edgeToSplit(edge)
    // New pane, layout and tab move land together or not at all.
    writeTx(() => {
      const pane = repo.panes.create(worktree.id)
      repo.worktrees.setLayout(worktree.id, splitAt(worktree.layout, targetPaneId, dir, where, pane.id))
      repo.tabs.move(tabId, pane.id)
    })
    collapseIfEmpty(worktree.id, source)
    broadcast()
  })

  h(IPC.setSplitRatio, (_e, worktreeId: string, splitId: string, ratio: number) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) return
    repo.worktrees.setLayout(worktreeId, setRatio(worktree.layout, splitId, ratio))
    broadcast()
  })
}
