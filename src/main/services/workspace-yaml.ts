import { dirname, basename } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'yaml'
import {
  WORKSPACE_CONFIG_VERSION,
  type WorkspaceConfig,
  type WorkspaceProjectConfig,
  type WorkspaceRepoConfig
} from '@shared/types'
import { parseSettings } from '@shared/settings'

/**
 * The Export/Import Workspace YAML format. Workspaces live in the global DB —
 * this module only serializes one to a shareable file and parses/heals one
 * coming back in (possibly hand-edited, possibly from another machine).
 */

const HEADER = `# Orbital workspace export.
# Share this file to hand someone a workspace: Import Workspace in Orbital
# recreates it (repos, how they are grouped into projects, and workspace
# settings). Paths are absolute, so the importing machine needs the repos at
# the same locations (or edit them here).
`

/** Human name for a workspace derived from a file path ("team.yaml" → "team"). */
export function workspaceNameFromFile(file: string): string {
  return basename(file).replace(/\.(ya?ml)$/i, '') || 'Workspace'
}

/**
 * Coerce a parsed (possibly hand-authored or partial) document into a valid
 * {@link WorkspaceConfig}: fill a missing id/name/version, drop repo entries
 * with no path, and generate ids for entries that lack one or collide.
 */
export function normalize(raw: unknown): WorkspaceConfig {
  const r = (raw ?? {}) as Record<string, unknown>

  const id = typeof r.id === 'string' && r.id ? r.id : randomUUID()
  const name = typeof r.name === 'string' && r.name ? r.name : 'Workspace'

  // Files exported before the Project→Repo rename list their repos under
  // `projects`. Since then `repos` is always written, so `projects` without
  // it is that old list, and `projects` beside it is the grouping.
  const legacy = !Array.isArray(r.repos) && Array.isArray(r.projects)
  const rawRepos = Array.isArray(r.repos) ? r.repos : legacy ? (r.projects as unknown[]) : []
  const seen = new Set<string>()
  const repos: WorkspaceRepoConfig[] = []
  for (const item of rawRepos) {
    const p = (item ?? {}) as Record<string, unknown>
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (!path) continue // an entry without a repo path is meaningless
    let pid = typeof p.id === 'string' && p.id ? p.id : ''
    if (!pid || seen.has(pid)) pid = randomUUID()
    seen.add(pid)
    const entry: WorkspaceRepoConfig = {
      id: pid,
      name: typeof p.name === 'string' && p.name ? p.name : (path.split(/[\\/]/).filter(Boolean).pop() ?? path),
      path
    }
    // `agentProvider` is what exports written before agent profiles were named
    // called this field; its provider-id value still resolves to a profile.
    const agentId = typeof p.agentId === 'string' && p.agentId ? p.agentId : p.agentProvider
    if (typeof agentId === 'string' && agentId) entry.agentId = agentId
    if (typeof p.agentExecPath === 'string' && p.agentExecPath) entry.agentExecPath = p.agentExecPath
    repos.push(entry)
  }

  // Workspace-scoped settings: keep only recognizably-typed fields.
  const settings: WorkspaceConfig['settings'] = parseSettings(r.settings)

  const config: WorkspaceConfig = { version: WORKSPACE_CONFIG_VERSION, id, name, settings, repos }
  if (!legacy && Array.isArray(r.projects)) config.projects = normalizeProjects(r.projects, repos)
  return config
}

/**
 * Keep the project entries that still make sense against `repos`: member ids
 * that name a repo in the file and are not already claimed by an earlier
 * project, a home that is one of the members, a root (else the first
 * member's path) and a name (else the root's last segment). A project left
 * with no members is dropped; its repos, if any, get projects of their own on
 * import.
 */
function normalizeProjects(raw: unknown[], repos: WorkspaceRepoConfig[]): WorkspaceProjectConfig[] {
  const repoPath = new Map(repos.map((r) => [r.id, r.path]))
  const claimed = new Set<string>()
  const seen = new Set<string>()
  const out: WorkspaceProjectConfig[] = []
  for (const item of raw) {
    const p = (item ?? {}) as Record<string, unknown>
    const members = (Array.isArray(p.repos) ? p.repos : []).filter(
      (rid): rid is string => typeof rid === 'string' && repoPath.has(rid) && !claimed.has(rid)
    )
    const unique = [...new Set(members)]
    if (unique.length === 0) continue
    for (const rid of unique) claimed.add(rid)
    let pid = typeof p.id === 'string' && p.id ? p.id : ''
    if (!pid || seen.has(pid)) pid = randomUUID()
    seen.add(pid)
    const root = typeof p.root === 'string' && p.root.trim() ? p.root.trim() : (repoPath.get(unique[0]) ?? '')
    const entry: WorkspaceProjectConfig = {
      id: pid,
      name: typeof p.name === 'string' && p.name ? p.name : (root.split(/[\\/]/).filter(Boolean).pop() ?? root),
      root,
      repos: unique
    }
    if (typeof p.home === 'string' && unique.includes(p.home)) entry.home = p.home
    out.push(entry)
  }
  return out
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
