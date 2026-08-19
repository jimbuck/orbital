import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Settings as SettingsModel, ThemeMode } from '@shared/types'
import { useStore } from '@renderer/store'

import Settings from './Settings'

/**
 * Covers the theme segmented control where it actually lives, so the wiring
 * between SegmentedControl's keyboard contract and the shared setThemeMode()
 * write path is exercised end to end. SegmentedControl.test.tsx owns the ARIA
 * and key handling itself; this file owns "and it persists the right thing".
 */

/** The settings-bridge call every theme selection is expected to make. */
const setSettings = vi.fn(async (s: SettingsModel) => s)

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
    const written = setSettings.mock.calls[0][0]
    expect(written.theme).toBe('light')
    // The bridge takes a WHOLE Settings object, so anything not carried over
    // here would be wiped from the user's config by an arrow press.
    expect(written.defaultShell).toBe('pwsh.exe')
    expect(written.envSyncPatterns).toEqual(['**/.env'])
    // Applied immediately rather than at Save, so the theme previews live.
    expect(useStore.getState().settings?.theme).toBe('light')
    expect(themeRadios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('persists a clicked mode the same way', () => {
    seed('system')
    render(<Settings />)
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))

    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setSettings.mock.calls[0][0].theme).toBe('dark')
  })

  it('does not re-write settings when the already-active mode is picked', () => {
    seed('light')
    render(<Settings />)
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))

    expect(setSettings).not.toHaveBeenCalled()
  })
})
