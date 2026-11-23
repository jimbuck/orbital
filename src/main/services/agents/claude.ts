/**
 * Claude Code agent provider.
 *
 * Boots `claude` directly in the Worktree's checkout (not a shell the user has to
 * type into), pre-briefed with per-worktree context via --append-system-prompt-file.
 * Every launch is pinned to a session id Orbital chose (`--session-id`) so the
 * tab can pick the same conversation back up with `--resume` after a restart.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentContext, AgentProvider, ResolvedCommand, SessionLookup } from './provider'
import { resolveExecutable, shimSafeArg } from './executable'

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
  // Used later to auto-suggest a provider per repo; defined now, unused for now.
  detectFiles: ['CLAUDE.md', 'AGENTS.md'],
  acceptsBriefingFile: true,
  acceptsPrompt: true,

  sessions: {
    // `--session-id` takes any UUID, so the id is known before Claude even starts.
    async mint(): Promise<string> {
      return randomUUID()
    },
    async find({ profileDir, cwd }: SessionLookup, id: string): Promise<string | null> {
      const path = claudeTranscriptPath(profileDir, cwd, id)
      return existsSync(path) ? path : null
    }
  },

  async resolveCommand(ctx: AgentContext): Promise<ResolvedCommand> {
    const { file, prefixArgs } = await resolveExecutable(ctx.execPath, 'claude')
    const args = [...prefixArgs]
    const addDirs = ctx.addDirs ?? []
    // One flag per directory, ahead of everything else: `--add-dir` takes
    // several values, so it must be followed by another flag, never by a
    // positional it could swallow. Claude also loads skills, commands and
    // agents from each; the env below loads their CLAUDE.md too.
    for (const dir of addDirs) args.push('--add-dir', dir)
    if (ctx.session) {
      // A resumed session keeps its id; a fresh one is started under the id
      // Orbital minted, so the tab knows what to resume even without hooks.
      args.push(ctx.session.resume ? '--resume' : '--session-id', ctx.session.id)
    }
    if (ctx.briefingPath) {
      args.push('--append-system-prompt-file', ctx.briefingPath)
    }
    const cmd: ResolvedCommand = { file, args }
    if (addDirs.length) cmd.env = { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' }
    // A positional prompt starts the interactive session with it.
    if (ctx.prompt) cmd.tail = ['--', shimSafeArg(ctx.prompt, prefixArgs)]
    return cmd
  }
}
