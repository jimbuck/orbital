import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, SettingsPatch } from '@shared/types'

/**
 * The settings write path, exercised against a stand-in for the DB.
 *
 * Every setting lives on the workspace's row. The machine-global settings row is
 * where some of them used to live, so it is still read as a fallback, but never
 * written: older builds sharing the DB still own it.
 *
 * better-sqlite3 is a native addon built against Electron's ABI and cannot load
 * under plain Node, so the store below stands in for it. That is not a loss: a
 * real file DB would not make the interleaving any more real, and the fake can
 * assert the things that actually matter here — that the re-read happens INSIDE
 * the transaction, and that the transaction takes the write lock up front.
 */

/** The `settings` row's JSON blob, or undefined when the row does not exist. */
let globalRow: string | undefined
/** The active workspace's settings blob. */
let workspaceRow: Record<string, unknown>
/** How the last transaction was opened — the write lock must be taken at BEGIN. */
let lastTransactionMode: string | null
/** Transactions actually entered, so a no-op write can assert it took no lock. */
let transactionsRun: number
/** Writes to the workspace row, likewise. */
let workspaceWrites: number
/** Whether the workspace row was re-read while a transaction was open. */
let readInsideTransaction: boolean
let inTransaction = false

const fakeDb = {
  prepare(sql: string) {
    if (sql.startsWith('SELECT value FROM settings')) {
      return {
        get: () => {
          return globalRow === undefined ? undefined : { value: globalRow }
        }
      }
    }
    if (sql.startsWith('INSERT INTO settings')) {
      return {
        run: (value: string) => {
          globalRow = value
        }
      }
    }
    throw new Error(`unexpected SQL in settings service: ${sql}`)
  },
  transaction(fn: () => void) {
    const run = (mode: string) => (): void => {
      lastTransactionMode = mode
      transactionsRun += 1
      inTransaction = true
      try {
        fn()
      } finally {
        inTransaction = false
      }
    }
    return Object.assign(run('deferred'), {
      immediate: run('immediate'),
      deferred: run('deferred'),
      exclusive: run('exclusive')
    })
  }
} as unknown as Database.Database

// Factory mocks, so the real modules (and better-sqlite3 with them) are never
// imported at all.
vi.mock('../db/database', () => ({ getDb: () => fakeDb }))
vi.mock('../db/repositories', () => ({
  requireWorkspaceId: () => 'ws-1',
  workspaces: {
    // A fresh copy per read, so nothing the service does to what it gets back can
    // reach into the "stored" row behind its own write.
    getSettings: () => {
      if (inTransaction) readInsideTransaction = true
      return JSON.parse(JSON.stringify(workspaceRow))
    },
    updateSettings: (_workspaceId: string, settings: unknown) => {
      workspaceWrites += 1
      workspaceRow = JSON.parse(JSON.stringify(settings))
    }
  }
}))

const { getSettings, patchTouches, setSettings } = await import('./settings')

beforeEach(() => {
  globalRow = undefined
  workspaceRow = {}
  lastTransactionMode = null
  transactionsRun = 0
  workspaceWrites = 0
  readInsideTransaction = false
  inTransaction = false
})

