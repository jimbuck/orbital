import { IPC } from '@shared/contract'
import { runtime } from '../runtime'
import { savePastedImage } from '../services/pasted-images'
import { humanTyped } from '../status'
import { handle, listen } from './handle'

/** The PTY bridge: keystrokes, resizes, the replay snapshot, and image paste. */
export function register(): void {
  const h = handle
  listen(IPC.terminalInput, (_e, tabId, data) => {
    runtime.terminals.write(tabId, data)
    // Typing into a tab that was waiting on a human answers it (req 7).
    humanTyped(tabId, data)
  })
  listen(IPC.terminalResize, (_e, tabId, cols, rows) => runtime.terminals.resize(tabId, cols, rows))
  h(IPC.terminalBuffer, (_e, tabId) => runtime.terminals.buffer(tabId))
  h(IPC.terminalAlive, (_e, tabId) => runtime.terminals.isAlive(tabId))
  h(IPC.pasteClipboardImage, () => savePastedImage())
}
