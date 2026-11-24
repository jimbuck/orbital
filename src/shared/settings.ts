import {
  DEFAULT_ENV_SYNC_PATTERNS,
  defaultAgentConfigs,
  normalizeAccentColor,
  normalizeAgentConfigs,
  normalizeOpenAction,
  type Settings
} from './types'
import { DEFAULT_THEME_ID, isThemeId, normalizeSystemTheme } from './themes'
import { DEFAULT_WORKTREE_BRANCH_PREFIX, cleanBranchPrefix } from './worktree-branch'

/**
 * The settings schema: for every key of {@link Settings}, what it is before
 * the user chooses, and what counts as a value for it. Each key is declared
 * once, in {@link SETTINGS}; everything that needs a default or has to decide
 * whether a stored, imported or hand-edited value is usable asks here:
 *
 *  - main assembles the settings it hands out with {@link resolveSettings};
 *  - the workspace YAML import keeps the usable fields with {@link parseSettings};
 *  - the renderer falls back to {@link DEFAULT_SETTINGS} before state loads.
 *
 * Values are checked on the way OUT of storage rather than trusted on the way
 * in: the workspace row is shared with hand edits, imports and other builds.
 */

type Blob = Readonly<Record<string, unknown>>

interface SettingSpec<T, P = T> {
  /** The value before the user has chosen one. */
  readonly default: T
  /**
   * `value` as this setting, or undefined when it is not one. `source` is the
   * blob the value came from, for a setting that can also be read from an
   * older key beside it.
   */
  readonly parse: (value: unknown, source: Blob) => P | undefined
  /** How a usable value combines with the one it overrides. Omitted: it replaces it. */
  readonly merge?: (base: T, value: P) => T
  /**
   * This key was machine-global before every setting moved to the workspace.
   * A workspace that has never set it still reads it from the legacy global
   * blob, so the move did not reset anyone's shell, alerts or look. Older
   * builds sharing the DB still read and write the blob, which is why it is
   * read here rather than migrated away. The blob can also hold pre-split
   * copies of always-workspace keys; those are not marked, and so not read.
   */
  readonly legacyGlobal?: true
}

const spec = <T, P = T>(s: SettingSpec<T, P>): SettingSpec<T, P> => s
const bool = (dflt: boolean, legacyGlobal?: true): SettingSpec<boolean> => ({
  default: dflt,
  parse: (v) => (typeof v === 'boolean' ? v : undefined),
  legacyGlobal
})
const text = (dflt: string, legacyGlobal?: true): SettingSpec<string> => ({
  default: dflt,
  parse: (v) => (typeof v === 'string' ? v : undefined),
  legacyGlobal
})
const systemTheme = (appearance: 'dark' | 'light'): SettingSpec<Settings['systemDarkTheme']> => ({
  default: normalizeSystemTheme(undefined, appearance),
  // Each half has to name a theme of its own appearance — a dark-OS slot
  // holding a light theme would defeat the whole feature.
  parse: (v) => (isThemeId(v) && normalizeSystemTheme(v, appearance) === v ? v : undefined),
  legacyGlobal: true
})

type Alerts = Settings['alerts']
const DEFAULT_ALERTS: Alerts = { indicator: true, sound: true, taskbarBadge: true, taskbarFlash: true }

