import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Settings, ThemeMode } from '@shared/types'
import { useStore } from '@renderer/store'

// TabStrip is imported only for its serverLabel helper, but loading the real
// module drags in the tab bodies (xterm, shiki) — stub it so this stays a
// titlebar test.
vi.mock('./body/TabStrip', () => ({ serverLabel: (url: string) => url }))

import TitleBar from './TitleBar'

/** The settings-bridge call every theme click is expected to make. */
const setSettings = vi.fn(async (s: Settings) => s)

/**
 * jsdom's matchMedia always reports matches: false, which would pin the OS
 * preference to light forever. This stub lets a test say "the OS is in dark
 * mode", so what useSystemTheme reads — and the hint built from it — is actually
 * observable, including when it disagrees with the pinned mode.
 */
function stubSystemDark(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-color-scheme: dark') ? dark : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
}

function makeSettings(theme: ThemeMode): Settings {
  return {
    defaultShell: 'pwsh.exe',
    alerts: { indicator: true, sound: true, taskbarBadge: false, taskbarFlash: false },
    envSyncPatterns: ['**/.env'],
    periodicFetch: true,
    debugLogging: false,
    agents: [],
    theme
  } as unknown as Settings
}

function seed(theme: ThemeMode): void {
  useStore.setState({
    projects: [],
    worktrees: [],
    tasks: [],
    devServers: {},
    workspace: null,
    activeProjectId: null,
    activeWorktreeId: null,
    alertCount: 0,
    updateStatus: { phase: 'idle' },
    settings: makeSettings(theme)
  } as unknown as Parameters<typeof useStore.setState>[0])
}

/** Open the View dropdown and hand back its menu element. */
function openViewMenu(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'View' }))
  return screen.getByRole('menu')
}

/** One theme row by its leading label ('System' also carries an OS-preference hint). */
function themeItem(menu: HTMLElement, label: 'System' | 'Light' | 'Dark'): HTMLElement {
  return within(menu).getByRole('menuitemradio', { name: new RegExp(`^${label}`) })
}

beforeEach(() => {
  setSettings.mockClear()
  stubSystemDark(false)
  vi.stubGlobal('orbital', { setSettings, toggleDevTools: vi.fn(), windowClose: vi.fn() })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TitleBar View menu — theme', () => {
  it('offers exactly System / Light / Dark, in that order', () => {
    seed('dark')
    render(<TitleBar />)
    const radios = within(openViewMenu()).getAllByRole('menuitemradio')

    expect(radios).toHaveLength(3)
    expect(radios.map((r) => r.textContent?.startsWith('System') ?? false)).toEqual([true, false, false])
    expect(radios[1].textContent).toContain('Light')
    expect(radios[2].textContent).toContain('Dark')
  })

  it('marks the persisted mode as checked, not the theme it resolves to', () => {
    // 'system' resolving to dark must still show System checked — marking Dark
    // would claim the user had pinned the theme when they had not.
    stubSystemDark(true)
    seed('system')
    render(<TitleBar />)
    const menu = openViewMenu()

    expect(themeItem(menu, 'System').getAttribute('aria-checked')).toBe('true')
    expect(themeItem(menu, 'Dark').getAttribute('aria-checked')).toBe('false')
    expect(themeItem(menu, 'Light').getAttribute('aria-checked')).toBe('false')
  })

  it('annotates System with the OS preference', () => {
    stubSystemDark(true)
    seed('system')
    render(<TitleBar />)
    expect(themeItem(openViewMenu(), 'System').textContent).toContain('dark')

    cleanup()
    stubSystemDark(false)
    seed('system')
    render(<TitleBar />)
    expect(themeItem(openViewMenu(), 'System').textContent).toContain('light')
  })

  it('keeps the System hint on the OS preference when a mode is pinned', () => {
    // The case the hint exists for, and the one seeding only 'system' can never
    // catch: with a mode pinned, "what the app is showing" and "what the OS
    // wants" disagree, and the hint must report the OS. A hint sourced from the
    // applied theme reads back the user's own pin — telling someone on a light
    // OS who pinned Dark that switching to System means dark, which is exactly
    // backwards, and wrong precisely when they are asking.
    stubSystemDark(false)
    seed('dark')
    render(<TitleBar />)
    const hinted = themeItem(openViewMenu(), 'System').textContent
    expect(hinted).toContain('light')
    expect(hinted).not.toContain('dark')

    cleanup()
    stubSystemDark(true)
    seed('light')
    render(<TitleBar />)
    expect(themeItem(openViewMenu(), 'System').textContent).toContain('dark')
  })

  it('persists the picked mode through the settings bridge, leaving the rest intact', () => {
    seed('dark')
    render(<TitleBar />)
    fireEvent.click(themeItem(openViewMenu(), 'Light'))

    expect(setSettings).toHaveBeenCalledTimes(1)
    const written = setSettings.mock.calls[0][0]
    expect(written.theme).toBe('light')
    // The bridge takes a WHOLE Settings object, so anything not carried over here
    // would be wiped from the user's config by a theme click.
    expect(written.defaultShell).toBe('pwsh.exe')
    expect(written.envSyncPatterns).toEqual(['**/.env'])
    // Applied to the store on the click as well, so the app re-themes immediately
    // rather than an IPC round trip later.
    expect(useStore.getState().settings?.theme).toBe('light')
  })

  it('does not re-write settings when the already-active mode is picked', () => {
    seed('light')
    render(<TitleBar />)
    fireEvent.click(themeItem(openViewMenu(), 'Light'))

    expect(setSettings).not.toHaveBeenCalled()
  })

  it('leaves the ordinary commands as plain menuitems', () => {
    // The check gutter is opt-in per item; a regression that gave every row an
    // aria-checked would make the whole View menu read as one radio group.
    seed('dark')
    render(<TitleBar />)
    const reload = within(openViewMenu()).getByRole('menuitem', { name: 'Reload' })

    expect(reload.getAttribute('aria-checked')).toBeNull()
  })
})
