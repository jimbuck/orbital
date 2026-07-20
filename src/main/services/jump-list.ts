import { app } from 'electron'
import { workspaces } from '../db/repositories'
import { logger } from './logger'

/**
 * Windows taskbar jump list: right-clicking Orbital's taskbar icon offers the
 * recent workspaces. Each entry relaunches the app with `--workspace-id <id>` —
 * the same shape launchWorkspace uses — so a closed app boots straight into
 * that workspace, and an already-open one hits its single-instance lock and
 * just focuses its window.
 */

/** Windows shows ~10 jump-list slots by default; keep the category tidy. */
const MAX_RECENT = 7

/**
 * Rebuild the "Recent" category from the DB, most recently opened first.
 * Called once after startup (this instance's boot already bumped its
 * workspace's `last_opened_at`) and whenever the list meaningfully changes —
 * a workspace opened, renamed or removed. No-op off Windows, and in sandboxed
 * test runs (ORBITAL_USER_DATA): those share the real app's AppUserModelId, so
 * writing would clobber the user's actual jump list with entries whose ids
 * don't exist outside the sandbox DB.
 */
export function refreshJumpList(): void {
  if (process.platform !== 'win32') return
  if (process.env['ORBITAL_USER_DATA']) return

  // Windows rejects the whole category when it re-adds an item the user
  // explicitly removed from the jump list — honor removals instead.
  const removed = new Set(app.getJumpListSettings().removedItems.map((i) => i.args ?? ''))

  // Packaged: the exe IS the app. Dev: process.execPath is electron.exe, which
  // needs the app dir as its first argument (same shape launchWorkspace uses).
  const devPrefix = app.isPackaged ? '' : `"${app.getAppPath()}" `

  const items = workspaces
    .list() // most recently opened first
    .filter((ws) => ws.lastOpenedAt > 0) // created-but-never-opened isn't "recent"
    .slice(0, MAX_RECENT)
    .map((ws) => ({
      type: 'task' as const,
      title: ws.name,
      description: `Open the ${ws.name} workspace`,
      program: process.execPath,
      args: `${devPrefix}"--workspace-id=${ws.id}"`,
      iconPath: process.execPath,
      iconIndex: 0
    }))
    .filter((item) => !removed.has(item.args))

  const result = app.setJumpList(
    items.length > 0 ? [{ type: 'custom' as const, name: 'Recent', items }] : null
  )
  if (result !== 'ok') logger.warn('jump list update failed', { result })
}
