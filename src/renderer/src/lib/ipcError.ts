/**
 * Strip Electron's IPC-rejection wrapper so a banner shows the main-process
 * error itself (git's stderr, the size-cap message, ...) rather than
 * "Error invoking remote method 'orbital:...': Error: ...".
 */
export function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim()
}
