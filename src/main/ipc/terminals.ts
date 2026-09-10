import { ipcMain } from 'electron'
import { IPC, isPtyTabType } from '@shared/types'
import { runtime, repo } from '../runtime'
import { savePastedImage } from '../services/pasted-images'
import { attentionKindOf, clearAttentionKind, isHumanKeystroke, markHumanAction, setTabStatus, statusAfterHumanInput } from '../status'
import { handle } from './handle'

/** The PTY bridge: keystrokes, resizes, the replay snapshot, and image paste. */
export function register(): void {
  const h = handle
  ipcMain.on(IPC.terminalInput, (_e, tabId: string, data: string) => {
    runtime.terminals.write(tabId, data)
    // If the human types into a PTY flagged needs-attention, they've responded —
    // so it is no longer blocked on a human. This covers agent tabs AND plain
    // terminal tabs (an agent launched by hand, or `orbital status`, flags those
    // just the same). Where it goes depends on why it was blocked — see
    // statusAfterHumanInput. Uses INPUT only — never scrapes terminal output (req 7).
    const tab = repo.tabs.get(tabId)
    if (tab && isPtyTabType(tab.type) && tab.status === 'needs_attention' && isHumanKeystroke(data)) {
      // The human's response supersedes anything already in flight: hook events
      // fired before this moment must not overwrite the flip below.
      markHumanAction(tabId)
      const next = statusAfterHumanInput(attentionKindOf(tabId))
      clearAttentionKind(tabId)
      setTabStatus(tabId, tab.worktreeId, next)
    }
  })
  ipcMain.on(IPC.terminalResize, (_e, tabId: string, cols: number, rows: number) =>
    runtime.terminals.resize(tabId, cols, rows)
  )
  h(IPC.terminalBuffer, (_e, tabId: string) => runtime.terminals.buffer(tabId))
  h(IPC.terminalAlive, (_e, tabId: string) => runtime.terminals.isAlive(tabId))
  h(IPC.pasteClipboardImage, () => savePastedImage())
}
