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

  /** Spawn a PTY for `tabId`, replacing any existing terminal under that id. */
  spawn(opts: SpawnOptions): void {
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
    if (this.terminals.has(tabId)) this.kill(tabId)
    const entry: TerminalEntry = { proc: null, buf: message, total: message.length }
    this.terminals.set(tabId, entry)
    this.emit('data', { tabId, data: message, seq: entry.total })
  }

  /** Forward keystrokes / input to the terminal, if it has a live PTY. */
  write(tabId: string, data: string): void {
    this.terminals.get(tabId)?.proc?.write(data)
  }

  /** Resize the terminal's PTY, if it has one. */
  resize(tabId: string, cols: number, rows: number): void {
    const entry = this.terminals.get(tabId)
    if (!entry || !entry.proc) return
    entry.proc.resize(cols, rows)
  }

  /** Current scrollback + sequence cut-point for replay; empty if unknown. */
  buffer(tabId: string): TerminalBuffer {
    const entry = this.terminals.get(tabId)
    return entry ? { data: entry.buf, seq: entry.total } : { data: '', seq: 0 }
  }

  /** Kill and drop the terminal for `tabId`, if it exists. */
  kill(tabId: string): void {
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
  }
}
