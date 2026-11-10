import { IPC } from '@shared/contract'
import { type Tab } from '@shared/types'
import { repo } from '../runtime'
import { writeTx } from '../db/database'
import { splitAt, setRatio, edgeToSplit } from '../services/layout'
import { closePane, closeTab, collapseIfEmpty, createTabInWorktree } from '../tabs'
import { handle, broadcast } from './handle'

/** Tabs and panes: open / close / move / split, and the split ratios. */
export function register(): void {
  const h = handle
  h(IPC.createTab, (_e, worktreeId, paneId, type, config) => {
    const tab = createTabInWorktree(worktreeId, paneId, type, config)
    broadcast()
    return tab
  })

  h(IPC.closeTab, (_e, tabId) => closeTab(tabId))

  h(IPC.renameTab, (_e, tabId, title) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    // An empty title clears the override; JSON.stringify drops the undefined key.
    repo.tabs.updateConfig(tabId, { ...tab.config, title: title.trim() || undefined })
    broadcast()
  })

  h(IPC.updateTabConfig, (_e, tabId, patch) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    repo.tabs.updateConfig(tabId, { ...tab.config, ...patch })
    broadcast()
  })

  h(IPC.setActiveTab, (_e, paneId, tabId) => {
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

  // `slot` places the tab at an insertion point in the target pane's strip
  // (see shared/tabOrder); a same-pane move with a slot is a reorder.
  h(IPC.moveTab, (_e, tabId, targetPaneId, slot) => {
    const tab = repo.tabs.get(tabId)
    if (!tab) return
    if (tab.paneId === targetPaneId && slot === undefined) return
    assertPaneInWorktree(tab, targetPaneId)
    const source = tab.paneId
    repo.tabs.move(tabId, targetPaneId, slot)
    if (source !== targetPaneId) collapseIfEmpty(tab.worktreeId, source)
    broadcast()
  })

  h(IPC.splitPane, (_e, worktreeId, paneId, dir, where) => {
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

  h(IPC.closePane, (_e, worktreeId, paneId) => closePane(worktreeId, paneId))

  h(IPC.moveTabToEdge, (_e, tabId, targetPaneId, edge) => {
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

  h(IPC.setSplitRatio, (_e, worktreeId, splitId, ratio) => {
    const worktree = repo.worktrees.get(worktreeId)
    if (!worktree) return
    repo.worktrees.setLayout(worktreeId, setRatio(worktree.layout, splitId, ratio))
    broadcast()
  })
}
