import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Worktree } from '@shared/types'
import { useStore } from '@renderer/store'

import WorktreeRow from './WorktreeRow'

/**
 * The linked-worktree row's context menu, and specifically the env-file
 * resync: the one deliberate way a worktree's synced files change after
 * creation, now that there is no watcher. It overwrites, so it has to confirm
 * first and report what it did.
 */

let bridge: Record<string, ReturnType<typeof vi.fn>>

const worktree: Worktree = {
  id: 'w-1',
  projectId: 'p1',
  kind: 'linked',
  name: 'feature',
  path: 'C:/repo/.orbital-worktrees/repo/feature',
  branch: 'feat/login',
  status: 'idle',
  taskId: null,
  layout: { type: 'pane', paneId: 'pane-1' },
  createdAt: 0,
  panes: []
}

beforeEach(() => {
  bridge = {
    syncWorktreeEnv: vi.fn(async () => ({ copied: ['.env', '.claude/settings.local.json'] })),
    clearWorktreeStatus: vi.fn(async () => undefined),
    renameWorktree: vi.fn(async () => undefined),
    removeWorktree: vi.fn(async () => undefined)
  }
  vi.stubGlobal('orbital', bridge)
  useStore.setState({
    projects: [],
    worktrees: [worktree],
    tasks: [],
    activeProjectId: 'p1',
    activeWorktreeId: null,
    settingUpWorktrees: []
  } as unknown as Parameters<typeof useStore.setState>[0])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function openMenu(): void {
  render(<WorktreeRow worktree={worktree} />)
  fireEvent.contextMenu(screen.getByRole('button', { name: /feature/ }))
}

const items = (): string[] => screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')

describe('worktree context menu — sync env files', () => {
  it('offers the resync between the OS hand-offs and Close', () => {
    openMenu()
    expect(items()).toEqual([
      'Rename',
      'Clear Status',
      'Open in Explorer',
      'Open in External Terminal',
      'Sync env files from rootoverwrites',
      'Close Worktreekeep worktree',
      'Delete worktree'
    ])
  })

  it('confirms before copying anything, since the copy overwrites', () => {
    openMenu()
    fireEvent.click(screen.getByText('Sync env files from root'))
    expect(bridge.syncWorktreeEnv).not.toHaveBeenCalled()
    expect(screen.getByText('Copy env files from the root checkout?')).toBeTruthy()
    expect(screen.getByText(/overwritten with the root/)).toBeTruthy()
  })

  it('syncs on confirm and reports how many files were copied', async () => {
    openMenu()
    fireEvent.click(screen.getByText('Sync env files from root'))
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    expect(bridge.syncWorktreeEnv).toHaveBeenCalledWith(worktree.id)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('Copied 2 env files from the root checkout.')).toBeTruthy()
  })

  it('says so when nothing matched', async () => {
    bridge.syncWorktreeEnv.mockResolvedValueOnce({ copied: [] })
    openMenu()
    fireEvent.click(screen.getByText('Sync env files from root'))
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('No env files matched the sync patterns.')).toBeTruthy()
  })

  it('keeps the confirm open with the reason when the sync fails', async () => {
    bridge.syncWorktreeEnv.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    openMenu()
    fireEvent.click(screen.getByText('Sync env files from root'))
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('EACCES: permission denied')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Sync' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('returns to the item list when the confirm is cancelled', () => {
    openMenu()
    fireEvent.click(screen.getByText('Sync env files from root'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Rename')).toBeTruthy()
    expect(bridge.syncWorktreeEnv).not.toHaveBeenCalled()
  })
})