export const SETTINGS = {
  defaultShell: text('', true),
  alerts: spec<Alerts, Partial<Alerts>>({
    default: DEFAULT_ALERTS,
    // Only the toggles that are booleans. Merged rather than replaced, so a
    // blob written before a toggle existed does not shadow that toggle's
    // default: new alert settings arrive enabled on old installs.
    parse: (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
      const out: Partial<Alerts> = {}
      for (const key of Object.keys(DEFAULT_ALERTS) as (keyof Alerts)[]) {
        const toggle = (v as Record<string, unknown>)[key]
        if (typeof toggle === 'boolean') out[key] = toggle
      }
      return Object.keys(out).length > 0 ? out : undefined
    },
    merge: (base, value) => ({ ...base, ...value }),
    legacyGlobal: true
  }),
  envSyncPatterns: spec<string[]>({
    default: DEFAULT_ENV_SYNC_PATTERNS,
    parse: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined)
  }),
  periodicFetch: bool(true),
  debugLogging: bool(false, true),
  agents: spec<Settings['agents']>({
    default: defaultAgentConfigs(),
    // A row or export written before configured agents existed carries a
    // legacy `enabledAgents` id array instead of `agents`; convert it (and
    // scrub any malformed hand-edit) so the app only ever sees AgentConfig[].
    parse: (v, source) => normalizeAgentConfigs(v, source.enabledAgents)
  }),
  // Existing installs resolve over this default, so they stay dark and keep the
  // current look; only an explicit change opts a user into light/system. An id
  // this build does not ship (a newer build's, a hand edit) is not a value.
  theme: spec<Settings['theme']>({
    default: DEFAULT_THEME_ID,
    parse: (v) => (v === 'system' || isThemeId(v) ? v : undefined),
    legacyGlobal: true
  }),
  // The pair 'system' resolves to. Orbital's own themes until the user says
  // otherwise, which is exactly what 'system' meant before it was a pair.
  systemDarkTheme: systemTheme('dark'),
  systemLightTheme: systemTheme('light'),
  // The font's own default, and what every install has had until now.
  fontLigatures: bool(true, true),
  // Right pane by default: something opened from the palette or the git panel
  // lands beside what you were doing rather than on top of it.
  defaultOpenAction: spec<Settings['defaultOpenAction']>({
    default: 'right',
    parse: (v) => normalizeOpenAction(v) ?? undefined,
    legacyGlobal: true
  }),
  // null is "no accent": the theme's built-in blue. A value that is not a
  // colour must read the same way, not reach the renderer's CSS.
  accentColor: spec<Settings['accentColor'], string>({
    default: null,
    parse: (v) => normalizeAccentColor(v) ?? undefined
  }),
  externalEditor: text(''),
  // Cleaned on the way out like everything else here: a hand-edited prefix
  // goes into a branch name, so it is held to what a branch name can carry.
  // An empty string is a value (no prefix), not a missing one.
  worktreeBranchPrefix: spec<string>({
    default: DEFAULT_WORKTREE_BRANCH_PREFIX,
    parse: (v) => (typeof v === 'string' ? cleanBranchPrefix(v) : undefined)
  })
  // `any` for the parsed type only: it differs per key (alerts parses to a
  // subset of its toggles), and each entry above states its own.
} satisfies { [K in keyof Settings]: SettingSpec<Settings[K], any> }

/**
 * Every settings key. All of them are workspace-scoped: each workspace runs in
 * its own window, and each window is configured on its own. Derived from the
 * schema, whose type requires an entry per field of {@link Settings}: adding a
 * field without declaring it there fails typecheck, rather than silently
 * making that field unreadable and unwritable.
 */
export const WORKSPACE_SETTING_KEYS = Object.keys(SETTINGS) as readonly (keyof Settings)[]

// One loosely-typed view for the loops below; the precise types live on SETTINGS.
const SPECS = SETTINGS as unknown as Record<keyof Settings, SettingSpec<unknown, unknown>>

/** What every setting is before the user chooses. */
export const DEFAULT_SETTINGS = Object.fromEntries(
  WORKSPACE_SETTING_KEYS.map((key) => [key, SPECS[key].default])
) as unknown as Settings

/**
 * Assemble the settings from what is stored: for each key, its default, then
 * (for a formerly-global key) the legacy global blob's value, then the
 * workspace row's. A value that is not usable is skipped, so the next source
 * down shows through; keys the schema does not declare never appear.
 */
export function resolveSettings(workspace: Blob, legacyGlobal: Blob = {}): Settings {
  const out: Record<string, unknown> = {}
  for (const key of WORKSPACE_SETTING_KEYS) {
    const s = SPECS[key]
    let value = s.default
    for (const source of s.legacyGlobal ? [legacyGlobal, workspace] : [workspace]) {
      const parsed = s.parse(source[key], source)
      if (parsed !== undefined) value = s.merge ? s.merge(value, parsed) : parsed
    }
    out[key] = value
  }
  return out as unknown as Settings
}

/**
 * The usable settings in an untrusted object (a workspace YAML's `settings`):
 * only declared keys, only values of the right shape, undefined when there is
 * nothing to keep. Alerts may come back as a subset of the toggles.
 */
export function parseSettings(raw: unknown): Partial<Settings> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Blob
  const out: Record<string, unknown> = {}
  for (const key of WORKSPACE_SETTING_KEYS) {
    const parsed = SPECS[key].parse(source[key], source)
    if (parsed !== undefined) out[key] = parsed
  }
  return Object.keys(out).length > 0 ? (out as Partial<Settings>) : undefined
}
