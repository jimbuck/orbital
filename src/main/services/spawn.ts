import { execFile } from 'node:child_process'

/**
 * A killable child process that reports its exit instead of throwing.
 *
 * Extracted from the git service when content search gained a second backend:
 * ripgrep and `git grep` are spawned identically, and the interesting parts
 * below — which stderr to read, what a timeout should say, why cancellation
 * resolves rather than rejects — are subtle enough that a second copy would
 * have drifted from this one within a release.
 */

/** Big enough for a full content-search result set from one checkout. */
const MAX_BUFFER = 64 * 1024 * 1024

export interface CaptureResult {
  stdout: string
  stderr: string
  code: number
  /** The caller killed it through {@link captureCancellable}; the other fields are empty. */
  cancelled?: boolean
}

/** A process that can still be killed, plus the handle to do it. */
export interface CancellableRun {
  result: Promise<CaptureResult>
  cancel: () => void
}

export interface CaptureOptions {
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** What to call the command in a timeout message — the argv is no use to a user. */
  label?: string
}

/**
 * Run `command` and keep a handle to kill it.
 *
 * Content search runs one of these per checkout on every keystroke, and a
 * superseded search has to stop rather than run to completion behind the one
 * the user is now waiting on — on a large repo that is the difference between
 * a responsive box and a queue of searches. A cancelled run resolves with
 * `cancelled: true` instead of rejecting, because being superseded is the
 * normal case here, not a failure.
 */
export function captureCancellable(
  command: string,
  cwd: string,
  args: string[],
  opts: CaptureOptions
): CancellableRun {
  const { timeoutMs } = opts
  let cancelled = false
  let child: ReturnType<typeof execFile> | null = null
  const result = new Promise<CaptureResult>((resolve) => {
    child = execFile(
      command,
      args,
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, timeout: timeoutMs, env: opts.env },
      (err, stdout, stderr) => {
        if (cancelled) return resolve({ stdout: '', stderr: '', code: 0, cancelled: true })
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null
        if (!e) return resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 })
        const code = typeof e.code === 'number' ? e.code : 1
        // The CALLBACK's stderr, not the error's. `promisify(execFile)` decorates
        // its rejection with stdout/stderr, but the raw callback form does not —
        // reading e.stderr here yields undefined and falls through to
        // e.message, which is Node's "Command failed: git -c core.quotePath…"
        // with the whole argv in it. That is what the user would have been
        // shown in place of the command's own one-line explanation.
        let errText = String(stderr ?? '')
        if (e.killed) {
          errText = `${opts.label ?? command} timed out after ${Math.round(timeoutMs / 1000)}s`
        }
        if (!errText && e.message) errText = e.message
        resolve({ stdout: String(stdout ?? ''), stderr: errText, code })
      }
    )
  })
  return {
    result,
    cancel: () => {
      cancelled = true
      child?.kill()
    }
  }
}