describe('setSettings — partial writes', () => {
  it('leaves stored keys the patch does not name untouched', () => {
    setSettings({ defaultShell: 'pwsh.exe', periodicFetch: false, debugLogging: true })

    setSettings({ defaultShell: 'bash.exe' })

    const after = getSettings()
    expect(after.defaultShell).toBe('bash.exe')
    expect(after.periodicFetch).toBe(false)
    expect(after.debugLogging).toBe(true)
    // Not merely re-derived from defaults on read — still on disk.
    expect(Object.keys(workspaceRow).sort()).toEqual(['debugLogging', 'defaultShell', 'periodicFetch'])
  })

  it('writes every setting to the workspace row and never to the global one', () => {
    setSettings({
      defaultShell: 'pwsh.exe',
      alerts: { indicator: false, sound: true, taskbarBadge: true, taskbarFlash: true },
      debugLogging: true,
      defaultOpenAction: 'left',
      theme: 'nord',
      fontLigatures: false
    })
    expect(workspaceRow.defaultShell).toBe('pwsh.exe')
    expect(workspaceRow.defaultOpenAction).toBe('left')
    expect(globalRow).toBeUndefined()
  })

  it('drops keys that are not settings instead of persisting them', () => {
    // Types catch this only where the patch is an object literal — excess-property
    // checking does not survive assignment to a variable — so the runtime pick is
    // the real backstop, both for a stray key that type-checked its way through and
    // for a renderer a version ahead of or behind the main process it talks to.
    setSettings({ defaultShell: 'pwsh.exe', notASetting: 'junk' } as SettingsPatch)

    expect(Object.keys(workspaceRow)).toEqual(['defaultShell'])
  })

  it('re-reads and merges inside a transaction that takes the write lock at BEGIN', () => {
    setSettings({ defaultShell: 'pwsh.exe' })
    // A read-modify-write outside the transaction would let two writers
    // interleave read/read/write/write and lose one of the two changes.
    expect(readInsideTransaction).toBe(true)
    // Deferred would take a read lock first and then have to upgrade it, which
    // fails with SQLITE_BUSY instead of waiting out another instance.
    expect(lastTransactionMode).toBe('immediate')
  })
})

describe('setSettings — stale snapshots', () => {
  it('does not revert a change made after the writer took its snapshot', () => {
    // The Settings modal holds a snapshot while the View menu writes a theme.
    // Because each writer sends only the key its user touched, the later write
    // of an unrelated key cannot hand the theme back to the stale value.
    setSettings({ defaultShell: 'pwsh.exe', theme: 'dark' })
    const staleSnapshot: Settings = getSettings()

    setSettings({ theme: 'nord' })
    expect(staleSnapshot.theme).toBe('dark')

    setSettings({ defaultShell: 'bash.exe' })

    const after = getSettings()
    expect(after.defaultShell).toBe('bash.exe')
    expect(after.theme).toBe('nord')
  })
})

describe('setSettings — patches with nothing to write', () => {
  // An IMMEDIATE transaction takes the write lock at BEGIN, and the DB is shared
  // by every running instance — so opening one for a write that never comes
  // stalls the other instances for no reason. Empty patches are routine, not
  // exotic: an untouched Save sends {} by design.

  it('opens no transaction at all for an empty patch', () => {
    setSettings({ defaultShell: 'pwsh.exe', periodicFetch: false })
    transactionsRun = 0
    workspaceWrites = 0
    lastTransactionMode = null

    const after = setSettings({})

    expect(transactionsRun).toBe(0)
    expect(lastTransactionMode).toBeNull()
    expect(workspaceWrites).toBe(0)
    // Still answers with the current settings — a no-op write, not a failed one.
    expect(after.defaultShell).toBe('pwsh.exe')
    expect(after.periodicFetch).toBe(false)
  })

  it('opens no transaction for a patch of only unrecognized keys', () => {
    setSettings({ notASetting: 'junk' } as SettingsPatch)

    expect(transactionsRun).toBe(0)
    expect(workspaceWrites).toBe(0)
  })
})

describe('setSettings — unrecognized keys in the stored workspace blob', () => {
  // The blob is the only copy of anything in it, and this build is not its only
  // writer: a second install (a worktree build beside the released app, or a
  // downgrade) may know keys this one does not, and zoom.ts keeps its level here
  // outside Settings. So they are kept in storage and dropped on the way out,
  // rather than deleted on the first write that happens to touch the row.

  it('keeps them when merging a patch', () => {
    workspaceRow = { periodicFetch: true, enabledAgents: ['claude'], zoomLevel: 2, fromANewerBuild: 42 }

    setSettings({ periodicFetch: false })

    expect(workspaceRow.periodicFetch).toBe(false)
    // Still what an older build reads its agent list from.
    expect(workspaceRow.enabledAgents).toEqual(['claude'])
    expect(workspaceRow.zoomLevel).toBe(2)
    expect(workspaceRow.fromANewerBuild).toBe(42)
  })

  it('does not let them reach the assembled settings', () => {
    workspaceRow = { fromANewerBuild: 42, zoomLevel: 2 }

    const s = getSettings() as unknown as Record<string, unknown>
    expect(s.fromANewerBuild).toBeUndefined()
    expect(s.zoomLevel).toBeUndefined()
  })
})

