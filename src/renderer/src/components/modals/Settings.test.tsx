import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Settings as SettingsModel, SettingsPatch, ThemeMode } from '@shared/types'
import { useStore } from '@renderer/store'

import Settings from './Settings'

/**
 * Covers the theme segmented control where it actually lives, so the wiring
 * between SegmentedControl's keyboard contract and the shared setThemeMode()
 * write path is exercised end to end. SegmentedControl.test.tsx owns the ARIA
 * and key handling itself; this file owns "and it persists the right thing".
 */

/** The settings-bridge call every theme selection is expected to make. */
const setSettings = vi.fn(async (patch: SettingsPatch) => patch as SettingsModel)

function makeSettings(theme: ThemeMode): SettingsModel {
  return {
    defaultShell: 'pwsh.exe',
    alerts: { indicator: true, sound: true, taskbarBadge: false, taskbarFlash: false },
    envSyncPatterns: ['**/.env'],
    periodicFetch: true,
    debugLogging: false,
    // No agent profiles: the profile cards each stat the disk on mount, and this
    // test is about the Appearance section.
    agents: [],
    theme
  } as unknown as SettingsModel
}

function seed(theme: ThemeMode): void {
  useStore.setState({
    projects: [],
    worktrees: [],
    activeProjectId: null,
    activeWorktreeId: null,
    workspace: null,
    settings: makeSettings(theme)
  } as unknown as Parameters<typeof useStore.setState>[0])
}

/** The Appearance theme control and its three options, in rendered order. */
function themeRadios(): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: 'Theme' })).getAllByRole('radio')
}

beforeEach(() => {
  setSettings.mockClear()
  vi.stubGlobal('orbital', { setSettings, inspectProfileDir: vi.fn(async () => null), openLogFolder: vi.fn() })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings — theme control', () => {
  it('offers System / Light / Dark and checks the persisted mode', () => {
    seed('light')
    render(<Settings />)

    expect(themeRadios().map((r) => r.textContent)).toEqual(['System', 'Light', 'Dark'])
    expect(themeRadios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('gives the group a single tab stop on the checked option', () => {
    seed('dark')
    render(<Settings />)

    expect(themeRadios().map((r) => r.tabIndex)).toEqual([-1, -1, 0])
  })

  it('persists the mode an arrow key lands on, leaving the rest of settings intact', () => {
    seed('system')
    render(<Settings />)
    fireEvent.keyDown(themeRadios()[0], { key: 'ArrowRight' })

    expect(setSettings).toHaveBeenCalledTimes(1)
    // Exactly one key. The global settings slice is shared with every other
    // workspace instance, so an arrow press that also wrote this window's copy of
    // defaultShell / alerts / debugLogging would revert whatever another window
    // had just changed in them.
    expect(setSettings.mock.calls[0][0]).toEqual({ theme: 'light' })
    // Applied immediately rather than at Save, so the theme previews live.
    expect(useStore.getState().settings?.theme).toBe('light')
    expect(themeRadios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('persists a clicked mode the same way', () => {
    seed('system')
    render(<Settings />)
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))

    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setSettings.mock.calls[0][0]).toEqual({ theme: 'dark' })
  })

  it('does not re-write settings when the already-active mode is picked', () => {
    seed('light')
    render(<Settings />)
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))

    expect(setSettings).not.toHaveBeenCalled()
  })

  it('says the theme applies immediately, next to the control and to assistive tech', () => {
    // Every other field in this modal is committed on Save and discarded on
    // Cancel; theme is not. Nothing about a segmented control conveys that, so
    // the note is the only thing standing between a user and picking Dark,
    // cancelling, and finding the app still dark.
    seed('dark')
    render(<Settings />)

    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    const hintId = group.getAttribute('aria-describedby')
    expect(hintId).toBeTruthy()
    const hint = document.getElementById(hintId as string)
    expect(hint?.textContent).toMatch(/applies immediately/i)
    // In the theme row itself rather than floating elsewhere in the modal.
    expect(group.parentElement?.contains(hint)).toBe(true)
    // Muted-hint styling, the same treatment the alert descriptions use — this
    // row should read as a quiet aside, not a warning.
    expect(hint?.className).toContain('text-dim')
  })
})

describe('Settings — Save', () => {
  it('writes only the fields the user actually changed', async () => {
    // The modal seeds its working copies when it opens and can sit open for a
    // long time. Saving the untouched ones back would push that opening snapshot
    // over anything another workspace instance changed in the meantime.
    seed('dark')
    render(<Settings />)

    fireEvent.change(screen.getByLabelText('Default shell'), { target: { value: 'cmd.exe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1))

    expect(setSettings.mock.calls[0][0]).toEqual({ defaultShell: 'cmd.exe' })
  })

  it('writes nothing at all when Save is pressed with no edits', async () => {
    seed('dark')
    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1))

    // An empty patch: main skips both rows entirely, so an idle Save cannot
    // disturb another instance's settings at all.
    expect(setSettings.mock.calls[0][0]).toEqual({})
  })
})
