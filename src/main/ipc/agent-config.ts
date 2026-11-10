import { IPC } from '@shared/contract'
import { inspectProfileDir, resolveAgent } from '../services/agents/profiles'
import * as claudeHooks from '../services/agents/claude-hooks'
import * as claudeSkill from '../services/agents/claude-skill'
import * as codexInstructions from '../services/agents/codex-instructions'
import { handle } from './handle'

/** Per-agent-profile integrations the Settings modal installs and inspects. */
export function register(): void {
  const h = handle
  h(IPC.inspectProfileDir, (_e, provider, configDir) => inspectProfileDir(provider, configDir))

  // ---- Claude status hooks (opt-in, per agent profile's settings.json) ----
  // Every channel below names the agent profile it acts on: the files live in
  // that profile's directory, so two Claude profiles are two independent installs.
  h(IPC.claudeHooksStatus, (_e, agentId) => claudeHooks.status(resolveAgent(agentId)))
  h(IPC.claudeHooksPlan, (_e, agentId) => claudeHooks.plan(resolveAgent(agentId)))
  h(IPC.installClaudeHooks, (_e, agentId) => claudeHooks.install(resolveAgent(agentId)))
  h(IPC.removeClaudeHooks, (_e, agentId) => claudeHooks.remove(resolveAgent(agentId)))

  // ---- the `orbital` Agent Skill (opt-in, per Claude profile) ----
  h(IPC.claudeSkillStatus, (_e, agentId) => claudeSkill.status(resolveAgent(agentId)))
  h(IPC.claudeSkillPlan, (_e, agentId) => claudeSkill.plan(resolveAgent(agentId)))
  h(IPC.installClaudeSkill, (_e, agentId) => claudeSkill.install(resolveAgent(agentId)))
  h(IPC.removeClaudeSkill, (_e, agentId) => claudeSkill.remove(resolveAgent(agentId)))

  // ---- Codex instructions (opt-in, a managed block in the profile's AGENTS.md) ----
  h(IPC.codexInstructionsStatus, (_e, agentId) => codexInstructions.status(resolveAgent(agentId)))
  h(IPC.codexInstructionsPlan, (_e, agentId) => codexInstructions.plan(resolveAgent(agentId)))
  h(IPC.installCodexInstructions, (_e, agentId) => codexInstructions.install(resolveAgent(agentId)))
  h(IPC.removeCodexInstructions, (_e, agentId) => codexInstructions.remove(resolveAgent(agentId)))
}
