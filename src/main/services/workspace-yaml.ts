import { dirname, basename } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'yaml'
import {
  WORKSPACE_CONFIG_VERSION,
  normalizeAgentConfigs,
  type WorkspaceConfig,
  type WorkspaceProjectConfig
} from '@shared/types'

/**
 * The Export/Import Workspace YAML format. Workspaces live in the global DB —
 * this module only serializes one to a shareable file and parses/heals one
 * coming back in (possibly hand-edited, possibly from another machine).
 */

const HEADER = `# Orbital workspace export.
# Share this file to hand someone a workspace: Import Workspace in Orbital
# recreates it (projects + workspace settings). Paths are absolute, so the
# importing machine needs the repos at the same locations (or edit them here).
`

/** Human name for a workspace derived from a file path ("team.yaml" → "team"). */
export function workspaceNameFromFile(file: string): string {
  return basename(file).replace(/\.(ya?ml)$/i, '') || 'Workspace'
}

/**
 * Coerce a parsed (possibly hand-authored or partial) document into a valid
 * {@link WorkspaceConfig}: fill a missing id/name/version, drop project entries
 * with no path, and generate ids for entries that lack one or collide.
 */
export function normalize(raw: unknown): WorkspaceConfig {
  const r = (raw ?? {}) as Record<string, unknown>

  const id = typeof r.id === 'string' && r.id ? r.id : randomUUID()
  const name = typeof r.name === 'string' && r.name ? r.name : 'Workspace'

  const rawProjects = Array.isArray(r.projects) ? r.projects : []
  const seen = new Set<string>()
  const projects: WorkspaceProjectConfig[] = []
  for (const item of rawProjects) {
    const p = (item ?? {}) as Record<string, unknown>
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (!path) continue // an entry without a repo path is meaningless
    let pid = typeof p.id === 'string' && p.id ? p.id : ''
    if (!pid || seen.has(pid)) pid = randomUUID()
    seen.add(pid)
    const entry: WorkspaceProjectConfig = {
      id: pid,
      name: typeof p.name === 'string' && p.name ? p.name : (path.split(/[\\/]/).filter(Boolean).pop() ?? path),
      path
    }
    // `agentProvider` is what exports written before agent profiles were named
    // called this field; its provider-id value still resolves to a profile.
    const agentId = typeof p.agentId === 'string' && p.agentId ? p.agentId : p.agentProvider
    if (typeof agentId === 'string' && agentId) entry.agentId = agentId
    if (typeof p.agentExecPath === 'string' && p.agentExecPath) entry.agentExecPath = p.agentExecPath
    projects.push(entry)
  }

  // Workspace-scoped settings: keep only recognizably-typed fields.
  let settings: WorkspaceConfig['settings']
  if (r.settings && typeof r.settings === 'object') {
    const s = r.settings as Record<string, unknown>
    settings = {}
    if (Array.isArray(s.envSyncPatterns) && s.envSyncPatterns.every((x) => typeof x === 'string')) {
      settings.envSyncPatterns = s.envSyncPatterns
    }
    if (typeof s.periodicFetch === 'boolean') settings.periodicFetch = s.periodicFetch
    // Modern `agents` entries, or a legacy `enabledAgents` id array from an
    // export written before agents were configurable.
    const agents = normalizeAgentConfigs(s.agents, s.enabledAgents)
    if (agents) settings.agents = agents
    if (Object.keys(settings).length === 0) settings = undefined
  }

  return { version: WORKSPACE_CONFIG_VERSION, id, name, settings, projects }
}

/**
 * Parse a workspace export file. Throws with a readable message when the file
 * is missing or not valid YAML — the importer surfaces it in the picker.
 */
export function readWorkspaceYaml(file: string): WorkspaceConfig {
  if (!existsSync(file)) throw new Error(`workspace file not found: ${file}`)
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`not a valid workspace file: ${err instanceof Error ? err.message : String(err)}`)
  }
  return normalize(raw)
}

/** Serialize and atomically write a workspace export to `file`. */
export function writeWorkspaceYaml(file: string, config: WorkspaceConfig): void {
  mkdirSync(dirname(file), { recursive: true })
  // yaml's stringify drops undefined-valued keys (an absent settings slice).
  const text = HEADER + stringify(config)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file) // atomic replace so a crash mid-write can't truncate it
}
