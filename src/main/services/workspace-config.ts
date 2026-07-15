import { app } from 'electron'
import { basename as pathBasename, dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'yaml'
import {
  WORKSPACE_CONFIG_VERSION,
  controlPipePath,
  type WorkspaceConfig,
  type WorkspaceInfo,
  type WorkspaceProjectConfig,
  type WorkspaceSettings
} from '@shared/types'
import { projects } from '../db/repositories'

/**
 * The workspace config is the YAML file that defines *which projects* this
 * instance's workspace contains, plus the workspace-scoped settings. It is the
 * source of truth on load: {@link loadWorkspaceConfig} reads it (seeding from
 * the DB the first time, for existing installs), then the boot sequence
 * reconciles the `projects` table to match. After any UI mutation
 * {@link syncWorkspaceFromDb} rewrites the file so it always reflects live
 * state on the next launch.
 *
 * Which file is active is decided once, at process start, by
 * {@link resolveBootWorkspace}: a `--workspace <file>` argument (or
 * `ORBITAL_WORKSPACE` env) opens a config anywhere on disk — a workspace file
 * typically lives above the repos it collects, shared but not committed — and
 * its state lands in a profile dir derived from the workspace id. With no
 * argument the default profile's `workspace.yaml` is used (the pre-workspace
 * behavior, so existing installs keep their data).
 */

const CONFIG_FILENAME = 'workspace.yaml'

const HEADER = `# Orbital workspace configuration.
# This file defines the projects in this workspace. Orbital reads it on launch
# (it is the source of truth for the project list) and rewrites it when you add,
# remove, or rename a project. Each project needs a 'path' to a git repo; ids are
# generated automatically.
`

let active: WorkspaceConfig | null = null

/** Config file chosen at boot (a `--workspace` file); null → default location. */
let bootConfigPath: string | null = null

/** Absolute path to this instance's workspace config file. */
export function workspaceConfigPath(): string {
  return bootConfigPath ?? join(app.getPath('userData'), CONFIG_FILENAME)
}

/** Where this instance's workspace was resolved from at process start. */
export interface BootWorkspace {
  /** The workspace YAML this instance runs. */
  configPath: string | null
  /** Profile dir for this instance's state (DB, briefings) — becomes userData. */
  profileDir: string
  /** Where the machine-global store lives (shared across instances). */
  globalDir: string
}

/** Pull `--workspace <file>` / `--workspace=<file>` out of the process args. */
function workspaceArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--workspace') return argv[i + 1] ?? null
    if (a.startsWith('--workspace=')) return a.slice('--workspace='.length) || null
  }
  return null
}

/**
 * Decide which workspace this process runs, before the app is ready — the
 * profile dir keys both the single-instance lock and every persistent path, so
 * it must be settled before anything opens. The two levers are independent:
 *
 * - `ORBITAL_USER_DATA` (sandbox override) pins WHERE state lives: profile AND
 *   the global store both land in that dir, keeping test runs fully hermetic.
 * - `--workspace <file>` / `ORBITAL_WORKSPACE` pins WHICH config file runs
 *   (created/healed here so its id — and any dir derived from it — is stable).
 *   Without a sandbox, state lands in a per-workspace profile dir derived from
 *   the workspace id under the default userData root.
 * - Neither: the default profile and its `workspace.yaml` (legacy behavior).
 */
export function resolveBootWorkspace(defaultUserData: string): BootWorkspace {
  const sandbox = process.env['ORBITAL_USER_DATA']
  const fileArg = workspaceArg(process.argv) ?? process.env['ORBITAL_WORKSPACE'] ?? null
  const file = fileArg ? (isAbsolute(fileArg) ? fileArg : resolve(fileArg)) : null
  const config = file ? ensureConfigFile(file) : null
  if (file) bootConfigPath = file

  if (sandbox) {
    mkdirSync(sandbox, { recursive: true })
    return { configPath: file, profileDir: sandbox, globalDir: sandbox }
  }

  if (file && config) {
    // First 16 uuid chars = 64 bits — ample to keep sibling profiles distinct.
    const safeId = config.id.replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'workspace'
    const profileDir = join(defaultUserData, 'workspaces', safeId)
    mkdirSync(profileDir, { recursive: true })
    return { configPath: file, profileDir, globalDir: defaultUserData }
  }

  mkdirSync(defaultUserData, { recursive: true })
  return { configPath: null, profileDir: defaultUserData, globalDir: defaultUserData }
}

/**
 * Make sure a workspace file exists, parses, and carries a stable id — the id
 * derives the profile dir, so it must be settled before the file is "loaded"
 * for real. Missing → write a fresh skeleton named after the file; corrupt →
 * set aside as `.bak` and start over; id-less → heal in place via normalize.
 */
