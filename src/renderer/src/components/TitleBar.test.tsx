import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Settings, SettingsPatch, ThemeMode } from '@shared/types'
import { useStore } from '@renderer/store'

// TabStrip is imported only for its serverLabel helper, but loading the real
// module drags in the tab bodies (xterm, shiki) — stub it so this stays a
// titlebar test.
vi.mock('./body/TabStrip', () => ({ serverLabel: (url: string) => url }))

import TitleBar from './TitleBar'

/** The settings-bridge call every theme click is expected to make. */
const setSettings = vi.fn(async (patch: SettingsPatch) => patch as Settings)

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

/** What 'system' resolves to, when a test cares which half it lands on. */
interface SystemPair {
  systemDarkTheme: string
  systemLightTheme: string
}

function makeSettings(theme: ThemeMode, pair?: SystemPair): Settings {
  return {
    defaultShell: 'pwsh.exe',
    alerts: { indicator: true, sound: true, taskbarBadge: false, taskbarFlash: false },
    envSyncPatterns: ['**/.env'],
    periodicFetch: true,
    debugLogging: false,
    agents: [],
    theme,
    ...pair
  } as unknown as Settings
}

function seed(theme: ThemeMode, pair?: SystemPair): void {
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
    zoomFactor: 1,
    settings: makeSettings(theme, pair)
  } as unknown as Parameters<typeof useStore.setState>[0])
}

/** Open the View dropdown and hand back its menu element. */
function openViewMenu(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'View' }))
  return screen.getByRole('menu')
}

/** One theme row by its leading label ('System' also carries an OS-preference hint). */
function themeItem(menu: HTMLElement, label: 'System' | 'Orbital Light' | 'Orbital Dark'): HTMLElement {
  return within(menu).getByRole('menuitemradio', { name: new RegExp(`^${label}`) })
}

