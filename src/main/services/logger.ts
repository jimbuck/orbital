/**
 * Orbital — opt-in debug logger.
 *
 * A standalone, dependency-free file logger for diagnosing crashes during long
 * runs. It records three sources — CLI control calls, UI actions (IPC invokes),
 * and errors/warnings (including uncaught crashes) — to a size-rotated file.
 *
 * Two hard rules drive the design:
 *   1. It must NEVER throw into app code. Every filesystem touch is wrapped so a
 *      logging failure (locked file, full disk) can never take down the process
 *      it exists to observe.
 *   2. It must be a cheap no-op when disabled (the default). `log()` returns
 *      before doing any work — even the meta formatting — when logging is off,
 *      so leaving the calls in hot paths (every IPC invoke) costs almost nothing.
 *
 * Intentionally imports nothing from the repo/runtime: this module is pulled in
 * at the very start of app startup, so keeping it self-contained avoids import
 * cycles with the services that themselves want to log.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Roll the active file once it would pass 5 MB, keeping the log bounded. */
const MAX_BYTES = 5 * 1024 * 1024
/** How many rotated generations to retain (`.1` … `.5`) before dropping the oldest. */
const MAX_FILES = 5
/** Above this length a single arg/string is truncated so payloads don't bloat the log. */
const MAX_STR = 200

type Category = 'cli' | 'ui' | 'error'

class Logger {
  private enabled = false
  private logDir = ''
  private logFile = ''
  /** Running size of the active file, seeded on init so rotation works across restarts. */
  private bytes = 0

  /** Absolute directory the log file lives in (for the "open log folder" action). */
  get dir(): string {
    return this.logDir
  }

  /**
   * Point the logger at a directory (created if missing) and remember the active
   * file path. Safe to call once at startup; failures are swallowed so a bad log
   * path never blocks the app from booting.
   */
  init(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true })
      this.logDir = dir
      this.logFile = join(dir, 'orbital-debug.log')
      // Seed the byte counter from the existing file so a restart continues to
      // rotate correctly instead of appending forever to a stale large file.
      try {
        this.bytes = statSync(this.logFile).size
      } catch {
        this.bytes = 0
      }
    } catch {
      // No usable log dir — stay disabled; every log() below is already guarded.
    }
  }

  /** Flip the enabled flag live (from the setting). Appends only; nothing to close. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** Whether logging is on — lets hot-path callers skip building log payloads. */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Core write. Returns immediately when disabled (the common case), so this is
   * a near-free no-op left in hot paths. All fs work is wrapped — a logging
   * failure is silently dropped rather than propagated into app code.
   */
  log(category: Category, message: string, meta?: unknown): void {
    if (!this.enabled || !this.logFile) return
    try {
      const level = category === 'error' ? 'ERROR' : category.toUpperCase()
      const metaStr = meta === undefined ? '' : ` ${safeJson(meta)}`
      const line = `${new Date().toISOString()} [${level}] ${message}${metaStr}\n`
      const size = Buffer.byteLength(line)
      // Rotate BEFORE appending when this line would push the file past the cap,
      // so the active file never meaningfully exceeds MAX_BYTES.
      if (this.bytes + size > MAX_BYTES) this.rotate()
      appendFileSync(this.logFile, line)
      this.bytes += size
    } catch {
      // Never let logging break the caller.
    }
  }

  /** Shift orbital-debug.log → .1 → … → .MAX_FILES, dropping the oldest generation. */
  private rotate(): void {
    try {
      // Drop the oldest so the rename chain has somewhere to shift into.
      try {
        unlinkSync(`${this.logFile}.${MAX_FILES}`)
      } catch {
        // Oldest may not exist yet — fine.
      }
      for (let i = MAX_FILES - 1; i >= 1; i--) {
        try {
          renameSync(`${this.logFile}.${i}`, `${this.logFile}.${i + 1}`)
        } catch {
          // Gap in the chain — nothing to move at this generation.
        }
      }
      try {
        renameSync(this.logFile, `${this.logFile}.1`)
      } catch {
        // Active file missing (nothing logged yet) — nothing to rotate.
      }
      this.bytes = 0
    } catch {
      // Rotation failure must not stop logging; worst case the file grows.
    }
  }

  /* ---- thin category wrappers -------------------------------------------- */

  cli(message: string, meta?: unknown): void {
    this.log('cli', message, meta)
  }
  ui(message: string, meta?: unknown): void {
    this.log('ui', message, meta)
  }
  info(message: string, meta?: unknown): void {
    this.log('cli', message, meta)
  }
  warn(message: string, meta?: unknown): void {
    this.log('error', `WARN ${message}`, meta)
  }
  error(message: string, meta?: unknown): void {
    this.log('error', message, meta)
  }
}

/** JSON.stringify that never throws (circular refs / BigInt) — logging must be safe. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Shallow-copy IPC args for logging, truncating long strings (writeFile content,
 * base64 image data) to a marker so a single invoke can't dump megabytes.
 */
export function summarizeArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (typeof a === 'string' && a.length > MAX_STR) return `<...${a.length} chars>`
    return a
  })
}

/** Process-wide singleton — one log file for the whole app. */
export const logger = new Logger()
