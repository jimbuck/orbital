import { contextBridge, ipcRenderer, clipboard, type IpcRendererEvent } from 'electron'
import { channelOf, contract, type LocalName, type OrbitalApi } from '@shared/contract'

/**
 * The preload bridge: builds `window.orbital` from the window contract. Each
 * operation's kind decides how it crosses to main, so there is nothing to
 * write here when one is added to the contract — only an operation that never
 * leaves this process (`local`) has an implementation of its own, below.
 */

/** Operations implemented right here. The contract's `local` entries, no more and no fewer. */
const local: Pick<OrbitalApi, LocalName> = {
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(text)
}

/** Subscribe to a main->renderer push channel; returns an unsubscribe fn. */
function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Record<string, unknown> = { ...local }
for (const [name, op] of Object.entries(contract)) {
  const channel = channelOf(name, op.kind)
  if (channel === null) continue
  if (op.kind === 'invoke') api[name] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  else if (op.kind === 'send') api[name] = (...args: unknown[]) => ipcRenderer.send(channel, ...args)
  else api[name] = (cb: (payload: unknown) => void) => on(channel, cb)
}

contextBridge.exposeInMainWorld('orbital', api)
