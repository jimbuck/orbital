import {
  DEFAULT_ENV_SYNC_PATTERNS,
  WORKSPACE_SETTING_KEYS,
  defaultAgentConfigs,
  normalizeAccentColor,
  normalizeAgentConfigs,
  normalizeOpenAction,
  type Settings,
  type SettingsPatch,
  type WorkspaceSettings
} from '@shared/types'
import { DEFAULT_THEME_ID, isThemeId, normalizeSystemTheme } from '@shared/themes'
import { getDb } from '../db/database'
import { requireWorkspaceId, workspaces } from '../db/repositories'

/**
 * The settings facade. The renderer (and the rest of main) reads one flat
 * {@link Settings} object and writes back a {@link SettingsPatch} of only the
 * keys it actually changed. Every field lives on the active workspace's row in
 * the global DB; the machine-global settings table is only read, as the fallback
 * for fields that used to live there (see {@link LEGACY_GLOBAL_KEYS}).
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
  theme: 'dark',
  // The pair 'system' resolves to. Orbital's own themes until the user says
  // otherwise, which is exactly what 'system' meant before it was a pair.
  systemDarkTheme: 'dark',
  systemLightTheme: 'light',
  // The font's own default, and what every install has had until now.
  fontLigatures: true,
  // Right pane by default: something opened from the palette or the git panel
  // lands beside what you were doing rather than on top of it.
  defaultOpenAction: 'right',
  accentColor: null
}

/**
 * The keys that used to be machine-global, before every setting moved to the
 * workspace.
 *
 * A workspace that has never set one of these still reads it from the global
 * blob, so the move did not reset anyone's shell, alerts or look: every
 * workspace keeps what the machine had until the user changes it in that
 * workspace. Older builds sharing the DB still read and write them there, which
 * is why they are left in the blob rather than migrated out of it. The blob can
 * also hold pre-split copies of the always-workspace keys (envSyncPatterns and
 * the like), already seeded into the first workspace; this list keeps those out.
 */
const LEGACY_GLOBAL_KEYS = [
  'defaultShell',
  'alerts',
  'debugLogging',
  'theme',
  'systemDarkTheme',
  'systemLightTheme',
  'fontLigatures',
  'defaultOpenAction'
] as const satisfies readonly (keyof Settings)[]

/**
 * The subset of `source` covered by `keys`, dropping everything else.
 *
 * Used both ways: on an inbound patch (keys the caller left out) and on a stored
 * blob (keys this build does not recognize), so neither can reach past the slice
 * it belongs to.
 *
 * `undefined` means "not part of this patch" rather than "clear this field" —
 * every settings field has a meaningful empty value ('' / [] / false) that a
 * caller sends instead, so treating undefined as absent costs nothing and stops
 * a sparse object literal from erasing a stored value.
 */
function pick<K extends keyof Settings>(source: SettingsPatch, keys: readonly K[]): Partial<Pick<Settings, K>> {
  const out: Partial<Pick<Settings, K>> = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key] as Settings[K]
  }
  return out
}

/**
 * Whether `patch` actually names `key`, i.e. whether this write can change that
 * field at all. Callers with a side effect to run — restarting env watchers,
 * reconfiguring the fetch loop — gate it on this so a patch that cannot possibly
 * affect them ({ theme } from a single click, or {} from an untouched Save) does
 * not churn subsystems it never touched. Same `undefined`-means-absent rule as
 * {@link pick}, kept in one place so the two cannot drift apart.
 */
export function patchTouches(patch: SettingsPatch, key: keyof Settings): boolean {
  return patch[key] !== undefined
}

/** The legacy machine-global `app` blob, or {} when it is missing or unreadable. */
function readGlobalBlob(): Record<string, unknown> {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
  if (!row) return {}
  let blob: unknown
  try {
    blob = JSON.parse(row.value)
  } catch {
    return {}
  }
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return {}
  return blob as Record<string, unknown>
}

