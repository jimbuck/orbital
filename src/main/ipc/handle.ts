import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { runtime } from '../runtime'
import { logger, summarizeArgs } from '../services/logger'

/**
 * Every UI action funnels through this wrapper so the debug logger sees each
 * invoke (channel + summarized args) and any thrown error, without touching
 * the individual handler call sites. It delegates to ipcMain.handle and
 * re-throws so the renderer still sees the original rejection. Logging is a
 * no-op unless debug logging is enabled, so this is free in the common case.
 */
export function handle(
  channel: string,
  fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, async (e, ...args) => {
    // Guard so summarizeArgs (allocates a mapped copy) never runs when logging
    // is off — this wrapper is on every UI invoke's path.
    if (logger.isEnabled()) logger.ui(channel, summarizeArgs(args))
    try {
      return await fn(e, ...args)
    } catch (err) {
      logger.error(`ipc ${channel} failed`, {
        message: err instanceof Error ? err.message : String(err)
      })
      throw err // preserve the existing rejection surfaced to the renderer
    }
  })
}

/** Push the full app state (coalesced). */
export const broadcast = (): void => runtime.broadcastState()
/** A checkout's git/working-tree state moved (not AppState): nudge its git consumers only. */
export const gitChanged = (worktreeId: string): void => runtime.broadcastGitChanged([worktreeId])
/** State plus the needs-attention recompute (anything that can change a status). */
export const broadcastAll = (): void => {
  runtime.broadcastState()
  runtime.broadcastAlert()
}
