import { execFileSync } from 'node:child_process'

/**
 * Adopt the user's login-shell PATH, on macOS and Linux.
 *
 * An app started from the Dock, Finder or a desktop launcher inherits the
 * session's bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), not the one
 * the user's shell profile builds. Everything Orbital resolves by name —
 * `git`, `gh`, the agent CLIs under Homebrew or `~/.local/bin` — would then be
 * missing, and every terminal tab would start with that same thin PATH. So ask
 * the login shell once, at boot, and take its PATH for the whole process.
 *
 * Best-effort: a slow or broken profile must not keep the app from starting,
 * so failure (or a timeout) leaves PATH as it was. Windows apps get the full
 * user PATH from the registry already, and it is skipped there.
 */
export function adoptLoginShellPath(platform = process.platform): void {
  if (platform === 'win32') return
  const shell = process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  // Markers fence the value off from anything the profile prints on its own.
  const marker = '__ORBITAL_PATH__'
  try {
    const out = execFileSync(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const path = parseMarkedPath(out, marker)
    if (path) process.env.PATH = path
  } catch {
    // Keep the inherited PATH.
  }
}

/** The value between the first pair of `marker`s in `out`, or null. */
export function parseMarkedPath(out: string, marker: string): string | null {
  const start = out.indexOf(marker)
  if (start < 0) return null
  const end = out.indexOf(marker, start + marker.length)
  if (end < 0) return null
  const value = out.slice(start + marker.length, end).trim()
  return value || null
}
