/**
 * Opt-in Claude Code status hooks.
 *
 * Installs hooks into the PROFILE-LEVEL settings.json (never a repo, never a
 * worktree) so the cockpit learns a worktree's status from Claude's own lifecycle
 * events at zero context cost. Because that file fires for every Claude session
 * using the profile, each hook routes through `orbital hook <event>`, whose CLI
 * guard exits 0 immediately when ORBITAL_WORKTREE_ID is absent — so non-Orbital
 * sessions are unaffected.
 *
 * WHICH profile is the load-bearing detail: a workspace can point Claude at its
 * own config directory (Settings → agents), which Orbital exports as
 * CLAUDE_CONFIG_DIR when it spawns the agent. Hooks written anywhere else are
 * read by nobody, so this targets the ACTIVE WORKSPACE's profile dir — see
 * {@link agentProfileDir}. Installing per workspace is therefore
 * expected: two workspaces on two profiles need two installs.
 *
 * All Orbital entries carry the HOOK_MARKER token, which makes merge idempotent and
 * uninstall surgical (only Orbital's entries are touched).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ClaudeHooksPlan, ClaudeHooksStatus } from '@shared/types'
import { hookShimPath } from './paths'
import { agentProfileDir } from './profiles'

/** Marker on every Orbital hook command; the basis for idempotent merge + clean uninstall. */
const HOOK_MARKER = '--orbital-managed'

/**
 * Events Orbital registers. Each maps to a status in the app (see ipc.ts
 * hookEventToStatus) — settings.json stays a fixed, dumb list of invocations.
 */
const HOOK_EVENTS = [
  'Notification',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd'
] as const

interface HookCommand {
  type: 'command'
  command: string
  async?: boolean
  timeout?: number
}
interface HookGroup {
  matcher: string
  hooks: HookCommand[]
}
type HooksMap = Record<string, HookGroup[]>
interface ClaudeSettings {
  hooks?: HooksMap
  [key: string]: unknown
}

export function settingsPath(): string {
  return join(agentProfileDir('claude'), 'settings.json')
}

/** The shell command Orbital registers for an event. Absolute shim path + marker. */
function hookCommand(event: string): string {
  return `"${hookShimPath()}" hook ${event} ${HOOK_MARKER}`
}

/** The single hook group Orbital adds for an event (async so it never blocks Claude). */
function orbitalGroup(event: string): HookGroup {
  return {
    matcher: '',
    hooks: [{ type: 'command', command: hookCommand(event), async: true, timeout: 10 }]
  }
}

/** Whether a hook group is one of Orbital's (any command carries the marker). */
function isOrbitalGroup(group: unknown): boolean {
  const g = group as HookGroup | null
  return (
    !!g &&
    Array.isArray(g.hooks) &&
    g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER))
  )
}

/**
 * Read the existing settings. A MISSING file yields {} (fresh install). A file
 * that EXISTS but does not parse THROWS — we must never overwrite a real config
 * (which is shared with Claude Code) just because a read raced a write or the
 * file was hand-corrupted.
 */
function readSettings(): ClaudeSettings {
  let raw: string
  try {
    raw = readFileSync(settingsPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err // permission / IO error — surface it, never silently overwrite
  }
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as ClaudeSettings) : {}
  } catch {
    throw new Error(
      `${settingsPath()} exists but is not valid JSON. Fix or remove it before changing ` +
        'Orbital hooks — Orbital will not overwrite it.'
    )
  }
}

/** Write atomically (temp + rename) so a crash/race can never leave a half-written file. */
function writeSettings(data: ClaudeSettings): void {
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.orbital-${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** Just the hooks object Orbital would add — shown to the user for confirmation. */
export function plan(): ClaudeHooksPlan {
  const hooks: HooksMap = {}
  for (const event of HOOK_EVENTS) hooks[event] = [orbitalGroup(event)]
  return { settingsPath: settingsPath(), json: JSON.stringify({ hooks }, null, 2) }
}

/** Merge Orbital's hooks in non-destructively and idempotently. */
export function install(): ClaudeHooksStatus {
  const settings = readSettings()
  const hooks: HooksMap = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : []
    // Drop any prior Orbital group for this event (so re-running never duplicates),
    // preserve everyone else's, then add a fresh Orbital group.
    const cleaned = groups.filter((g) => !isOrbitalGroup(g))
    cleaned.push(orbitalGroup(event))
    hooks[event] = cleaned
  }
  settings.hooks = hooks
  writeSettings(settings)
  return status()
}

/** Strip ONLY Orbital's hook entries; leave all other hooks intact. */
export function remove(): ClaudeHooksStatus {
  const settings = readSettings()
  const hooks = settings.hooks
  if (hooks && typeof hooks === 'object') {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event]
      if (!Array.isArray(groups)) continue
      const cleaned = groups.filter((g) => !isOrbitalGroup(g))
      if (cleaned.length) hooks[event] = cleaned
      else delete hooks[event]
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks
    writeSettings(settings)
  }
  return status()
}

/**
 * Source-of-truth check: are any Orbital hook groups present in settings.json?
 * Read-only, so it never throws — an unreadable/corrupt file just reports
 * not-installed (we cannot confirm our hooks are there).
 */
export function status(): ClaudeHooksStatus {
  try {
    const hooks = readSettings().hooks
    const installed =
      !!hooks &&
      typeof hooks === 'object' &&
      Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some(isOrbitalGroup))
    return { installed, settingsPath: settingsPath() }
  } catch {
    return { installed: false, settingsPath: settingsPath() }
  }
}
