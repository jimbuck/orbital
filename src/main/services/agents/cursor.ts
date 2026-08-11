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
  // cursor-agent has no launch-time instructions flag and no profile-level rules
  // file; the only channel is `.cursor/rules` INSIDE the repo, which Orbital will
  // not write (zero git footprint). Cursor sessions learn the CLI from `orbital help`.
  acceptsBriefingFile: false,

  async resolveCommand(ctx: AgentContext): Promise<ResolvedCommand> {
    const { file, prefixArgs } = await resolveExecutable(ctx.execPath, 'cursor-agent')
    return { file, args: [...prefixArgs] }
  }
}
