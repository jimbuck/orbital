import { IPC } from '@shared/types'
import { inspectProfileDir, resolveAgent } from '../services/agents/profiles'
import * as claudeHooks from '../services/agents/claude-hooks'
import * as claudeSkill from '../services/agents/claude-skill'
import * as codexInstructions from '../services/agents/codex-instructions'
import { handle } from './handle'

/** Per-agent-profile integrations the Settings modal installs and inspects. */
export function register(): void {
  const h = handle
  h(IPC.inspectProfileDir, (_e, provider: string, configDir: string) => inspectProfileDir(provider, configDir))

  // ---- Claude status hooks (opt-in, per agent profile's settings.json) ----
  // Every channel below names the agent profile it acts on: the files live in
  // that profile's directory, so two Claude profiles are two independent installs.
  h(IPC.claudeHooksStatus, (_e, agentId: string) => claudeHooks.status(resolveAgent(agentId)))
  h(IPC.claudeHooksPlan, (_e, agentId: string) => claudeHooks.plan(resolveAgent(agentId)))
  h(IPC.installClaudeHooks, (_e, agentId: string) => claudeHooks.install(resolveAgent(agentId)))
  h(IPC.removeClaudeHooks, (_e, agentId: string) => claudeHooks.remove(resolveAgent(agentId)))

  // ---- the `orbital` Agent Skill (opt-in, per Claude profile) ----
  h(IPC.claudeSkillStatus, (_e, agentId: string) => claudeSkill.status(resolveAgent(agentId)))
  h(IPC.claudeSkillPlan, (_e, agentId: string) => claudeSkill.plan(resolveAgent(agentId)))
  h(IPC.installClaudeSkill, (_e, agentId: string) => claudeSkill.install(resolveAgent(agentId)))
  h(IPC.removeClaudeSkill, (_e, agentId: string) => claudeSkill.remove(resolveAgent(agentId)))

  // ---- Codex instructions (opt-in, a managed block in the profile's AGENTS.md) ----
  h(IPC.codexInstructionsStatus, (_e, agentId: string) => codexInstructions.status(resolveAgent(agentId)))
  h(IPC.codexInstructionsPlan, (_e, agentId: string) => codexInstructions.plan(resolveAgent(agentId)))
  h(IPC.installCodexInstructions, (_e, agentId: string) => codexInstructions.install(resolveAgent(agentId)))
  h(IPC.removeCodexInstructions, (_e, agentId: string) => codexInstructions.remove(resolveAgent(agentId)))
}
