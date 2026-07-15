import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { GlobalSettings, WorkspaceInfo } from '@shared/types'

/**
 * The machine-global store: the settings that apply to every workspace (theme,
 * alerts, shell, logging, Claude hooks) plus the recently-opened-workspaces
 * registry that feeds the picker. It lives OUTSIDE any workspace's profile dir
 * — in the default userData root — so all instances share one copy. The
 * `ORBITAL_USER_DATA` sandbox override relocates it into the sandbox dir so
 * test runs never touch the real one.
 */

const FILENAME = 'global-config.json'

/** How many workspaces the picker remembers. */
const MAX_RECENTS = 20

interface GlobalStore {
  /** Absent until first migration/save — the settings service seeds it. */
  settings?: Partial<GlobalSettings>
  recentWorkspaces: WorkspaceInfo[]
}

let dir: string | null = null
let cache: GlobalStore | null = null

/** Point the store at its directory. Must be called once, before any access. */
export function initGlobalConfig(directory: string): void {
  dir = directory
  cache = null
}

function filePath(): string {
  if (!dir) throw new Error('global config not initialized')
  return join(dir, FILENAME)
}

function load(): GlobalStore {
  if (cache) return cache
  let store: GlobalStore = { recentWorkspaces: [] }
  const file = filePath()
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        store = {
          settings: typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : undefined,
          recentWorkspaces: Array.isArray(parsed.recentWorkspaces)
            ? parsed.recentWorkspaces.filter(
                (w: unknown): w is WorkspaceInfo =>
                  !!w && typeof (w as WorkspaceInfo).id === 'string' && typeof (w as WorkspaceInfo).configPath === 'string'
              )
            : []
        }
      }
    } catch {
      // Corrupt global store — fall back to defaults; the next save rewrites it.
    }
  }
  cache = store
  return store
}

function save(store: GlobalStore): void {
  cache = store
  const file = filePath()
  mkdirSync(dir!, { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, file) // atomic replace so a crash mid-write can't truncate it
}

/** The persisted global-settings slice (partial — merge defaults over it). */
export function getGlobalSettings(): Partial<GlobalSettings> | undefined {
  return load().settings
}

export function setGlobalSettings(settings: GlobalSettings): void {
  save({ ...load(), settings })
}

/** Recently-opened workspaces, most recent first. */
export function listRecentWorkspaces(): WorkspaceInfo[] {
  return [...load().recentWorkspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

/**
 * Record a workspace in the recents registry (keyed by config path, since two
 * copied files could share an id but are still distinct workspaces to open).
 */
export function upsertRecentWorkspace(info: WorkspaceInfo): void {
  const store = load()
  const rest = store.recentWorkspaces.filter((w) => w.configPath !== info.configPath)
  save({ ...store, recentWorkspaces: [info, ...rest].slice(0, MAX_RECENTS) })
}

export function removeRecentWorkspace(configPath: string): WorkspaceInfo[] {
  const store = load()
  save({ ...store, recentWorkspaces: store.recentWorkspaces.filter((w) => w.configPath !== configPath) })
  return listRecentWorkspaces()
}
