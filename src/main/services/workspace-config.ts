import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'yaml'
import {
  WORKSPACE_CONFIG_VERSION,
  controlPipePath,
  type WorkspaceConfig,
  type WorkspaceProjectConfig
} from '@shared/types'
import { projects } from '../db/repositories'

/**
 * The workspace config is the YAML file that defines *which projects* this
 * instance's workspace contains. It lives in the active profile directory
 * (alongside `orbital.db`), so switching profiles — the existing
 * `ORBITAL_USER_DATA` lever — switches workspaces. The file is the source of
 * truth on load: {@link loadWorkspaceConfig} reads it (seeding from the DB the
 * first time, for existing installs), then the boot sequence reconciles the
 * `projects` table to match. After any UI mutation {@link syncWorkspaceFromDb}
 * rewrites the file so it always reflects live state on the next launch.
 */

const CONFIG_FILENAME = 'workspace.yaml'

const HEADER = `# Orbital workspace configuration.
# This file defines the projects in this workspace. Orbital reads it on launch
# (it is the source of truth for the project list) and rewrites it when you add,
# remove, or rename a project. Each project needs a 'path' to a git repo; ids are
# generated automatically.
`

let active: WorkspaceConfig | null = null

/** Absolute path to the active profile's workspace config file. */
export function workspaceConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_FILENAME)
}

/** The workspace loaded for this instance. Throws if accessed before load. */
export function activeWorkspace(): WorkspaceConfig {
  if (!active) throw new Error('workspace config not loaded')
  return active
}

/** Control-pipe path scoped to the active workspace (per running instance). */
export function activeControlPipePath(): string {
  return controlPipePath(active?.id)
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/** Map the DB project rows to config entries (row order == config order). */
function projectsFromDb(): WorkspaceProjectConfig[] {
  return projects.list().map((p) => {
    const entry: WorkspaceProjectConfig = { id: p.id, name: p.name, path: p.repoPath }
    if (p.defaultAgentProvider && p.defaultAgentProvider !== 'claude') entry.agentProvider = p.defaultAgentProvider
    if (p.agentExecPath) entry.agentExecPath = p.agentExecPath
    return entry
  })
}

/**
 * Coerce a parsed (possibly hand-authored or partial) config into a valid
 * {@link WorkspaceConfig}: fill a missing id/name/version, drop project entries
 * with no path, and generate ids for entries that lack one or collide. Reports
 * whether anything changed so the caller can rewrite the normalized file.
 */
function normalize(raw: unknown): { config: WorkspaceConfig; changed: boolean } {
  const r = (raw ?? {}) as Record<string, unknown>
  let changed = false

  let id = typeof r.id === 'string' && r.id ? r.id : ''
  if (!id) {
    id = randomUUID()
    changed = true
  }
  let name = typeof r.name === 'string' && r.name ? r.name : ''
  if (!name) {
    name = 'Default'
    changed = true
  }
  if (r.version !== WORKSPACE_CONFIG_VERSION) changed = true

  const rawProjects = Array.isArray(r.projects) ? r.projects : []
  if (!Array.isArray(r.projects)) changed = true

  const seen = new Set<string>()
  const outProjects: WorkspaceProjectConfig[] = []
  for (const item of rawProjects) {
    const p = (item ?? {}) as Record<string, unknown>
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (!path) {
      changed = true // entry without a repo path is meaningless — drop it
      continue
    }
    let pid = typeof p.id === 'string' && p.id ? p.id : ''
    if (!pid || seen.has(pid)) {
      pid = randomUUID()
      changed = true
    }
    seen.add(pid)
    let nm = typeof p.name === 'string' && p.name ? p.name : ''
    if (!nm) {
      nm = basename(path)
      changed = true
    }
    const entry: WorkspaceProjectConfig = { id: pid, name: nm, path }
    if (typeof p.agentProvider === 'string' && p.agentProvider) entry.agentProvider = p.agentProvider
    if (typeof p.agentExecPath === 'string' && p.agentExecPath) entry.agentExecPath = p.agentExecPath
    outProjects.push(entry)
  }

  return { config: { version: WORKSPACE_CONFIG_VERSION, id, name, projects: outProjects }, changed }
}

/** Serialize and atomically write a config to the active profile. */
export function saveWorkspaceConfig(config: WorkspaceConfig): void {
  const file = workspaceConfigPath()
  const text = HEADER + stringify(config)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file) // atomic replace so a crash mid-write can't truncate it
}

/** Build a fresh Default workspace seeded from whatever is already in the DB. */
function seedFromDb(): WorkspaceConfig {
  return { version: WORKSPACE_CONFIG_VERSION, id: randomUUID(), name: 'Default', projects: projectsFromDb() }
}

/**
 * Load (or create) the active profile's workspace config and cache it as the
 * active workspace. First run for an existing install has no file yet — seed it
 * from the DB so no projects disappear. A corrupt file is set aside (`.bak`) and
 * replaced from the DB rather than bricking startup; a valid-but-partial file is
 * normalized and rewritten.
 */
export function loadWorkspaceConfig(): WorkspaceConfig {
  const file = workspaceConfigPath()
  if (!existsSync(file)) {
    active = seedFromDb()
    saveWorkspaceConfig(active)
    return active
  }
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch {
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      // Couldn't preserve it — proceed with a DB-seeded config anyway.
    }
    active = seedFromDb()
    saveWorkspaceConfig(active)
    return active
  }
  const { config, changed } = normalize(raw)
  active = config
  if (changed) saveWorkspaceConfig(config)
  return config
}

/**
 * Rewrite the workspace file from the current DB projects. Call after any
 * project mutation so the file — the source of truth on the next launch — stays
 * in sync with live state. No-op until a config has been loaded.
 */
export function syncWorkspaceFromDb(): void {
  if (!active) return
  active = { ...active, projects: projectsFromDb() }
  saveWorkspaceConfig(active)
}
