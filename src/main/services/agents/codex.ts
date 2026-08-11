/**
 * OpenAI Codex CLI agent provider.
 *
 * Boots `codex` directly in the Worktree's checkout. The Codex CLI has no
 * --append-system-prompt-file equivalent, so the briefing file is not passed.
 */
import type { AgentContext, AgentProvider, ResolvedCommand } from './provider'
import { resolveExecutable } from './executable'

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',
  // Used later to auto-suggest a provider per project; defined now, unused for now.
  detectFiles: ['AGENTS.md', '.codex'],
  // No --append-system-prompt-file equivalent: Codex reads its instructions from
  // AGENTS.md, so Orbital's go in the profile's global one (codex-instructions.ts).
  acceptsBriefingFile: false,

  async resolveCommand(ctx: AgentContext): Promise<ResolvedCommand> {
    const { file, prefixArgs } = await resolveExecutable(ctx.execPath, 'codex')
    return { file, args: [...prefixArgs] }
  }
}
