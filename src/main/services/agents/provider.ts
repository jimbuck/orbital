/**
 * Agent-provider seam.
 *
 * An `agent` tab is a PTY-backed tab that boots straight into a coding agent.
 * Each provider knows how to resolve the executable + argv to spawn for a given
 * Flight. Only Claude is implemented; the registry is the extension point for
 * Codex / Gemini / etc. (add a provider + register it here — no other plumbing).
 */
import type { Workspace, Flight } from '@shared/types'

export interface AgentContext {
  workspace: Workspace
  flight: Flight
  /** Absolute path to the briefing file Orbital generated for this launch, or null. */
  briefingPath: string | null
  /** Explicit executable path configured on the workspace, if any. */
  execPath?: string
}

export interface ResolvedCommand {
  /** Executable handed to node-pty. */
  file: string
  /** argv passed after the executable. */
  args: string[]
}

export interface AgentProvider {
  /** Stable id stored on the tab + workspace (e.g. 'claude'). */
  id: string
  displayName: string
  /** Files that hint a project uses this provider (future auto-detection; unused for now). */
  detectFiles: string[]
  /** Resolve the executable + argv to spawn; throws a clear Error if unresolvable. */
  resolveCommand(ctx: AgentContext): Promise<ResolvedCommand>
}

import { claudeProvider } from './claude'

/** Providers keyed by id. The single place to register a new agent. */
export const AGENT_PROVIDERS: Record<string, AgentProvider> = {
  [claudeProvider.id]: claudeProvider
}

/** Resolve a provider by id, falling back to Claude (the default). */
export function getProvider(id: string | undefined): AgentProvider {
  return (id ? AGENT_PROVIDERS[id] : undefined) ?? claudeProvider
}
