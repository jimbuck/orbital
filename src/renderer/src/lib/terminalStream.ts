import type { TerminalDataEvent, TerminalExitEvent } from '@shared/types'

/**
 * One bridge subscription for terminal output, fanned out by tab id.
 *
 * Every mounted terminal (hidden ones included — PTY tabs stay mounted) used
 * to register its own `ipcRenderer` listener and filter on `evt.tabId`, so
 * each chunk from any PTY woke every terminal, and past ten tabs Node warned
 * about listener counts. Here the bridge is subscribed once, lazily, and
 * dropped again when the last tab leaves, so tests that stub the bridge per
 * case see a fresh subscription each time.
 */

type Handler<T> = (evt: T) => void

interface Channel<T extends { tabId: string }> {
  handlers: Map<string, Set<Handler<T>>>
  unsub: (() => void) | null
  subscribe: (dispatch: (evt: T) => void) => () => void
}

function channel<T extends { tabId: string }>(subscribe: Channel<T>['subscribe']): Channel<T> {
  return { handlers: new Map(), unsub: null, subscribe }
}

const dataChannel = channel<TerminalDataEvent>((cb) => window.orbital.onTerminalData(cb))
const exitChannel = channel<TerminalExitEvent>((cb) => window.orbital.onTerminalExit(cb))

function listen<T extends { tabId: string }>(ch: Channel<T>, tabId: string, handler: Handler<T>): () => void {
  let set = ch.handlers.get(tabId)
  if (!set) {
    set = new Set()
    ch.handlers.set(tabId, set)
  }
  set.add(handler)
  if (!ch.unsub) {
    ch.unsub = ch.subscribe((evt) => {
      const targets = ch.handlers.get(evt.tabId)
      if (!targets) return
      for (const h of [...targets]) h(evt)
    })
  }
  return () => {
    const cur = ch.handlers.get(tabId)
    if (!cur) return
    cur.delete(handler)
    if (cur.size === 0) ch.handlers.delete(tabId)
    if (ch.handlers.size === 0 && ch.unsub) {
      ch.unsub()
      ch.unsub = null
    }
  }
}

/** Output for one tab; returns the unsubscribe. */
export function onTerminalData(tabId: string, handler: Handler<TerminalDataEvent>): () => void {
  return listen(dataChannel, tabId, handler)
}

/** Process exit for one tab; returns the unsubscribe. */
export function onTerminalExit(tabId: string, handler: Handler<TerminalExitEvent>): () => void {
  return listen(exitChannel, tabId, handler)
}
