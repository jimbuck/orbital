import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { InvokeName, OrbitalApi, SendName } from '@shared/contract'
import { runtime } from '../runtime'
import { logger, summarizeArgs } from '../services/logger'

type Result<N extends InvokeName> = Awaited<ReturnType<OrbitalApi[N]>>

/**
 * Register the handler for a request the renderer awaits. The channel names
 * the operation, and the window contract gives the handler its types: the
 * arguments arrive typed as the operation declares them (no annotations
 * needed at the call site), and what the handler returns must be what the
 * operation promises the renderer.
 *
 * Every UI action funnels through this wrapper so the debug logger sees each
 * invoke (channel + summarized args) and any thrown error, without touching
 * the individual handler call sites. It delegates to ipcMain.handle and
 * re-throws so the renderer still sees the original rejection. Logging is a
 * no-op unless debug logging is enabled, so this is free in the common case.
 */
export function handle<N extends InvokeName>(
  channel: `orbital:${N}`,
  fn: (e: IpcMainInvokeEvent, ...args: Parameters<OrbitalApi[N]>) => Result<N> | Promise<Result<N>>
): void {
  ipcMain.handle(channel, async (e, ...args) => {
    // Guard so summarizeArgs (allocates a mapped copy) never runs when logging
    // is off — this wrapper is on every UI invoke's path.
    if (logger.isEnabled()) logger.ui(channel, summarizeArgs(args))
    try {
      return await fn(e, ...(args as Parameters<OrbitalApi[N]>))
    } catch (err) {
      logger.error(`ipc ${channel} failed`, {
        message: err instanceof Error ? err.message : String(err)
      })
      throw err // preserve the existing rejection surfaced to the renderer
    }
  })
}

/**
 * Register the listener for a fire-and-forget message from the renderer
 * (keystrokes, resizes, window controls). Typed from the contract like
 * {@link handle}; not logged, because terminal input is on this path.
 */
export function listen<N extends SendName>(
  channel: `orbital:${N}`,
  fn: (e: IpcMainEvent, ...args: Parameters<OrbitalApi[N]>) => void
): void {
  ipcMain.on(channel, (e, ...args) => fn(e, ...(args as Parameters<OrbitalApi[N]>)))
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
