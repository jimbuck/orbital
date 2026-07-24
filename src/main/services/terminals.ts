/**
 * Orbital — terminal (PTY) manager.
 *
 * Owns the lifecycle of every interactive terminal, one node-pty process per
 * tabId. Each terminal keeps a bounded scrollback ring buffer so a renderer tab
 * can replay its history when it remounts. Emits 'data' and 'exit' events that
 * the IPC layer fans out to the renderer (TerminalDataEvent / TerminalExitEvent).
 */
import * as pty from 'node-pty'
import { EventEmitter } from 'node:events'
import type { TerminalBuffer } from '@shared/types'

/** Maximum scrollback retained per terminal, in characters. Oldest is trimmed. */
const MAX_BUFFER = 200_000

/**
 * How long a prepared PTY waits for the renderer to report its real size before
 * spawning at the 80×24 default anyway. The common case (a visible tab) reports
 * within a frame or two, well under this; the fallback only elapses for a tab
 * that is never viewed (e.g. restored into a background worktree on boot).
 */
const DEFERRED_SPAWN_FALLBACK_MS = 1500

export interface SpawnOptions {
  tabId: string
  cwd: string
  shell?: string
  /** Explicit executable + argv to run instead of an interactive shell (agent tabs). */
  command?: { file: string; args: string[] }
  env: Record<string, string>
  cols?: number
  rows?: number
}

/** Internal per-tab record: the live PTY (null for a static notice) plus its scrollback. */
interface TerminalEntry {
  proc: pty.IPty | null
  buf: string
  /** Cumulative bytes ever emitted (monotonic; survives ring trimming). */
  total: number
}

/**
 * Manages node-pty processes keyed by tabId.
 *
 * Events:
 *  - 'data' -> { tabId: string, data: string }
 *  - 'exit' -> { tabId: string, exitCode: number }
 */
export class TerminalManager extends EventEmitter {
  private readonly terminals = new Map<string, TerminalEntry>()
  /** Spawns registered via prepare() that are waiting for the renderer's first size. */
  private readonly deferred = new Map<string, SpawnOptions>()
  /** Fallback timers that spawn a deferred PTY at the default size if no size arrives. */
  private readonly deferredTimers = new Map<string, NodeJS.Timeout>()
  /** A size reported before its spawn was prepared (async agent lookup still running). */
  private readonly firstSize = new Map<string, { cols: number; rows: number }>()

  /**
   * Register a PTY to spawn once the renderer reports the tab's real size, then
   * spawn it at those dimensions. This keeps a child process (e.g. an agent CLI
   * that paints a full-screen UI the instant it starts) from rendering its first
   * frame at the 80×24 default and then reflowing when the size correction lands
   * — the "jumbled on open" the user sees. If the size was already reported,
   * spawns immediately; if none arrives within DEFERRED_SPAWN_FALLBACK_MS (a tab
   * that is never viewed), spawns at the default so the PTY still starts.
   */
  prepare(opts: SpawnOptions): void {
    const { tabId } = opts
    if (this.terminals.has(tabId)) this.kill(tabId)
    const size = this.firstSize.get(tabId)
    if (size) {
      this.firstSize.delete(tabId)
      this.spawn({ ...opts, cols: size.cols, rows: size.rows })
      return
    }
    this.deferred.set(tabId, opts)
    this.deferredTimers.set(
      tabId,
      setTimeout(() => this.flushDeferred(tabId), DEFERRED_SPAWN_FALLBACK_MS)
    )
  }

  /** Spawn a still-deferred PTY at the reported size, or the default if none. */
  private flushDeferred(tabId: string, cols?: number, rows?: number): void {
    const opts = this.deferred.get(tabId)
    if (!opts) return
    this.clearDeferred(tabId)
    this.spawn({ ...opts, cols, rows })
  }

  /** Drop a pending deferred spawn and cancel its fallback timer. */
  private clearDeferred(tabId: string): void {
    this.deferred.delete(tabId)
    const timer = this.deferredTimers.get(tabId)
    if (timer) {
      clearTimeout(timer)
      this.deferredTimers.delete(tabId)
    }
  }

