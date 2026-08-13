/**
 * Expand the shorthands people naturally type into a path field.
 *
 * Orbital spawns agents directly (node-pty, no shell) and hands paths to the
 * OS as-is, so nothing expands a leading `~` or a `%USERPROFILE%` on the way
 * through. Left alone they reach the CLI verbatim: `~/.claude-personal` becomes
 * a RELATIVE path resolved against the worktree, so the agent quietly starts a
 * brand-new profile there instead of the one that was meant. This is the single
 * place that turns what was typed into a real path.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * `~`, `~/x`, `%VAR%\x` and `$VAR/x` → an absolute path. A path that needs no
 * expansion (and an unknown variable, which is better surfaced verbatim than
 * silently blanked) comes back unchanged; surrounding quotes from a copy-paste
 * are dropped.
 */
export function expandUserPath(raw: string): string {
  const trimmed = (raw ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!trimmed) return ''
  const expanded = trimmed
    .replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => process.env[name] ?? whole)
  if (expanded === '~') return homedir()
  if (/^~[\\/]/.test(expanded)) return join(homedir(), expanded.slice(2))
  return expanded
}
