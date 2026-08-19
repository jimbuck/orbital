import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, SettingsPatch } from '@shared/types'

/**
 * The settings write path, exercised against a stand-in for the DB.
 *
 * The bug these cover: Orbital runs one process per workspace, all sharing one
 * orbital.db, and the settings table's row is machine-global. When a writer sent
 * the whole global slice from its own in-memory copy, instance B changing the
 * theme rewrote defaultShell / alerts / debugLogging from B's snapshot — quietly
 * reverting whatever instance A had just changed.
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
/** Whether the stored global blob was re-read while a transaction was open. */
let readInsideTransaction: boolean
let inTransaction = false

const fakeDb = {
  prepare(sql: string) {
    if (sql.startsWith('SELECT value FROM settings')) {
      return {
        get: () => {
          if (inTransaction) readInsideTransaction = true
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
    getSettings: () => JSON.parse(JSON.stringify(workspaceRow)),
    updateSettings: (_workspaceId: string, settings: unknown) => {
      workspaceWrites += 1
      workspaceRow = JSON.parse(JSON.stringify(settings))
    }
  }
}))

const { getSettings, patchTouches, setSettings } = await import('./settings')

/** The keys actually present in the stored global blob. */
function storedGlobalKeys(): string[] {
  return globalRow === undefined ? [] : Object.keys(JSON.parse(globalRow))
}

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
    setSettings({ defaultShell: 'pwsh.exe', theme: 'dark', debugLogging: true })

    setSettings({ theme: 'light' })

    const after = getSettings()
    expect(after.theme).toBe('light')
    expect(after.defaultShell).toBe('pwsh.exe')
    expect(after.debugLogging).toBe(true)
    // Not merely re-derived from defaults on read — still on disk.
    expect(storedGlobalKeys().sort()).toEqual(['debugLogging', 'defaultShell', 'theme'])
  })

  it('does not touch the workspace row for a global-only patch, or vice versa', () => {
    setSettings({ periodicFetch: false, defaultShell: 'cmd.exe' })

    setSettings({ theme: 'light' })
    expect(workspaceRow.periodicFetch).toBe(false)

    setSettings({ periodicFetch: true })
    expect(getSettings().defaultShell).toBe('cmd.exe')
    expect(getSettings().periodicFetch).toBe(true)
  })

  it('drops keys that are not settings instead of persisting them', () => {
    // Types stop this at every call site; the runtime pick is the backstop for a
    // renderer that is a version ahead or behind the main process it is talking to.
    setSettings({ theme: 'light', notASetting: 'junk' } as SettingsPatch)

    expect(storedGlobalKeys()).toEqual(['theme'])
  })

  it('re-reads and merges inside a transaction that takes the write lock at BEGIN', () => {
    setSettings({ defaultShell: 'pwsh.exe' })
    readInsideTransaction = false

    setSettings({ theme: 'light' })

    // A read-modify-write outside the transaction would let two processes
    // interleave read/read/write/write and lose one of the two changes.
    expect(readInsideTransaction).toBe(true)
    // Deferred would take a read lock first and then have to upgrade it, which
    // fails with SQLITE_BUSY instead of waiting out the other process.
    expect(lastTransactionMode).toBe('immediate')
  })
})

describe('setSettings — concurrent instances', () => {
  it('does not revert another instance’s change when a stale window writes', () => {
    // The reported bug. Two windows are two processes sharing one DB, and this
    // settings row is machine-global. The other half of the fix — that a window
    // sends only the key its user touched, rather than its whole snapshot — is
    // asserted on the renderer side (Settings.test.tsx, TitleBar.test.tsx); this
    // is the half that has to hold once such a patch arrives.

    // Both instances start from the same settings.
    setSettings({ defaultShell: 'pwsh.exe', theme: 'dark' })
    const staleSnapshot: Settings = getSettings()

    // Instance A changes the default shell. B's snapshot is now stale.
    setSettings({ defaultShell: 'bash.exe' })
    expect(staleSnapshot.defaultShell).toBe('pwsh.exe')

    // Instance B's user clicks a theme — one click, no Save, and B never reloaded.
    setSettings({ theme: 'light' })

    const after = getSettings()
    expect(after.theme).toBe('light')
    // Before the fix, B's write handed A's change back to the stale 'pwsh.exe'.
    expect(after.defaultShell).toBe('bash.exe')
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
    setSettings({ theme: 'light' })
    transactionsRun = 0
    lastTransactionMode = null

    // Nothing here survives the pick, so this reduces to exactly the empty case.
    setSettings({ notASetting: 'junk' } as SettingsPatch)

    expect(transactionsRun).toBe(0)
    expect(lastTransactionMode).toBeNull()
    expect(storedGlobalKeys()).toEqual(['theme'])
  })
})

describe('setSettings — unrecognized keys in the stored workspace blob', () => {
  // The blob is the only copy of anything in it, and this build is not its only
  // writer: a second install (a worktree build beside the released app, or a
  // downgrade) may know keys this one does not. So they are kept in storage and
  // dropped on the way out, rather than deleted on the first write that happens
  // to touch the row.

  it('keeps them when merging a workspace patch', () => {
    workspaceRow = { periodicFetch: true, enabledAgents: ['claude'], fromANewerBuild: 42 }

    setSettings({ periodicFetch: false })

    expect(workspaceRow.periodicFetch).toBe(false)
    // Still what an older build reads its agent list from.
    expect(workspaceRow.enabledAgents).toEqual(['claude'])
    expect(workspaceRow.fromANewerBuild).toBe(42)
  })

  it('does not let them reach the assembled settings', () => {
    // defaultShell is a GLOBAL key: spreading the workspace blob raw would let a
    // stray copy of it here shadow the real, machine-global value.
    workspaceRow = { defaultShell: 'shadowed.exe', fromANewerBuild: 42 }

    setSettings({ defaultShell: 'pwsh.exe' })

    const s = getSettings()
    expect(s.defaultShell).toBe('pwsh.exe')
    expect((s as unknown as Record<string, unknown>).fromANewerBuild).toBeUndefined()
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
    expect(patchTouches({ theme: 'light' }, 'envSyncPatterns')).toBe(false)
    expect(patchTouches({ theme: 'light' }, 'periodicFetch')).toBe(false)
    expect(patchTouches({ theme: 'light' }, 'debugLogging')).toBe(false)
    expect(patchTouches({}, 'envSyncPatterns')).toBe(false)
    // Explicitly undefined means absent, the same rule the write path picks by.
    expect(patchTouches({ debugLogging: undefined }, 'debugLogging')).toBe(false)
  })
})