beforeEach(() => {
  setSettings.mockClear()
  stubSystemDark(false)
  vi.stubGlobal('orbital', {
    setSettings,
    toggleDevTools: vi.fn(),
    windowClose: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TitleBar View menu — theme', () => {
  it('offers System and the two built-ins, then a way to the rest', () => {
    // The menu is a shortcut, not the gallery: the three someone flips between
    // day to day, with the other themes one click away in Settings.
    seed('dark')
    render(<TitleBar />)
    const menu = openViewMenu()
    const radios = within(menu).getAllByRole('menuitemradio')

    expect(radios).toHaveLength(3)
    expect(radios.map((r) => r.textContent?.startsWith('System') ?? false)).toEqual([true, false, false])
    expect(radios[1].textContent).toContain('Orbital Dark')
    expect(radios[2].textContent).toContain('Orbital Light')
    expect(within(menu).getByRole('menuitem', { name: 'More Themes…' })).toBeTruthy()
  })

  it('names the active theme in the group heading, the way Zoom names its scale', () => {
    // With twenty themes in the gallery, a menu listing three of them has to
    // answer "what am I on?" for the other seventeen.
    seed('dracula')
    render(<TitleBar />)
    expect(within(openViewMenu()).getByText(/^Theme · Dracula$/)).toBeTruthy()
  })

  it('marks the persisted mode as checked, not the theme it resolves to', () => {
    // 'system' resolving to dark must still show System checked — marking Dark
    // would claim the user had pinned the theme when they had not.
    stubSystemDark(true)
    seed('system')
    render(<TitleBar />)
    const menu = openViewMenu()

    expect(themeItem(menu, 'System').getAttribute('aria-checked')).toBe('true')
    expect(themeItem(menu, 'Orbital Dark').getAttribute('aria-checked')).toBe('false')
    expect(themeItem(menu, 'Orbital Light').getAttribute('aria-checked')).toBe('false')
  })

  it('annotates System with the theme the OS preference would select', () => {
    // Not the word "dark"/"light" but the theme itself: System is a pair now,
    // and the row has to say which half this OS is asking for.
    stubSystemDark(true)
    seed('system', { systemDarkTheme: 'dracula', systemLightTheme: 'github-light' })
    render(<TitleBar />)
    expect(themeItem(openViewMenu(), 'System').textContent).toContain('Dracula')

    cleanup()
    stubSystemDark(false)
    seed('system', { systemDarkTheme: 'dracula', systemLightTheme: 'github-light' })
    render(<TitleBar />)
    expect(themeItem(openViewMenu(), 'System').textContent).toContain('GitHub Light')
  })

  it('falls back to the built-ins when the pair has never been set', () => {
    stubSystemDark(true)
    seed('system')
    render(<TitleBar />)
    expect(themeItem(openViewMenu(), 'System').textContent).toContain('Orbital Dark')
  })

  it('keeps the System hint on the OS preference when a theme is pinned', () => {
    // The case the hint exists for, and the one seeding only 'system' can never
    // catch: with a theme pinned, "what the app is showing" and "what the OS
    // wants" disagree, and the hint must report the OS. A hint sourced from the
    // applied theme reads back the user's own pin — telling someone on a light
    // OS who pinned Dracula that switching to System means Dracula, which is
    // exactly backwards, and wrong precisely when they are asking.
    stubSystemDark(false)
    seed('dracula', { systemDarkTheme: 'dracula', systemLightTheme: 'github-light' })
    render(<TitleBar />)
    const hinted = themeItem(openViewMenu(), 'System').textContent
    expect(hinted).toContain('GitHub Light')
    expect(hinted).not.toContain('Dracula')

    cleanup()
    stubSystemDark(true)
    seed('light', { systemDarkTheme: 'nord', systemLightTheme: 'light' })
    render(<TitleBar />)
    expect(themeItem(openViewMenu(), 'System').textContent).toContain('Nord')
  })

  it('persists the picked mode through the settings bridge, leaving the rest intact', () => {
    seed('dark')
    render(<TitleBar />)
    fireEvent.click(themeItem(openViewMenu(), 'Orbital Light'))

    expect(setSettings).toHaveBeenCalledTimes(1)
    // Exactly one key: the rest of the settings are shared with every other
    // workspace instance, and a menu click carrying this window's stale copy of
    // them would revert whatever another window had just changed.
    expect(setSettings.mock.calls[0][0]).toEqual({ theme: 'light' })
    // Applied to the store on the click as well, so the app re-themes immediately
    // rather than an IPC round trip later.
    expect(useStore.getState().settings?.theme).toBe('light')
  })

  it('does not re-write settings when the already-active mode is picked', () => {
    seed('light')
    render(<TitleBar />)
    fireEvent.click(themeItem(openViewMenu(), 'Orbital Light'))

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

describe('TitleBar View menu — zoom', () => {
  it('offers Zoom In / Out / Reset, each handed to main over the bridge', () => {
    seed('dark')
    useStore.setState({ zoomFactor: 1.2 } as Parameters<typeof useStore.setState>[0])
    render(<TitleBar />)
    const menu = openViewMenu()

    // The heading reports the current scale, so the menu doubles as the indicator.
    expect(within(menu).getByText('Zoom · 120%')).toBeTruthy()

    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Zoom In/ }))
    expect(window.orbital.zoomIn).toHaveBeenCalledTimes(1)
    fireEvent.click(within(openViewMenu()).getByRole('menuitem', { name: /^Zoom Out/ }))
    expect(window.orbital.zoomOut).toHaveBeenCalledTimes(1)
    fireEvent.click(within(openViewMenu()).getByRole('menuitem', { name: /^Reset Zoom/ }))
    expect(window.orbital.zoomReset).toHaveBeenCalledTimes(1)
  })

  it('disables Reset Zoom at 100%, where it would be a no-op', () => {
    seed('dark')
    render(<TitleBar />)
    const reset = within(openViewMenu()).getByRole('menuitem', { name: /^Reset Zoom/ })
    expect((reset as HTMLButtonElement).disabled).toBe(true)
  })
})