function ensureConfigFile(file: string): WorkspaceConfig {
  const fresh = (): WorkspaceConfig => ({
    version: WORKSPACE_CONFIG_VERSION,
    id: randomUUID(),
    name: workspaceNameFromFile(file),
    projects: []
  })
  if (!existsSync(file)) {
    const config = fresh()
    saveWorkspaceConfigTo(file, config)
    return config
  }
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch {
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      // Couldn't preserve the corrupt file — overwrite it.
    }
    const config = fresh()
    saveWorkspaceConfigTo(file, config)
    return config
  }
  const { config, changed } = normalize(raw)
  if (changed) saveWorkspaceConfigTo(file, config)
  return config
}

/** Human name for a workspace created from a file path ("team.yaml" → "team"). */
function workspaceNameFromFile(file: string): string {
  return pathBasename(file).replace(/\.(ya?ml)$/i, '') || 'Workspace'
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

/** Stamped once at boot; recents show when this instance opened its workspace. */
const openedAt = Date.now()

/** The active workspace as picker/registry metadata (id, name, file, opened). */
export function activeWorkspaceInfo(): WorkspaceInfo {
  const ws = activeWorkspace()
  return { id: ws.id, name: ws.name, configPath: workspaceConfigPath(), lastOpenedAt: openedAt }
}

/** The workspace-scoped settings slice persisted in the active config file. */
export function getWorkspaceSettings(): Partial<WorkspaceSettings> | undefined {
  return active?.settings
}

/** Persist the workspace-scoped settings slice into the active config file. */
export function updateWorkspaceSettings(settings: WorkspaceSettings): void {
  if (!active) throw new Error('workspace config not loaded')
  active = { ...active, settings }
  saveWorkspaceConfig(active)
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

  // Workspace-scoped settings: keep only recognizably-typed fields; anything
  // absent stays absent (the settings service layers defaults over this slice).
  let settings: WorkspaceConfig['settings']
  if (r.settings && typeof r.settings === 'object') {
    const s = r.settings as Record<string, unknown>
    settings = {}
    if (Array.isArray(s.envSyncPatterns) && s.envSyncPatterns.every((x) => typeof x === 'string')) {
      settings.envSyncPatterns = s.envSyncPatterns
    }
    if (typeof s.periodicFetch === 'boolean') settings.periodicFetch = s.periodicFetch
    if (Array.isArray(s.enabledAgents) && s.enabledAgents.every((x) => typeof x === 'string')) {
      settings.enabledAgents = s.enabledAgents
    }
    if (Object.keys(settings).length === 0) settings = undefined
  } else if (r.settings !== undefined) {
    changed = true // a non-object `settings:` entry is meaningless — drop it
  }

  return { config: { version: WORKSPACE_CONFIG_VERSION, id, name, settings, projects: outProjects }, changed }
}

/** Serialize and atomically write a config to `file`. */
function saveWorkspaceConfigTo(file: string, config: WorkspaceConfig): void {
  mkdirSync(dirname(file), { recursive: true })
  // yaml's stringify drops undefined-valued keys, so an absent `settings` slice
  // never appears in the file.
  const text = HEADER + stringify(config)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file) // atomic replace so a crash mid-write can't truncate it
}

/** Serialize and atomically write a config to this instance's config file. */
export function saveWorkspaceConfig(config: WorkspaceConfig): void {
  saveWorkspaceConfigTo(workspaceConfigPath(), config)
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

/* ---- picker helpers (operate on OTHER workspaces' files, never `active`) --- */

/**
 * Read another workspace file's identity for the picker/recents. Throws with a
 * readable message when the file is missing or unparseable — the picker
 * surfaces it instead of launching a broken instance.
 */
export function readWorkspaceInfo(file: string): WorkspaceInfo {
  if (!existsSync(file)) throw new Error(`workspace file not found: ${file}`)
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`not a valid workspace file: ${err instanceof Error ? err.message : String(err)}`)
  }
  const { config } = normalize(raw)
  return { id: config.id, name: config.name, configPath: file, lastOpenedAt: Date.now() }
}

/** Create a fresh, empty workspace file at `file` (name derived from it). */
export function createWorkspaceFile(file: string): WorkspaceInfo {
  const config: WorkspaceConfig = {
    version: WORKSPACE_CONFIG_VERSION,
    id: randomUUID(),
    name: workspaceNameFromFile(file),
    projects: []
  }
  saveWorkspaceConfigTo(file, config)
  return { id: config.id, name: config.name, configPath: file, lastOpenedAt: Date.now() }
}
