/**
 * Cursor CLI agent provider.
 *
 * Boots `cursor-agent` (Cursor's CLI binary) directly in the Worktree's checkout.
 * The Cursor CLI has no --append-system-prompt-file equivalent, so the briefing
 * file is not passed.
 */
import type { AgentContext, AgentProvider, ResolvedCommand } from './provider'
import { resolveExecutable } from './executable'

export const cursorProvider: AgentProvider = {
  id: 'cursor',
  displayName: 'Cursor',
  // Used later to auto-suggest a provider per project; defined now, unused for now.
  detectFiles: ['.cursor', '.cursorrules', 'AGENTS.md'],

  async resolveCommand(ctx: AgentContext): Promise<ResolvedCommand> {
    const { file, prefixArgs } = await resolveExecutable(ctx.execPath, 'cursor-agent')
    return { file, args: [...prefixArgs] }
  }
}
