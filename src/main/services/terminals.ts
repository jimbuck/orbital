/**
 * Orbital — terminal (PTY) manager.
 *
 * Owns the lifecycle of every interactive terminal, one node-pty process per
 * tabId. Each terminal keeps a headless mirror of its screen so a renderer tab
 * can be handed the terminal's current state when it remounts. Emits 'data' and
 * 'exit' events that the IPC layer fans out to the renderer (TerminalDataEvent /
 * TerminalExitEvent).
 */
import * as pty from 'node-pty'
import { EventEmitter } from 'node:events'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { TerminalBuffer } from '@shared/types'

/**
 * Lines of history the mirror keeps above the screen. The same as the view's
 * own scrollback (xterm's default), so a remount gives back what was there.
 */
const SCROLLBACK_LINES = 1000

/**
 * How long output is coalesced before one 'data' event per tab goes out.
 * node-pty hands over many small reads under load (a build, `cat` of a big
 * file); forwarding each as its own IPC message cost a structured clone and a
 * renderer wake-up per read. A few milliseconds is below anything a person can
 * see and turns thousands of messages a second into ~100.
 */
const FLUSH_MS = 8

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

/**
 * A headless terminal fed the same output as the view. A remounting tab is
 * given this terminal's STATE (screen, scrollback, cursor, modes) rather than
 * a replay of the raw output that produced it.
 *
 * A raw log has to be capped, and a capped log cannot be replayed: ConPTY, and
 * any program that redraws only what changed, positions its writes on a screen
 * it assumes is already there. Cut the head off the log and everything drawn
 * before the cut and not touched since (an agent CLI's input box and status
 * line, while only its spinner ticks) is absent from the replay. Replaying
 * also re-ran every side effect in the log, an OSC 52 clipboard write or a
 * device query among them.
 */
interface Mirror {
  screen: HeadlessTerminal
  serializer: SerializeAddon
  /**
   * Whether the program hid the cursor (DECTCEM). The serializer leaves this
   * out, and a TUI that draws its own caret would otherwise come back with the
   * terminal's blinking over it.
   */
  cursorHidden: boolean
  /** Snapshots waiting on output still being parsed; settled empty on dispose. */
  waiters: Set<() => void>
}

function createMirror(cols: number, rows: number): Mirror {
  const screen = new HeadlessTerminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true })
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  const mirror: Mirror = { screen, serializer, cursorHidden: false, waiters: new Set() }
  const track =
    (hidden: boolean) =>
    (params: (number | number[])[]): boolean => {
      if (params.includes(25)) mirror.cursorHidden = hidden
      return false // observe only: the terminal still handles the sequence
    }
  screen.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(true))
  screen.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(false))
  return mirror
}

function disposeMirror(mirror: Mirror): void {
  for (const settle of [...mirror.waiters]) settle()
  mirror.screen.dispose()
}

/** Internal per-tab record: the live PTY and its mirror, or a static notice. */
interface TerminalEntry {
  proc: pty.IPty | null
  /** Null for a static notice, which has no screen to keep: `notice` is all of it. */
  mirror: Mirror | null
  notice: string
  /** Cumulative characters ever emitted (monotonic). */
  total: number
  /** Last size pushed to the PTY, so an unchanged report is not a ConPTY resize. */
  cols: number
  rows: number
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
  /** Output received since the last flush, per tab, with the seq of its last chunk. */
  private readonly pending = new Map<string, { data: string; seq: number }>()
  private flushTimer: NodeJS.Timeout | null = null

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

    const mirror = createMirror(opts.cols || 80, opts.rows || 24)
    const entry: TerminalEntry = {
      proc,
      mirror,
      notice: '',
      total: 0,
      cols: opts.cols || 80,
      rows: opts.rows || 24
    }
    this.terminals.set(opts.tabId, entry)

    proc.onData((data) => {
      // Ignore trailing output from a PTY that has already been replaced.
      if (this.terminals.get(opts.tabId) !== entry) return
      entry.total += data.length
      try {
        mirror.screen.write(data)
      } catch {
        // xterm refuses writes once tens of megabytes sit unparsed. The view
        // still gets the output; only a later remount would be missing it.
      }
      this.queue(opts.tabId, data, entry.total)
    })

