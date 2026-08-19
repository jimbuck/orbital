import {
  DEFAULT_ENV_SYNC_PATTERNS,
  WORKSPACE_SETTING_KEYS,
  defaultAgentConfigs,
  normalizeAgentConfigs,
  type GlobalSettings,
  type Settings,
  type SettingsPatch,
  type WorkspaceSettings
} from '@shared/types'
import { getDb } from '../db/database'
import { requireWorkspaceId, workspaces } from '../db/repositories'

/**
 * The settings facade. The renderer (and the rest of main) reads one flat
 * {@link Settings} object and writes back a {@link SettingsPatch} of only the
 * keys it actually changed; behind it the fields live in two places in the
 * global DB — workspace-scoped fields (env-sync patterns, periodic fetch,
 * configured agent profiles) on the active workspace's row, machine-global fields
 * (theme, alerts, shell, logging) in the settings table, shared by every
 * workspace and instance.
 */

const DEFAULT_SETTINGS: Settings = {
  defaultShell: '',
  alerts: { indicator: true, sound: true, taskbarBadge: true, taskbarFlash: true },
  envSyncPatterns: DEFAULT_ENV_SYNC_PATTERNS,
  periodicFetch: true,
  debugLogging: false,
  agents: defaultAgentConfigs(),
  // Existing installs merge over this default, so they stay dark and keep the
  // current look; only an explicit change opts a user into light/system.
  theme: 'dark'
}

/**
 * The machine-global keys, i.e. everything {@link WORKSPACE_SETTING_KEYS} does
 * not claim. Written as the keys of a `satisfies Record<keyof GlobalSettings>`
 * object so the compiler enforces the list stays complete: adding a global field
 * to {@link Settings} without listing it here fails typecheck rather than
 * silently making that field unreadable and unwritable.
 */
const GLOBAL_SETTING_KEYS = Object.keys({
  defaultShell: true,
  alerts: true,
  debugLogging: true,
  theme: true
} satisfies Record<keyof GlobalSettings, true>) as readonly (keyof GlobalSettings)[]

/**
 * The subset of `patch` covered by `keys`, dropping keys the caller left out.
 *
 * `undefined` means "not part of this patch" rather than "clear this field" —
 * every settings field has a meaningful empty value ('' / [] / false) that a
 * caller sends instead, so treating undefined as absent costs nothing and stops
 * a sparse object literal from erasing a stored value.
 */
function pick<K extends keyof Settings>(patch: SettingsPatch, keys: readonly K[]): Partial<Pick<Settings, K>> {
  const out: Partial<Pick<Settings, K>> = {}
  for (const key of keys) {
    if (patch[key] !== undefined) out[key] = patch[key] as Settings[K]
  }
  return out
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
  // Blobs written before installs became per-agent-profile also carry
  // claudeHooksInstalled / claudeSkillInstalled; picking only current keys drops
  // them (the installed state is read from each profile's files, not mirrored).
  for (const key of GLOBAL_SETTING_KEYS) {
    if (blob[key] !== undefined) out[key] = blob[key]
  }
  return out as Partial<GlobalSettings>
}

function writeGlobalSettings(s: Partial<GlobalSettings>): void {
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

/**
 * Apply `patch` — only the keys the caller changed — across the global settings
 * table and the active workspace's row, and return the freshly assembled result.
 *
 * Two things make this a merge rather than a store, and both matter:
 *
 * 1. **The patch is partial.** One workspace per process, but the settings table
 *    is machine-global and shared by every running instance. When a caller wrote
 *    the whole global slice from its own in-memory snapshot, instance B changing
 *    the theme rewrote defaultShell / alerts / debugLogging from B's (possibly
 *    minutes-old) copy, reverting a change instance A had just made. Sending
 *    only the changed keys means disjoint edits can no longer collide at all.
 * 2. **The read-modify-write is transactional, and IMMEDIATE.** Merging a patch
 *    requires reading the stored blob first, so two processes patching different
 *    keys at the same moment could still interleave read/read/write/write and
 *    lose one. `immediate()` takes SQLite's write lock at BEGIN rather than on
 *    first write, so the two are serialized instead of racing (and the second
 *    waits out the first via the busy_timeout set in getDb, rather than
 *    upgrading a read lock and failing with SQLITE_BUSY).
 *
 * Keys outside {@link Settings} are dropped by the picks below, so a stray field
 * from an older or newer renderer can never end up persisted.
 */
export function setSettings(patch: SettingsPatch): Settings {
  const globalPatch = pick(patch, GLOBAL_SETTING_KEYS)
  const workspacePatch = pick(patch, WORKSPACE_SETTING_KEYS)
  const workspaceId = requireWorkspaceId()

  const apply = getDb().transaction(() => {
    // Skip the row entirely when the patch touches nothing on that side: a theme
    // click should not rewrite (and bump) the workspace row at all.
    if (Object.keys(globalPatch).length > 0) {
      writeGlobalSettings({ ...readGlobalSettings(), ...globalPatch })
    }
    if (Object.keys(workspacePatch).length > 0) {
      workspaces.updateSettings(workspaceId, { ...workspaces.getSettings(workspaceId), ...workspacePatch })
    }
  })
  apply.immediate()

  return getSettings()
}
