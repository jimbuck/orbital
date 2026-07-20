import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileNode } from '@shared/types'

/**
 * Shared file-tree cache for editor tabs.
 *
 * Editor tabs stay mounted (hidden) when inactive so their in-memory state
 * survives tab switches. Naively, each mounted `EditorTab` would subscribe to
 * `onStateChanged` and fire its own debounced `fileTree(worktreeId)` refetch —
 * so N editors of the same worktree would multiply identical IPC calls on every
 * state broadcast, and even a single hidden editor would keep refetching in the
 * background while the user is on another tab.
 *
 * This registry fixes both:
 *  - Dedup (#2): one `onStateChanged` subscription + one `fileTree` fetch per
 *    worktree id, shared by every editor consuming that worktree. New consumers
 *    reuse the cached tree immediately.
 *  - Pause-while-hidden (#1): a state change only triggers a refetch while at
 *    least one consumer of that worktree is active (its tab is showing). While
 *    every consumer is hidden the entry is marked dirty and refetched once, on
 *    the next reveal — a hidden editor does no background IPC.
 */

interface FileTreeBridge {
  fileTree: (worktreeId: string) => Promise<FileNode[]>
  onStateChanged: (cb: () => void) => () => void
}

/** Lazily bound so importing this module never touches `window.orbital`. */
function defaultBridge(): FileTreeBridge {
  return {
    fileTree: (id) => window.orbital.fileTree(id),
    // The app broadcast carries a state payload we don't need here.
    onStateChanged: (cb) => window.orbital.onStateChanged(() => cb())
  }
}

let bridgeOverride: FileTreeBridge | null = null
function bridge(): FileTreeBridge {
  return bridgeOverride ?? defaultBridge()
}

/** Debounce (ms) for coalescing state-change-driven refetches. */
let debounceMs = 400

interface Subscriber {
  onTree: (tree: FileNode[]) => void
  active: boolean
}

interface Entry {
  worktreeId: string
  tree: FileNode[]
  subscribers: Set<Subscriber>
  unsub: (() => void) | null
  timer: ReturnType<typeof setTimeout> | undefined
  /** A state change arrived since the last fetch. */
  dirty: boolean
  /** A fetch is in flight (coalesces concurrent triggers to one RPC). */
  fetching: boolean
  /** At least one successful fetch has completed (tree is meaningful). */
  loadedOnce: boolean
  /** False once the last consumer released and the entry was torn down. */
  alive: boolean
}

const registry = new Map<string, Entry>()

function anyActive(entry: Entry): boolean {
  for (const s of entry.subscribers) if (s.active) return true
  return false
}

function refetchNow(entry: Entry): void {
  if (entry.fetching) return // an in-flight fetch will deliver to all subscribers
  clearTimeout(entry.timer)
  entry.timer = undefined
  entry.fetching = true
  void bridge()
    .fileTree(entry.worktreeId)
    .then((tree) => {
      entry.fetching = false
      if (!entry.alive) return
      entry.tree = tree
      entry.loadedOnce = true
      entry.dirty = false
      for (const s of entry.subscribers) s.onTree(tree)
      // A state change during the fetch re-dirtied us — chase it (only while visible).
      if (entry.dirty && anyActive(entry)) scheduleRefetch(entry)
    })
    .catch(() => {
      // Leave the last good tree in place; a later change or reveal retries.
      entry.fetching = false
    })
}

function scheduleRefetch(entry: Entry): void {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    // Re-check visibility at fire time: if everything went hidden during the
    // debounce, stay dirty and defer to the next reveal.
    if (anyActive(entry)) refetchNow(entry)
  }, debounceMs)
}

/** Load if we've never loaded or are stale; no-op if already fresh or fetching. */
function ensureLoaded(entry: Entry): void {
  if (entry.fetching) return
  if (entry.loadedOnce && !entry.dirty) return
  refetchNow(entry)
}

function onStateChange(entry: Entry): void {
  entry.dirty = true
  if (anyActive(entry)) scheduleRefetch(entry)
}

export interface FileTreeHandle {
  /** Mark this consumer's tab shown/hidden; showing a stale tab refetches once. */
  setActive: (active: boolean) => void
  /** Force an immediate refetch (the tree's manual refresh button). */
  refresh: () => void
  /** Detach this consumer; the last release tears the shared entry down. */
  release: () => void
}

/**
 * Low-level registry entry point (exported for tests). React components should
 * use {@link useFileTree}.
 */
export function acquireFileTree(worktreeId: string, onTree: (tree: FileNode[]) => void): FileTreeHandle {
  let entry = registry.get(worktreeId)
  if (!entry) {
    entry = {
      worktreeId,
      tree: [],
      subscribers: new Set(),
      unsub: null,
      timer: undefined,
      dirty: false,
      fetching: false,
      loadedOnce: false,
      alive: true
    }
    registry.set(worktreeId, entry)
    entry.unsub = bridge().onStateChanged(() => onStateChange(entry!))
  }
  const sub: Subscriber = { onTree, active: false }
  entry.subscribers.add(sub)
  // Hand a late joiner the cached tree straight away.
  if (entry.loadedOnce) onTree(entry.tree)

  return {
    setActive(active) {
      if (sub.active === active) return
      sub.active = active
      if (active) ensureLoaded(entry!)
    },
    refresh() {
      refetchNow(entry!)
    },
    release() {
      entry!.subscribers.delete(sub)
      if (entry!.subscribers.size === 0) {
        entry!.alive = false
        clearTimeout(entry!.timer)
        entry!.unsub?.()
        registry.delete(worktreeId)
      }
    }
  }
}

/**
 * Subscribe a component to its worktree's shared file tree. `active` reflects
 * whether this editor's tab is currently showing; while it's false the tree is
 * not refetched on state changes (it refreshes once when shown again).
 */
export function useFileTree(
  worktreeId: string | undefined,
  active: boolean
): { tree: FileNode[]; refresh: () => void } {
  const [tree, setTree] = useState<FileNode[]>([])
  const handleRef = useRef<FileTreeHandle | null>(null)

  useEffect(() => {
    if (!worktreeId) {
      setTree([])
      return
    }
    const handle = acquireFileTree(worktreeId, setTree)
    handleRef.current = handle
    return () => {
      handle.release()
      handleRef.current = null
    }
  }, [worktreeId])

  useEffect(() => {
    handleRef.current?.setActive(active)
  }, [active])

  const refresh = useCallback(() => handleRef.current?.refresh(), [])
  return { tree, refresh }
}

/* ---- Test hooks ---------------------------------------------------------- */

/** Swap the IPC bridge (tests). Pass null to restore the real `window.orbital`. */
export function __setFileTreeBridge(b: FileTreeBridge | null): void {
  bridgeOverride = b
}

/** Override the refetch debounce (tests). */
export function __setFileTreeDebounce(ms: number): void {
  debounceMs = ms
}

/** Drop all cached entries and pending timers (tests). */
export function __resetFileTreeRegistry(): void {
  for (const entry of registry.values()) {
    entry.alive = false
    clearTimeout(entry.timer)
    entry.unsub?.()
  }
  registry.clear()
}
