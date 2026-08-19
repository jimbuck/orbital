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
    // A fresh copy per read: the service deletes a legacy key off what it gets
    // back, and a shared object would let that mutate the "stored" row.
    getSettings: () => JSON.parse(JSON.stringify(workspaceRow)),
    updateSettings: (_workspaceId: string, settings: unknown) => {
      workspaceRow = JSON.parse(JSON.stringify(settings))
    }
  }
}))

const { getSettings, setSettings } = await import('./settings')

/** The keys actually present in the stored global blob. */
function storedGlobalKeys(): string[] {
  return globalRow === undefined ? [] : Object.keys(JSON.parse(globalRow))
}

beforeEach(() => {
  globalRow = undefined
  workspaceRow = {}
  lastTransactionMode = null
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