describe('the legacy global row', () => {
  // Where defaultShell, alerts, debugLogging, the theme, ligatures and the
  // default open action used to live. Moving them must not reset anyone, so a
  // workspace that never set one of them still reads it from here.

  it('supplies every formerly-global setting a workspace has not set', () => {
    globalRow = JSON.stringify({
      defaultShell: 'pwsh.exe',
      alerts: { sound: false },
      debugLogging: true,
      theme: 'dracula',
      systemLightTheme: 'github-light',
      fontLigatures: false,
      defaultOpenAction: 'left'
    })

    const s = getSettings()
    expect(s.defaultShell).toBe('pwsh.exe')
    // Deep-merged with the defaults, like a workspace's own alerts.
    expect(s.alerts).toEqual({ indicator: true, sound: false, taskbarBadge: true, taskbarFlash: true })
    expect(s.debugLogging).toBe(true)
    expect(s.theme).toBe('dracula')
    expect(s.systemLightTheme).toBe('github-light')
    expect(s.fontLigatures).toBe(false)
    expect(s.defaultOpenAction).toBe('left')
  })

  it('loses to the workspace once it sets its own, and is left untouched', () => {
    globalRow = JSON.stringify({ defaultShell: 'pwsh.exe', theme: 'dracula' })

    setSettings({ defaultShell: 'bash.exe', theme: 'light' })

    expect(getSettings().defaultShell).toBe('bash.exe')
    expect(getSettings().theme).toBe('light')
    // Other workspaces, and older builds, still read the old values.
    expect(JSON.parse(globalRow as string)).toEqual({ defaultShell: 'pwsh.exe', theme: 'dracula' })
  })

  it('does not let a pre-split copy of an always-workspace key through', () => {
    // Blobs from before the workspace split also carried these; they were seeded
    // into the first workspace and must not leak into every other one.
    globalRow = JSON.stringify({ envSyncPatterns: ['leftover'], periodicFetch: false, fromANewerBuild: 42 })

    const s = getSettings()
    expect(s.envSyncPatterns).not.toEqual(['leftover'])
    expect(s.periodicFetch).toBe(true)
    expect((s as unknown as Record<string, unknown>).fromANewerBuild).toBeUndefined()
  })

  it('tolerates an unreadable row', () => {
    globalRow = 'not json'
    expect(getSettings().defaultShell).toBe('')
  })
})

describe('patchTouches', () => {
  // What ipc.ts gates its side effects on, so a patch that cannot affect a
  // subsystem does not restart it — { theme } used to stop and restart the
  // env-sync FS watcher of every project. The handler itself needs an Electron
  // main process to import, so the predicate it turns on is what is asserted here.

  it('is true only for the keys the patch actually names', () => {
    expect(patchTouches({ envSyncPatterns: ['.env'] }, 'envSyncPatterns')).toBe(true)
    expect(patchTouches({ periodicFetch: false }, 'periodicFetch')).toBe(true)
    // A false/empty value is still a change the caller made.
    expect(patchTouches({ debugLogging: false }, 'debugLogging')).toBe(true)
  })

  it('is false for a key the patch leaves out, including an empty patch', () => {
    expect(patchTouches({ defaultOpenAction: 'left' }, 'envSyncPatterns')).toBe(false)
    expect(patchTouches({ defaultOpenAction: 'left' }, 'periodicFetch')).toBe(false)
    expect(patchTouches({ defaultOpenAction: 'left' }, 'debugLogging')).toBe(false)
    expect(patchTouches({}, 'envSyncPatterns')).toBe(false)
    // Explicitly undefined means absent, the same rule the write path picks by.
    expect(patchTouches({ debugLogging: undefined }, 'debugLogging')).toBe(false)
  })
})

