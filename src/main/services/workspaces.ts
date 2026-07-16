import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { controlPipePath, type WorkspaceConfig, type WorkspaceInfo } from '@shared/types'
import { getDb, initDb } from '../db/database'
import { projects, requireWorkspaceId, setActiveWorkspaceId, workspaces } from '../db/repositories'
import { readWorkspaceYaml, writeWorkspaceYaml } from './workspace-yaml'

/**
 * Workspace management. Workspaces are rows in the GLOBAL DB (nice and simple):
 * one `orbital.db` under the app-storage root holds every workspace, its
 * projects, and all state; each running instance scopes itself to one workspace
 * and gets its own Chromium profile dir (browsers can't share one), while the
 * data layer is shared through WAL. Sharing a workspace happens through
 * Export/Import (see workspace-yaml.ts), not through live files.
 */

/** Where this instance's dirs were resolved at process start. */
export interface BootWorkspace {
  /** App-storage root: the global DB (and profiles/) live here. */
  globalRoot: string
  /** This instance's Chromium profile dir — becomes userData. */
  profileDir: string
}

/** Pull `--workspace-id <id>` / `--workspace-id=<id>` out of the process args. */
function workspaceIdArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--workspace-id') return argv[i + 1] ?? null
    if (a.startsWith('--workspace-id=')) return a.slice('--workspace-id='.length) || null
  }
  return null
}

/** First 16 uuid chars = 64 bits — ample to keep sibling profile dirs distinct. */
function profileKey(workspaceId: string): string {
  return workspaceId.replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'workspace'
}

/**
 * Decide which workspace this process runs, before the app is ready — the
 * profile dir keys the single-instance lock (one instance per workspace), so it
 * must be settled before anything opens.
 *
 * - `ORBITAL_USER_DATA` (sandbox override) relocates the app-storage root so
 *   test runs never touch the real one; everything else works identically.
 * - `--workspace-id <id>` / `ORBITAL_WORKSPACE_ID` picks the workspace (the
 *   picker launches instances this way). An unknown id falls back to…
 * - …the default: the most recently opened workspace (the DB migration
 *   guarantees at least one exists).
 */
export function resolveBootWorkspace(defaultUserData: string): BootWorkspace {
  const globalRoot = process.env['ORBITAL_USER_DATA'] || defaultUserData
  mkdirSync(globalRoot, { recursive: true })
  initDb(globalRoot)
  getDb() // opens + migrates the global DB (creates the Default workspace on first run)

  const requested = workspaceIdArg(process.argv) ?? process.env['ORBITAL_WORKSPACE_ID'] ?? null
  const workspaceId =
    (requested && workspaces.get(requested) ? requested : null) ?? workspaces.mostRecentId()
  if (!workspaceId) throw new Error('no workspace exists — the DB migration should have created one')
  setActiveWorkspaceId(workspaceId)
  workspaces.touchOpened(workspaceId)

  const profileDir = join(globalRoot, 'profiles', profileKey(workspaceId))
  mkdirSync(profileDir, { recursive: true })
  return { globalRoot, profileDir }
}

/** Control-pipe path scoped to this instance's workspace. */
export function activeControlPipePath(): string {
  return controlPipePath(requireWorkspaceId())
}

/**
 * One-time cleanup of the short-lived files-as-source-of-truth design: a
 * `workspace.yaml` next to the DB is folded into the oldest workspace's
 * settings (its projects already live in the DB), a `global-config.json`'s
 * settings into the global settings blob; both files are then set aside as
 * `.imported.bak` so this never runs twice.
 */
export function migrateLegacyWorkspaceFiles(globalRoot: string): void {
  const db = getDb()

  const yamlFile = join(globalRoot, 'workspace.yaml')
  if (existsSync(yamlFile)) {
    try {
      const config = readWorkspaceYaml(yamlFile)
      const oldest = db.prepare('SELECT id FROM workspaces ORDER BY created_at LIMIT 1').get() as
        | { id: string }
        | undefined
      if (oldest && config.settings && Object.keys(workspaces.getSettings(oldest.id)).length === 0) {
        db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(
          JSON.stringify(config.settings),
          oldest.id
        )
      }
    } catch {
      // Unreadable legacy file — nothing to fold in.
    }
    try {
      renameSync(yamlFile, `${yamlFile}.imported.bak`)
    } catch {
      /* best effort */
    }
  }

  const globalCfg = join(globalRoot, 'global-config.json')
  if (existsSync(globalCfg)) {
    try {
      const parsed = JSON.parse(readFileSync(globalCfg, 'utf8'))
      if (parsed?.settings && typeof parsed.settings === 'object') {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
          | { value: string }
          | undefined
        let blob: Record<string, unknown> = {}
        try {
          blob = row ? JSON.parse(row.value) : {}
        } catch {
          blob = {}
        }
        const merged = JSON.stringify({ ...blob, ...parsed.settings })
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(merged)
      }
    } catch {
      // Unreadable legacy file — nothing to fold in.
    }
    try {
      renameSync(globalCfg, `${globalCfg}.imported.bak`)
    } catch {
      /* best effort */
    }
  }
}

/** Serialize a workspace (projects + settings) to a shareable export file. */
export function exportWorkspaceToFile(workspaceId: string, file: string): void {
  const ws = workspaces.get(workspaceId)
  if (!ws) throw new Error(`workspace ${workspaceId} not found`)
  const settings = workspaces.getSettings(workspaceId)
  const config: WorkspaceConfig = {
    version: 1,
    id: ws.id,
    name: ws.name,
    settings: Object.keys(settings).length > 0 ? settings : undefined,
    projects: projects.list(workspaceId).map((p) => {
      const entry: WorkspaceConfig['projects'][number] = { id: p.id, name: p.name, path: p.repoPath }
      if (p.defaultAgentProvider && p.defaultAgentProvider !== 'claude') entry.agentProvider = p.defaultAgentProvider
      if (p.agentExecPath) entry.agentExecPath = p.agentExecPath
      return entry
    })
  }
  writeWorkspaceYaml(file, config)
}

/**
 * Create a new workspace from an export file. Ids are kept when free (so a
 * workspace round-trips across machines) and regenerated on collision — an
 * import NEVER merges into or overwrites an existing workspace.
 */
export function importWorkspaceFromFile(file: string): WorkspaceInfo {
  const config = readWorkspaceYaml(file)
  const db = getDb()

  const wsIdTaken = !!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(config.id)
  const workspaceId = wsIdTaken ? randomUUID() : config.id
  const now = Date.now()
  const projectIdTaken = db.prepare('SELECT 1 FROM projects WHERE id = ?')

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO workspaces (id, name, settings, created_at, last_opened_at) VALUES (?, ?, ?, ?, 0)').run(
      workspaceId,
      config.name,
      JSON.stringify(config.settings ?? {}),
      now
    )
    const insert = db.prepare(
      `INSERT INTO projects (id, workspace_id, name, repo_path, default_agent_provider, agent_exec_path, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    let seq = now
    for (const p of config.projects) {
      insert.run(
        projectIdTaken.get(p.id) ? randomUUID() : p.id,
        workspaceId,
        p.name,
        p.path,
        p.agentProvider || 'claude',
        p.agentExecPath ?? '',
        seq++
      )
    }
  })
  tx()
  return workspaces.get(workspaceId)!
}
