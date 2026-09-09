/**
 * Claude Code agent provider.
 *
 * Boots `claude` directly in the Worktree's checkout (not a shell the user has to
 * type into), pre-briefed with per-worktree context via --append-system-prompt-file.
 * Every launch is pinned to a session id Orbital chose (`--session-id`) so the
 * tab can pick the same conversation back up with `--resume` after a restart.
 */
import { join } from 'node:path'
import type { AgentContext, AgentProvider, ResolvedCommand } from './provider'
import { resolveExecutable } from './executable'

/**
 * The folder name Claude Code files a working directory's transcripts under
 * (`<profile>/projects/<this>/<session>.jsonl`): every character that is not a
 * letter or digit becomes a dash, so `C:\Projects\orbital` is `C--Projects-orbital`.
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Absolute path of the transcript Claude keeps for a session, whether or not it exists. */
export function claudeTranscriptPath(profileDir: string, cwd: string, sessionId: string): string {
  return join(profileDir, 'projects', claudeProjectDirName(cwd), `${sessionId}.jsonl`)
}

export const claudeProvider: AgentProvider = {
  id: 'claude',
  displayName: 'Claude',
  // Used later to auto-suggest a provider per project; defined now, unused for now.
  detectFiles: ['CLAUDE.md', 'AGENTS.md'],
  acceptsBriefingFile: true,
  tracksSessions: true,
  sessionTranscriptPath: claudeTranscriptPath,

  async resolveCommand(ctx: AgentContext): Promise<ResolvedCommand> {
    const { file, prefixArgs } = await resolveExecutable(ctx.execPath, 'claude')
    const args = [...prefixArgs]
    if (ctx.session) {
      // A resumed session keeps its id; a fresh one is started under the id
      // Orbital minted, so the tab knows what to resume even without hooks.
      args.push(ctx.session.resume ? '--resume' : '--session-id', ctx.session.id)
    }
    if (ctx.briefingPath) {
      args.push('--append-system-prompt-file', ctx.briefingPath)
    }
    return { file, args }
  }
}
