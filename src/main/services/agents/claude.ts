/**
 * Claude Code agent provider.
 *
 * Boots `claude` directly in the Worktree's checkout (not a shell the user has to
 * type into), pre-briefed with per-worktree context via --append-system-prompt-file.
 */
import type { AgentContext, AgentProvider, ResolvedCommand } from './provider'
import { resolveExecutable } from './executable'

export const claudeProvider: AgentProvider = {
  id: 'claude',
  displayName: 'Claude',
  // Used later to auto-suggest a provider per project; defined now, unused for now.
  detectFiles: ['CLAUDE.md', 'AGENTS.md'],

  async resolveCommand(ctx: AgentContext): Promise<ResolvedCommand> {
    const { file, prefixArgs } = await resolveExecutable(ctx.execPath, 'claude')
    const args = [...prefixArgs]
    if (ctx.briefingPath) {
      args.push('--append-system-prompt-file', ctx.briefingPath)
    }
    return { file, args }
  }
}