  /** Spawn a PTY for `tabId`, replacing any existing terminal under that id. */
  spawn(opts: SpawnOptions): void {
    // Cancel any deferral for this tab; this spawn supersedes it.
    this.clearDeferred(opts.tabId)
    this.firstSize.delete(opts.tabId)
    // A tabId maps to at most one live PTY; replace an existing one.
    if (this.terminals.has(opts.tabId)) {
      this.kill(opts.tabId)
    }

    // An agent tab supplies an explicit command; a plain terminal runs a shell.
    const file =
      opts.command?.file ||
      opts.shell ||
      (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash')
    const args = opts.command?.args ?? []

    const proc = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      useConpty: true
    })

    const entry: TerminalEntry = { proc, buf: '', total: 0 }
    this.terminals.set(opts.tabId, entry)

    proc.onData((data) => {
      // Ignore trailing output from a PTY that has already been replaced.
      if (this.terminals.get(opts.tabId) !== entry) return
      // Append to the ring buffer, trimming the oldest overflow.
      entry.buf += data
      if (entry.buf.length > MAX_BUFFER) {
        entry.buf = entry.buf.slice(entry.buf.length - MAX_BUFFER)
      }
      entry.total += data.length
      this.emit('data', { tabId: opts.tabId, data, seq: entry.total })
    })

    proc.onExit(({ exitCode }) => {
      // Only react if this PTY is still the current one for the tab; a PTY that
      // was replaced (kill+respawn under the same id) must not clobber its successor.
      if (this.terminals.get(opts.tabId) !== entry) return
      this.terminals.delete(opts.tabId)
      this.emit('exit', { tabId: opts.tabId, exitCode })
    })
  }

  /**
   * Show a static one-shot notice in a tab that has no live process (e.g. an agent
   * whose executable could not be resolved), so the tab explains itself instead of
   * sitting blank. Replaces any existing PTY/notice under the id.
   */
  notify(tabId: string, message: string): void {
    this.clearDeferred(tabId)
    this.firstSize.delete(tabId)
    if (this.terminals.has(tabId)) this.kill(tabId)
    const entry: TerminalEntry = { proc: null, buf: message, total: message.length }
    this.terminals.set(tabId, entry)
    this.emit('data', { tabId, data: message, seq: entry.total })
  }

  /** Forward keystrokes / input to the terminal, if it has a live PTY. */
  write(tabId: string, data: string): void {
    this.terminals.get(tabId)?.proc?.write(data)
  }

  /** Resize the terminal's PTY, or spawn a deferred one now that its size is known. */
  resize(tabId: string, cols: number, rows: number): void {
    const entry = this.terminals.get(tabId)
    if (entry?.proc) {
      entry.proc.resize(cols, rows)
      return
    }
    // No live PTY yet: this is the first size for a deferred spawn (spawn it now),
    // or it arrived before the spawn was prepared (remember it for prepare()).
    if (this.deferred.has(tabId)) this.flushDeferred(tabId, cols, rows)
    else this.firstSize.set(tabId, { cols, rows })
  }

  /** Whether the tab has a live PTY process (false for exited shells and static notices). */
  isAlive(tabId: string): boolean {
    return !!this.terminals.get(tabId)?.proc
  }

  /** Current scrollback + sequence cut-point for replay; empty if unknown. */
  buffer(tabId: string): TerminalBuffer {
    const entry = this.terminals.get(tabId)
    return entry ? { data: entry.buf, seq: entry.total } : { data: '', seq: 0 }
  }

  /** Kill and drop the terminal for `tabId`, including any pending deferred spawn. */
  kill(tabId: string): void {
    this.clearDeferred(tabId)
    this.firstSize.delete(tabId)
    const entry = this.terminals.get(tabId)
    if (!entry) return
    this.terminals.delete(tabId)
    entry.proc?.kill()
  }

  /** Kill every managed terminal (e.g. on app shutdown). */
  killAll(): void {
    for (const tabId of [...this.terminals.keys()]) {
      this.kill(tabId)
    }
    // Deferred spawns have no live PTY, so they are not in `terminals` — clear them too.
    for (const tabId of [...this.deferred.keys()]) {
      this.clearDeferred(tabId)
    }
    this.firstSize.clear()
  }
}
