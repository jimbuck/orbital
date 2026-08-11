/**
 * Where an agent CLI keeps its configuration — the one place that answers
 * "which directory does this agent actually read?".
 *
 * A workspace can point an agent at its own profile directory (Settings →
 * agents), which Orbital exports as that provider's config-dir env var when it
 * spawns the agent (CLAUDE_CONFIG_DIR, CODEX_HOME, …; see ipc.ts). Anything
 * Orbital installs FOR those agents to read — status hooks, the `orbital` skill,
 * Codex's instructions — has to land in the SAME directory, or the agent will
 * never see it. That is the difference between {@link agentProfileDir} (what the
 * active workspace launches with) and the machine default it falls back to.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SUPPORTED_AGENTS } from '@shared/types'
import { hasActiveWorkspace } from '../../db/repositories'
import { getSettings } from '../settings'

/** The machine default for a provider: its config-dir env var, else `~/<default>`. */
export function defaultProfileDir(providerId: string): string {
  const meta = SUPPORTED_AGENTS.find((a) => a.id === providerId)
  if (!meta) return homedir()
  const fromEnv = process.env[meta.configDirEnvVar]?.trim()
  if (fromEnv) return fromEnv
  // SUPPORTED_AGENTS spells these `~/.claude` for display; expand for real use.
  return join(homedir(), meta.defaultConfigDir.replace(/^~[\\/]/, ''))
}

/**
 * The profile directory the ACTIVE workspace launches this provider with: its
 * configured `configDir` when it sets one, else the machine default.
 */
export function agentProfileDir(providerId: string): string {
  // No active workspace yet (before boot resolution) is the ONE case with a sane
  // fallback. A settings read that fails for any other reason must NOT be
  // swallowed: quietly answering with the machine default would send an install
  // to a profile the agent never reads — the exact bug this module exists to fix.
  if (!hasActiveWorkspace()) return defaultProfileDir(providerId)
  const configured = getSettings().agents.find((a) => a.provider === providerId)?.configDir?.trim()
  return configured || defaultProfileDir(providerId)
}