    proc.onExit(({ exitCode }) => {
      // Only react if this PTY is still the current one for the tab; a PTY that
      // was replaced (kill+respawn under the same id) must not clobber its successor.
      if (this.terminals.get(opts.tabId) !== entry) return
      this.terminals.delete(opts.tabId)
      disposeMirror(mirror)
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
    const entry: TerminalEntry = {
      proc: null,
      mirror: null,
      notice: message,
      total: message.length,
      cols: 0,
      rows: 0
    }
    this.terminals.set(tabId, entry)
    this.emit('data', { tabId, data: message, seq: entry.total })
  }

  /** Coalesce a chunk into the tab's pending batch; the flush timer sends it. */
  private queue(tabId: string, data: string, seq: number): void {
    const cur = this.pending.get(tabId)
    if (cur) {
      cur.data += data
      cur.seq = seq
    } else {
      this.pending.set(tabId, { data, seq })
    }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  /** Emit every pending batch now (one 'data' event per tab). */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.size === 0) return
    const batches = [...this.pending]
    this.pending.clear()
    for (const [tabId, { data, seq }] of batches) this.emit('data', { tabId, data, seq })
  }

  /** Forward keystrokes / input to the terminal, if it has a live PTY. */
  write(tabId: string, data: string): void {
    this.terminals.get(tabId)?.proc?.write(data)
  }

  /** Resize the terminal's PTY, or spawn a deferred one now that its size is known. */
  resize(tabId: string, cols: number, rows: number): void {
    const entry = this.terminals.get(tabId)
    if (entry?.proc) {
      // A ConPTY resize makes every full-screen program repaint; skip the
      // no-ops a drag's ResizeObserver produces at frame rate.
      if (entry.cols === cols && entry.rows === rows) return
      entry.cols = cols
      entry.rows = rows
      entry.proc.resize(cols, rows)
      entry.mirror?.screen.resize(cols, rows)
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

  /**
   * The terminal's current state as a string a fresh xterm can be written to
   * reproduce it, with the size it was drawn at and the sequence cut-point it
   * covers; empty if unknown.
   *
   * Pending batches are flushed FIRST. A batch's seq is that of its last chunk,
   * and the renderer replays a queued batch only when its seq lies past the
   * snapshot's — so a batch must never straddle the cut-point, which it would
   * if a chunk arrived between this snapshot and the timer. The flush goes out
   * ahead of the reply on the same ordered channel.
   *
   * The mirror parses its input a slice at a time, so the snapshot is taken
   * from a marker written behind everything received so far: xterm runs the
   * marker's callback after that output and before any that arrives later,
   * which is exactly the state `seq` names.
   */
  buffer(tabId: string): Promise<TerminalBuffer> {
    this.flush()
    const entry = this.terminals.get(tabId)
    if (!entry) return Promise.resolve({ data: '', seq: 0, cols: 0, rows: 0 })
    const { mirror } = entry
    const seq = entry.total
    if (!mirror) return Promise.resolve({ data: entry.notice, seq, cols: 0, rows: 0 })
    return new Promise((resolve) => {
      // Killed before the marker was reached: nothing is left to show.
      const abandoned = (): void => resolve({ data: '', seq, cols: 0, rows: 0 })
      mirror.waiters.add(abandoned)
      mirror.screen.write('', () => {
        if (!mirror.waiters.delete(abandoned)) return
        const { cols, rows } = mirror.screen
        const data = mirror.serializer.serialize() + (mirror.cursorHidden ? '\x1b[?25l' : '')
        resolve({ data, seq, cols, rows })
      })
    })
  }

  /** Kill and drop the terminal for `tabId`, including any pending deferred spawn. */
  kill(tabId: string): void {
    this.clearDeferred(tabId)
    this.firstSize.delete(tabId)
    // Output still queued for a PTY being replaced under this id would land
    // on its successor with a seq from the wrong lifetime.
    this.pending.delete(tabId)
    const entry = this.terminals.get(tabId)
    if (!entry) return
    this.terminals.delete(tabId)
    if (entry.mirror) disposeMirror(entry.mirror)
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
    this.pending.clear()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}