describe('accentColor', () => {
  it('lives on the workspace row and defaults to null', () => {
    expect(getSettings().accentColor).toBeNull()
    setSettings({ accentColor: '#8b7cf6' })
    expect(workspaceRow.accentColor).toBe('#8b7cf6')
    expect(globalRow).toBeUndefined()
    expect(getSettings().accentColor).toBe('#8b7cf6')
  })

  it('clears with an explicit null rather than treating it as absent', () => {
    setSettings({ accentColor: '#8b7cf6' })
    setSettings({ accentColor: null })
    expect(workspaceRow.accentColor).toBeNull()
    expect(getSettings().accentColor).toBeNull()
  })

  it('reads a hand-edited value that is not a colour as no accent', () => {
    workspaceRow = { accentColor: 'hotpink' }
    expect(getSettings().accentColor).toBeNull()
    workspaceRow = { accentColor: 'F06A8A' }
    expect(getSettings().accentColor).toBe('#f06a8a')
  })
})

describe('the theme', () => {
  it('lives on the workspace row', () => {
    expect(getSettings().theme).toBe('dark')
    setSettings({ theme: 'nord' })
    expect(workspaceRow.theme).toBe('nord')
    expect(globalRow).toBeUndefined()
    expect(getSettings().theme).toBe('nord')
  })

  it('falls back to the machine-wide theme for a workspace that never set one', () => {
    // Where the theme lived before it was per-workspace. Moving it must not
    // reset anyone's look, so a workspace without its own keeps this one.
    globalRow = JSON.stringify({ theme: 'dracula', systemLightTheme: 'github-light' })
    expect(getSettings().theme).toBe('dracula')
    expect(getSettings().systemLightTheme).toBe('github-light')

    // Once the workspace picks its own, that wins, and the global is left alone
    // for other workspaces (and older builds) still reading it.
    setSettings({ theme: 'light' })
    expect(getSettings().theme).toBe('light')
    expect(JSON.parse(globalRow as string).theme).toBe('dracula')
  })

  it('falls back to the default for an id this build does not ship', () => {
    workspaceRow = { theme: 'a-newer-builds-theme' }
    expect(getSettings().theme).toBe('dark')
    workspaceRow = { theme: 'system' }
    expect(getSettings().theme).toBe('system')
  })
})

describe('the system theme pair', () => {
  it('defaults to the built-ins and lives on the workspace row', () => {
    expect(getSettings().systemDarkTheme).toBe('dark')
    expect(getSettings().systemLightTheme).toBe('light')

    setSettings({ systemDarkTheme: 'dracula' })
    expect(getSettings().systemDarkTheme).toBe('dracula')
    // Scoped with the theme: the pair is what the workspace's 'system' means.
    expect(workspaceRow.systemDarkTheme).toBe('dracula')
    expect(globalRow).toBeUndefined()
  })

  it('rejects a stored half that names a theme of the wrong appearance', () => {
    // The failure this guards: a dark-OS slot holding a light theme would make
    // System hand you a white window at night — the one thing it exists to
    // avoid. A hand edit, an import or another build can all produce it.
    workspaceRow = { systemDarkTheme: 'github-light', systemLightTheme: 'nord' }
    expect(getSettings().systemDarkTheme).toBe('dark')
    expect(getSettings().systemLightTheme).toBe('light')
  })

  it('falls back for an id this build does not ship', () => {
    workspaceRow = { systemDarkTheme: 'a-newer-builds-theme' }
    expect(getSettings().systemDarkTheme).toBe('dark')
  })
})

describe('fontLigatures', () => {
  it('defaults on and lives on the workspace row', () => {
    // The font's own look, and what every install has had until now.
    expect(getSettings().fontLigatures).toBe(true)

    setSettings({ fontLigatures: false })
    expect(getSettings().fontLigatures).toBe(false)
    expect(workspaceRow.fontLigatures).toBe(false)
    expect(globalRow).toBeUndefined()
  })

  it('falls back to the machine-wide value for a workspace that never set one', () => {
    globalRow = JSON.stringify({ fontLigatures: false })
    expect(getSettings().fontLigatures).toBe(false)

    setSettings({ fontLigatures: true })
    expect(getSettings().fontLigatures).toBe(true)
    expect(JSON.parse(globalRow as string).fontLigatures).toBe(false)
  })
})
