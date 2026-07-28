import {
  DEFAULT_ENV_SYNC_PATTERNS,
  defaultAgentConfigs,
  normalizeAgentConfigs,
  type GlobalSettings,
  type Settings,
  type WorkspaceSettings
} from '@shared/types'
import { getDb } from '../db/database'
import { requireWorkspaceId, workspaces } from '../db/repositories'

/**
 * The settings facade. The renderer (and the rest of main) reads and writes one
 * flat {@link Settings} object; behind it the fields live in two places in the
 * global DB — workspace-scoped fields (env-sync patterns, periodic fetch,
 * configured agents) on the active workspace's row, machine-global fields (theme,
 * alerts, shell, logging, Claude hooks) in the settings table, shared by every
 * workspace and instance.
 */

const DEFAULT_SETTINGS: Settings = {
  defaultShell: '',
  alerts: { indicator: true, sound: true, taskbarBadge: true, taskbarFlash: true },
  claudeHooksInstalled: false,
  envSyncPatterns: DEFAULT_ENV_SYNC_PATTERNS,
  periodicFetch: true,
  debugLogging: false,
  agents: defaultAgentConfigs(),
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
    agents: s.agents
  }
}

/**
 * The global slice from the settings table. Pre-split blobs also carried the
 * workspace fields; picking only the global keys keeps those leftovers from
 * shadowing a workspace's own (or default) values.
 */
function readGlobalSettings(): Partial<GlobalSettings> {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
  if (!row) return {}
  let blob: Record<string, unknown>
  try {
    blob = JSON.parse(row.value)
  } catch {
    return {}
  }
  if (!blob || typeof blob !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const key of ['defaultShell', 'alerts', 'claudeHooksInstalled', 'debugLogging', 'theme'] as const) {
    if (blob[key] !== undefined) out[key] = blob[key]
  }
  return out as Partial<GlobalSettings>
}

function writeGlobalSettings(s: GlobalSettings): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(JSON.stringify(s))
}

/** The assembled settings: defaults ← global slice ← active workspace's slice. */
export function getSettings(): Settings {
  // A workspace row written before configured agents existed carries a legacy
  // `enabledAgents` id array instead of `agents` — convert it (and scrub any
  // malformed hand-edit) so the rest of the app only ever sees AgentConfig[].
  const ws = workspaces.getSettings(requireWorkspaceId()) as Partial<WorkspaceSettings> & {
    enabledAgents?: unknown
  }
  const agents = normalizeAgentConfigs(ws.agents, ws.enabledAgents)
  delete ws.enabledAgents
  const merged = { ...DEFAULT_SETTINGS, ...readGlobalSettings(), ...ws }
  merged.agents = agents ?? DEFAULT_SETTINGS.agents
  // The top-level merge is shallow, so a stored alerts blob written before a
  // toggle existed would shadow that toggle's default with undefined — deep-merge
  // the alerts object so new alert settings arrive enabled on old installs.
  merged.alerts = { ...DEFAULT_SETTINGS.alerts, ...merged.alerts }
  return merged
}

/** Split a full settings object across the global table and the workspace row. */
export function setSettings(s: Settings): Settings {
  writeGlobalSettings(splitGlobal(s))
  workspaces.updateSettings(requireWorkspaceId(), splitWorkspace(s))
  return getSettings()
}
