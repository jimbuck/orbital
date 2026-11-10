import { ipcMain } from 'electron'
import { IPC } from '@shared/types'
import { runtime } from '../runtime'
import { savePastedImage } from '../services/pasted-images'
import { humanTyped } from '../status'
import { handle } from './handle'

/** The PTY bridge: keystrokes, resizes, the replay snapshot, and image paste. */
export function register(): void {
  const h = handle
  ipcMain.on(IPC.terminalInput, (_e, tabId: string, data: string) => {
    runtime.terminals.write(tabId, data)
    // Typing into a tab that was waiting on a human answers it (req 7).
    humanTyped(tabId, data)
  })
  ipcMain.on(IPC.terminalResize, (_e, tabId: string, cols: number, rows: number) =>
    runtime.terminals.resize(tabId, cols, rows)
  )
  h(IPC.terminalBuffer, (_e, tabId: string) => runtime.terminals.buffer(tabId))
  h(IPC.terminalAlive, (_e, tabId: string) => runtime.terminals.isAlive(tabId))
  h(IPC.pasteClipboardImage, () => savePastedImage())
}
