import type { GitFileState, Pane, Tab, TabConfig, TabType } from '@shared/types'
import { useStore, activePaneId } from '@renderer/store'
import { resolveOpenTarget } from './paneTarget'

/**
 * Opening tabs from OUTSIDE the pane area — the command palette, the git
 * panel's change list, the title bar's dev-server menu.
 *
 * These callers have no pane in hand, so where their tab lands is the user's
 * choice: the Default Open Action setting (Settings ▸ Opening tabs). The rule
 * itself is pure and lives in {@link resolveOpenTarget}; this module is the part
 * that talks to main.
 *
 * Openers that DO name a pane — a tab strip's +, an empty pane's buttons, a
 * link clicked inside a terminal — deliberately do not come through here. They
 * already say where they want the tab, and the setting is about the case where
 * nobody has said.
 */

/** Create a tab in the pane the Default Open Action points at. */
export async function openTab(
  worktreeId: string,
  type: TabType,
  config?: TabConfig,
  /** A pane to keep clear — see {@link resolveOpenTarget}. */
  avoidPaneId?: string
): Promise<Tab | undefined> {
  const s = useStore.getState()
  const worktree = s.worktrees.find((w) => w.id === worktreeId)
  const action = s.settings?.defaultOpenAction ?? 'right'
  const target = worktree
    ? resolveOpenTarget(worktree.layout, activePaneId(s, worktreeId), action, avoidPaneId)
    : null

  // No layout to reason about (state not loaded, a Worktree mid-creation):
  // null is main's "first pane", the same fallback every other caller uses.
  if (!target) return window.orbital.createTab(worktreeId, null, type, config)
  if (target.kind === 'pane') return window.orbital.createTab(worktreeId, target.paneId, type, config)

  // Deliberately sequential: the new pane's id comes back from the split, and
  // a tab created before it exists would land in the pane we split away from.
  const pane: Pane = await window.orbital.splitPane(worktreeId, target.paneId, target.dir, target.where)
  return window.orbital.createTab(worktreeId, pane.id, type, config)
}

/** The editor tab best placed to show another file, or undefined if there is none. */
function findEditor(worktreeId: string, avoidPaneId?: string): Tab | undefined {
  const s = useStore.getState()
  const worktree = s.worktrees.find((w) => w.id === worktreeId)
  if (!worktree) return undefined
  const paneId = activePaneId(s, worktreeId)
  const editorIn = (pane: Pane): Tab | undefined => {
    const active = pane.tabs.find((t) => t.id === pane.activeTabId)
    return active?.type === 'editor' ? active : pane.tabs.find((t) => t.type === 'editor')
  }
  // A caller with a pane to keep clear would rather open a second editor
  // elsewhere than reuse one that sits on top of its own results.
  const candidates = worktree.panes.filter((p) => p.id !== avoidPaneId)
  // The pane the user last worked in is asked first, so a file joins the editor
  // they are looking at rather than one parked in a corner of the layout.
  const panes = candidates.sort((a, b) => (a.id === paneId ? -1 : b.id === paneId ? 1 : 0))
  return panes.map(editorIn).find((t): t is Tab => !!t)
}

/**
 * Show `path` in an editor of `worktreeId`, switching the Worktree into view
 * first when the file lives in another one.
 *
 * An editor tab holds many files, so an existing one is reused wherever
 * possible: opening thirty files from the palette should not leave thirty tabs
 * behind. Only when the Worktree has no editor at all does one get created, in
 * the pane the Default Open Action names.
 */
export function openFileInEditor(
  worktreeId: string,
  path: string,
  opts: { staged?: boolean; gitState?: GitFileState; line?: number; avoidPaneId?: string } = {}
): void {
  const s = useStore.getState()
  const staged = opts.staged ?? false
  // Opening a file in a Worktree that isn't on screen has to bring it on
  // screen — the pane area renders the ACTIVE Worktree, so otherwise the tab
  // appears somewhere the user cannot see.
  if (s.activeWorktreeId !== worktreeId && s.worktrees.some((w) => w.id === worktreeId)) {
    s.setActiveWorktree(worktreeId)
  }

  const editor = findEditor(worktreeId, opts.avoidPaneId)
  if (editor) {
    void window.orbital.setActiveTab(editor.paneId, editor.id)
    useStore.getState().openInEditor(editor.id, { path, staged, gitState: opts.gitState, line: opts.line })
    return
  }
  // No editor yet: create one on the file, then ask it for the line once it
  // exists. The tab's own config opens the file; the request carries the line,
  // which a TabConfig has no room for.
  void openTab(worktreeId, 'editor', { filePath: path, diffStaged: staged }, opts.avoidPaneId).then((tab) => {
    if (tab && opts.line !== undefined) useStore.getState().openInEditor(tab.id, { path, line: opts.line })
  })
}
