import {
  DEFAULT_ENV_SYNC_PATTERNS,
  SUPPORTED_AGENTS,
  type GlobalSettings,
  type Settings,
  type WorkspaceSettings
} from '@shared/types'
import { getDb } from '../db/database'
import { getGlobalSettings, setGlobalSettings } from './global-config'
import { getWorkspaceSettings, updateWorkspaceSettings } from './workspace-config'

/**
 * The settings facade. The renderer (and the rest of main) reads and writes one
 * flat {@link Settings} object; behind it the fields are split across two
 * stores — workspace-scoped fields (env-sync patterns, periodic fetch, enabled
 * agents) persist in the active workspace's YAML config, machine-global fields
 * (theme, alerts, shell, logging, Claude hooks) in the global store shared by
 * every instance. Settings created before the split lived as a JSON blob in the
 * per-profile SQLite DB; {@link migrateLegacySettings} seeds both stores from
 * that blob once so nothing resets on upgrade.
 */

const DEFAULT_SETTINGS: Settings = {
  defaultShell: '',
  alerts: { indicator: true, sound: true, taskbarBadge: true },
  claudeHooksInstalled: false,
  envSyncPatterns: DEFAULT_ENV_SYNC_PATTERNS,
  periodicFetch: true,
  debugLogging: false,
  enabledAgents: SUPPORTED_AGENTS.map((a) => a.id),
  // Existing installs merge over this default, so they stay dark and keep the
  // current look; only an explicit change opts a user into light/system.
  theme: 'dark'
}

function splitGlobal(s: Settings): GlobalSettings {
  return {
    defaultShell: s.defaultShell,
    alerts: s.alerts,
    claudeHooksInstalled: s.claudeHooksInstalled,
    debugLogging: s.debugLogging,
    theme: s.theme
  }
}

function splitWorkspace(s: Settings): WorkspaceSettings {
  return {
    envSyncPatterns: s.envSyncPatterns,
    periodicFetch: s.periodicFetch,
    enabledAgents: s.enabledAgents
  }
}

/** The assembled settings: defaults ← global store ← active workspace config. */
export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...getGlobalSettings(), ...getWorkspaceSettings() }
}

/** Split a full settings object across the global and workspace stores. */
export function setSettings(s: Settings): Settings {
  setGlobalSettings(splitGlobal(s))
  updateWorkspaceSettings(splitWorkspace(s))
  return getSettings()
}

/** The pre-split settings blob from this profile's DB, if one was ever saved. */
function legacyDbSettings(): Partial<Settings> | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Settings>) : null
  } catch {
    return null
  }
}

/**
 * One-time move of settings out of the profile DB into the split stores. Each
 * store is only seeded while it has never been written (so this can run every
 * boot without clobbering later edits), and the DB blob is left in place for
 * rollback. New profiles with no blob simply start from defaults on first save.
 */
export function migrateLegacySettings(): void {
  const legacy = legacyDbSettings()
  if (!legacy) return
  const merged = { ...DEFAULT_SETTINGS, ...legacy }
  if (getGlobalSettings() === undefined) setGlobalSettings(splitGlobal(merged))
  if (getWorkspaceSettings() === undefined) updateWorkspaceSettings(splitWorkspace(merged))
}