/** The assembled settings: defaults ← legacy global values ← active workspace's row. */
export function getSettings(): Settings {
  // A workspace row written before configured agents existed carries a legacy
  // `enabledAgents` id array instead of `agents` — convert it (and scrub any
  // malformed hand-edit) so the rest of the app only ever sees AgentConfig[].
  const stored = workspaces.getSettings(requireWorkspaceId()) as Partial<WorkspaceSettings> & {
    enabledAgents?: unknown
  }
  const agents = normalizeAgentConfigs(stored.agents, stored.enabledAgents)
  // Pick rather than spread: both blobs keep keys this build does not know (see
  // setSettings), and spreading one raw would hand the renderer a field its build
  // cannot mean anything by. Storage remembers them; the runtime object never
  // sees them.
  const merged = {
    ...DEFAULT_SETTINGS,
    ...pick(readGlobalBlob() as SettingsPatch, LEGACY_GLOBAL_KEYS),
    ...pick(stored, WORKSPACE_SETTING_KEYS)
  }
  merged.agents = agents ?? DEFAULT_SETTINGS.agents
  // The top-level merge is shallow, so a stored alerts blob written before a
  // toggle existed would shadow that toggle's default with undefined — deep-merge
  // the alerts object so new alert settings arrive enabled on old installs.
  merged.alerts = { ...DEFAULT_SETTINGS.alerts, ...merged.alerts }
  // The workspace row can be hand-edited (or written by an import); a value that
  // is not a colour must read as "no accent", not reach the renderer's CSS.
  merged.accentColor = normalizeAccentColor(merged.accentColor)
  // A theme id this build does not ship (a newer build's, a hand edit) falls back
  // to the default rather than reaching the renderer as a theme it cannot draw.
  if (merged.theme !== 'system' && !isThemeId(merged.theme)) merged.theme = DEFAULT_THEME_ID
  // Same reasoning as the accent: the blob is shared with hand edits, imports
  // and other builds, and an unknown placement would leave the renderer unable
  // to resolve a target pane at all.
  merged.defaultOpenAction = normalizeOpenAction(merged.defaultOpenAction) ?? DEFAULT_SETTINGS.defaultOpenAction
  // Likewise the system pair, with the extra rule that each half has to name a
  // theme of its own appearance — a dark-OS slot holding a light theme would
  // defeat the whole feature rather than merely look odd.
  merged.systemDarkTheme = normalizeSystemTheme(merged.systemDarkTheme, 'dark')
  merged.systemLightTheme = normalizeSystemTheme(merged.systemLightTheme, 'light')
  return merged
}

/**
 * Apply `patch` — only the keys the caller changed — to the active workspace's
 * row, and return the freshly assembled result.
 *
 * A merge rather than a store, for two reasons:
 *
 * 1. **The patch is partial.** A caller that wrote its whole in-memory snapshot
 *    would revert whatever changed since it took that snapshot (a View-menu theme
 *    click landing while the Settings modal was open, say). Sending only the
 *    changed keys means disjoint edits cannot collide at all.
 * 2. **The read-modify-write is transactional, and IMMEDIATE.** The DB is shared
 *    by every running instance, so `immediate()` takes SQLite's write lock at
 *    BEGIN rather than on first write: a concurrent writer is serialized behind
 *    it (via the busy_timeout set in getDb) instead of upgrading a read lock and
 *    failing with SQLITE_BUSY.
 *
 * Keys outside {@link Settings} are dropped by the pick below, so a stray field
 * from an older or newer renderer can never end up persisted. Nothing is written
 * to the legacy global blob: older builds still own it.
 */
export function setSettings(patch: SettingsPatch): Settings {
  const workspacePatch = pick(patch, WORKSPACE_SETTING_KEYS)

  // Nothing to write: return the current settings without opening a transaction
  // at all. IMMEDIATE takes SQLite's write lock at BEGIN, so doing this for a
  // no-op would make every other instance queue behind a write that never comes.
  // Empty patches are routine, not exotic — an untouched Save sends {} by design
  // — and the guard is on the PICKED patch rather than on `patch` itself, since a
  // patch of only unrecognized keys reduces to exactly the same no-op.
  if (Object.keys(workspacePatch).length === 0) return getSettings()

  const workspaceId = requireWorkspaceId()

  const apply = getDb().transaction(() => {
    // The stored blob is spread WHOLE — deliberately not filtered to
    // WORKSPACE_SETTING_KEYS. It is the only copy of anything in it, and this
    // process is not the only writer: a user running two versions (a build from
    // a worktree beside the installed app, or a downgrade) hands the blob to a
    // build that knows a key this one does not. Filtering here would delete
    // that key the first time someone toggled periodicFetch, irreversibly and
    // silently. The same goes for the legacy `enabledAgents` array, which is
    // still what an older build reads its agent list from, and for the zoom
    // level, which zoom.ts keeps on this row outside Settings. Unknown keys are
    // instead dropped where dropping them is free — on the way OUT, in
    // getSettings — so they can never influence this build's behavior.
    workspaces.updateSettings(workspaceId, { ...workspaces.getSettings(workspaceId), ...workspacePatch })
  })
  apply.immediate()

  return getSettings()
}
