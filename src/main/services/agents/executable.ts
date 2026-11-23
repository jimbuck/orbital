/**
 * Resolve an agent executable to something node-pty (ConPTY on Windows) can spawn.
 *
 * On Windows the agent's entry point is often a `.cmd` / `.bat` / `.ps1` shim from
 * an npm global install, which ConPTY cannot exec by bare name — so those are run
 * through the shell. A real `.exe` (or any unix binary) is spawned directly.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { expandUserPath } from './user-path'

export interface ExeResolution {
  /** Executable to hand node-pty. */
  file: string
  /** argv that must come BEFORE the provider's own arguments (e.g. cmd.exe /c <shim>). */
  prefixArgs: string[]
}

/** `where` (Windows) / `which` (unix) lookup; resolves ALL hits in OS order. */
function lookupOnPath(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    execFile(finder, [name], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([])
      resolve(
        stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      )
    })
  })
}

/**
 * Pick the best match for the current platform. On Windows a single `npm i -g`
 * lays down THREE siblings — an extensionless POSIX shim, a `.cmd`, and a `.ps1` —
 * and `where` lists the extensionless shim FIRST. ConPTY cannot exec that bare
 * shell script, so prefer a runnable extension (.exe/.cmd/.bat/.ps1) over it.
 */
function pickBest(matches: string[]): string {
  if (process.platform !== 'win32') return matches[0]
  const pref = ['.exe', '.com', '.cmd', '.bat', '.ps1']
  const rank = (p: string): number => {
    const i = pref.indexOf(extname(p).toLowerCase())
    return i === -1 ? pref.length : i // extensionless / unknown ranks worst
  }
  return [...matches].sort((a, b) => rank(a) - rank(b))[0]
}

/**
 * Resolve `name` (honoring an explicit `override` path first) into a spawnable
 * command. Throws an Error with actionable text when nothing is found.
 */
export async function resolveExecutable(override: string | undefined, name: string): Promise<ExeResolution> {
  // Same expansion as the profile directory: a `~/bin/claude` typed here would
  // otherwise be looked for relative to the worktree.
  let exe = expandUserPath(override ?? '')
  if (exe) {
    if (!existsSync(exe)) {
      throw new Error(`Configured ${name} path not found: ${exe}`)
    }
  } else {
    const matches = await lookupOnPath(name)
    if (matches.length === 0) {
      throw new Error(
        `'${name}' was not found on your PATH. Install it, or set an explicit path in Settings → Agent.`
      )
    }
    exe = pickBest(matches)
  }

  const ext = extname(exe).toLowerCase()
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return { file: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/c', exe] }
  }
  if (process.platform === 'win32' && ext === '.ps1') {
    return { file: 'powershell.exe', prefixArgs: ['-ExecutionPolicy', 'Bypass', '-File', exe] }
  }
  return { file: exe, prefixArgs: [] }
}

/**
 * A free-text argument (a starting prompt) made safe to pass through a shell
 * shim. When `prefixArgs` is non-empty the CLI runs via `cmd.exe /c` or
 * PowerShell, which re-parse the command line: a newline ends the command and
 * a double quote can end the quoted argument early, letting `&` or `|` in the
 * text run as shell syntax. So newlines become spaces and double quotes become
 * single quotes there. node-pty only wraps an argument in quotes when it holds
 * whitespace, and an unquoted `lint&&test` would reach cmd.exe as two
 * commands, so text with no whitespace gets a trailing space to make sure it
 * is quoted. A directly spawned executable gets the text unchanged.
 */
export function shimSafeArg(text: string, prefixArgs: string[]): string {
  if (prefixArgs.length === 0) return text
  const flat = text.replace(/\r?\n/g, ' ').replace(/"/g, "'")
  return /\s/.test(flat) ? flat : `${flat} `
}
