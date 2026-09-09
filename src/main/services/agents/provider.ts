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
 * The conversation an agent launch is pinned to: either one the tab already ran
 * (resume) or a new one under an id chosen before launch — see
 * TabConfig.agentSessionId and {@link SessionSupport}.
 */
export interface AgentSession {
  /** The provider's session id (a UUID for every supported CLI). */
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
  /** Session to run under; only given to providers with {@link SessionSupport}. */
  session?: AgentSession
}

export interface ResolvedCommand {
  /** Executable handed to node-pty. */
  file: string
  /** argv passed after the executable. */
  args: string[]
}

/** What a session lookup needs to know about the launch. */
export interface SessionLookup {
  /** The config/profile directory the CLI reads — where it keeps its sessions. */
  profileDir: string
  /** The worktree the session runs in (sessions are filed per directory). */
  cwd: string
  /** Explicit executable path, for providers that must shell out to mint an id. */
  execPath?: string
}

/**
 * How a provider's conversations are picked back up after a respawn. A CLI
 * either lets Orbital choose the id before launch ({@link mint}) or reveals it
 * only once the session is running ({@link discover}); every provider must be
 * able to say whether a stored id still exists ({@link find}), because the
 * CLIs exit with an error for an unknown id and that would leave a dead tab
 * where a fresh session belongs.
 */
export interface SessionSupport {
  /**
   * Choose the id a NEW session will run under, before launch — or null when
   * the CLI only assigns ids itself, in which case {@link discover} is polled
   * after launch instead.
   */
  mint(lookup: SessionLookup): Promise<string | null>
  /** Path of the stored session `id`, or null when the CLI no longer has it. */
  find(lookup: SessionLookup, id: string): Promise<string | null>
  /**
   * The id of a session the CLI started in `lookup.cwd` at or after `since`
   * (ms epoch) that no other tab owns (`taken`), or null if none has appeared
   * yet. Only needed when {@link mint} returns null.
   */
  discover?(lookup: SessionLookup, since: number, taken: ReadonlySet<string>): Promise<string | null>
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
  /** Session resume support; absent when the CLI cannot resume by id. */
  sessions?: SessionSupport
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
