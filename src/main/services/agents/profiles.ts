/**
 * Where an agent CLI keeps its configuration — the one place that answers
 * "which directory does this agent profile actually read?".
 *
 * A workspace configures agents as named PROFILES (Settings → agents), each of
 * which can point at its own directory, which Orbital exports as that
 * provider's config-dir env var when it spawns the agent (CLAUDE_CONFIG_DIR,
 * CODEX_HOME, …; see ipc.ts). Anything Orbital installs FOR an agent to read —
 * status hooks, the `orbital` skill, Codex's instructions — has to land in the
 * SAME directory, or the agent will never see it. That is the difference
 * between {@link agentProfileDir} (what a given profile launches with) and the
 * machine default it falls back to.
 */
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { SUPPORTED_AGENTS, findAgentConfig, type AgentConfig } from '@shared/types'
import { getSettings } from '../settings'
import { expandUserPath } from './user-path'

/** The machine default for a provider: its config-dir env var, else `~/<default>`. */
export function defaultProfileDir(providerId: string): string {
  const meta = SUPPORTED_AGENTS.find((a) => a.id === providerId)
  if (!meta) return homedir()
  const fromEnv = expandUserPath(process.env[meta.configDirEnvVar] ?? '')
  if (fromEnv) return fromEnv
  // SUPPORTED_AGENTS spells these `~/.claude` for display; expand for real use.
  return expandUserPath(meta.defaultConfigDir)
}

/**
 * The profile directory a configured agent launches with: its own `configDir`
 * when it sets one, else the machine default for its provider. Always the
 * EXPANDED path — what gets exported as the CLI's config-dir variable and what
 * the hook/skill installers write into have to be the same real directory.
 */
export function agentProfileDir(agent: AgentConfig): string {
  return expandUserPath(agent.configDir ?? '') || defaultProfileDir(agent.provider)
}

/**
 * What a typed profile-directory value actually resolves to, for Settings to
 * show before anything launches: the expanded path, and whether a directory is
 * there today. A missing one is not an error — the agent will create it and
 * start a fresh profile — but that is precisely the surprise worth warning
 * about, since it looks identical to "my profile was ignored".
 */
export function inspectProfileDir(providerId: string, configDir: string): { path: string; exists: boolean } {
  const path = expandUserPath(configDir) || defaultProfileDir(providerId)
  let exists = false
  try {
    exists = existsSync(path) && statSync(path).isDirectory()
  } catch {
    exists = false // unreadable (permissions, bad path) — report it as not there
  }
  return { path, exists }
}

/**
 * The configured profile a reference names (see {@link findAgentConfig} for
 * what counts as a reference). Throws when it names nothing: an install has to
 * know which directory it is writing to, and quietly falling back to some other
 * profile would send it to a directory that agent never reads — the exact bug
 * this module exists to prevent.
 */
export function resolveAgent(ref: string | undefined): AgentConfig {
  const agent = findAgentConfig(getSettings().agents, ref)
  if (!agent) throw new Error(`no agent profile '${ref ?? ''}' is configured in this workspace`)
  return agent
}
