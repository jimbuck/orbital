/**
 * Agent-provider seam.
 *
 * An `agent` tab is a PTY-backed tab that boots straight into a coding agent.
 * Each provider knows how to resolve the executable + argv to spawn for a given
 * Worktree. Claude and Codex are implemented; the registry is the extension point
 * for Gemini / etc. (add a provider + register it here — no other plumbing).
 */
import type { Project, Worktree } from '@shared/types'

/**
 * The conversation an agent launch is pinned to. Orbital mints the id for a
 * fresh session (so it knows the id without waiting for a hook) and asks for a
 * resume when the tab already ran one — see TabConfig.agentSessionId.
 */
export interface AgentSession {
  /** The provider's session id (a UUID for Claude). */
  id: string
  /** True to continue the stored conversation; false to start a new one under `id`. */
  resume: boolean
}

export interface AgentContext {
  project: Project
  worktree: Worktree
  /** Absolute path to the briefing file Orbital generated for this launch, or null. */
  briefingPath: string | null
  /** Explicit executable path configured on the project, if any. */
  execPath?: string
  /** Session to run under; only given to providers with `tracksSessions`. */
  session?: AgentSession
}

export interface ResolvedCommand {
  /** Executable handed to node-pty. */
  file: string
  /** argv passed after the executable. */
  args: string[]
}

export interface AgentProvider {
  /** Stable id stored on the tab + project (e.g. 'claude'). */
  id: string
  displayName: string
  /** Files that hint a project uses this provider (future auto-detection; unused for now). */
  detectFiles: string[]
  /**
   * Whether this CLI can be handed a per-launch briefing file. Only Claude takes
   * one (`--append-system-prompt-file`); for the others Orbital would be writing
   * a file nobody reads, so it doesn't generate one — they learn about the
   * cockpit from profile-level instructions instead (see claude-skill.ts /
   * codex-instructions.ts).
   */
  acceptsBriefingFile: boolean
  /**
   * Whether the CLI can be launched under a session id Orbital chooses and
   * later resumed by that id. When true, every launch gets an {@link AgentSession}
   * and {@link sessionTranscriptPath} says where the provider persists it.
   */
  tracksSessions: boolean
  /**
   * Where the provider stores the transcript of `sessionId` for a session run
   * in `cwd` with the profile at `profileDir`. Orbital only asks to resume a
   * session whose transcript is still there — the CLI exits with an error for
   * an unknown id, which would leave a dead tab where a fresh session belongs.
   */
  sessionTranscriptPath?(profileDir: string, cwd: string, sessionId: string): string
  /** Resolve the executable + argv to spawn; throws a clear Error if unresolvable. */
  resolveCommand(ctx: AgentContext): Promise<ResolvedCommand>
}

import { claudeProvider } from './claude'
import { codexProvider } from './codex'
import { cursorProvider } from './cursor'

/** Providers keyed by id. The single place to register a new agent. */
export const AGENT_PROVIDERS: Record<string, AgentProvider> = {
  [claudeProvider.id]: claudeProvider,
  [codexProvider.id]: codexProvider,
  [cursorProvider.id]: cursorProvider
}

/** Resolve a provider by id, falling back to Claude (the default). */
export function getProvider(id: string | undefined): AgentProvider {
  return (id ? AGENT_PROVIDERS[id] : undefined) ?? claudeProvider
}
