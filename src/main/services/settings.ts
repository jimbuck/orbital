import { type Settings, type SettingsPatch } from '@shared/types'
import { WORKSPACE_SETTING_KEYS, resolveSettings } from '@shared/settings'
import { getDb } from '../db/database'
import { requireWorkspaceId, workspaces } from '../db/repositories'

/**
 * The settings facade. The renderer (and the rest of main) reads one flat
 * {@link Settings} object and writes back a {@link SettingsPatch} of only the
 * keys it actually changed. Every field lives on the active workspace's row in
 * the global DB; the machine-global settings table is only read, as the fallback
 * for fields that used to live there. Defaults, and what counts as a usable
 * stored value, come from the schema in `@shared/settings`.
 */

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

/**
 * The assembled settings: defaults <- legacy global values <- active workspace's row.
 *
 * Both blobs keep keys this build does not know (see setSettings), and the
 * workspace row can be hand-edited or written by an import. The schema reads
 * only the keys it declares and skips any value that is not usable, so storage
 * remembers everything while the runtime object never sees a field, or a value,
 * its build cannot mean anything by.
 */
export function getSettings(): Settings {
  return resolveSettings(workspaces.getSettings(requireWorkspaceId()) as Record<string, unknown>, readGlobalBlob())
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
