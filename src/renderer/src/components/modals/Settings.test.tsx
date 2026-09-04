import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    theme,
    accentColor: null
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

/** The store's own closeModal, restored after tests that stub it out. */
const realCloseModal = useStore.getState().closeModal

beforeEach(() => {
  setSettings.mockClear()
  vi.stubGlobal('orbital', { setSettings, inspectProfileDir: vi.fn(async () => null), openLogFolder: vi.fn() })
  // jsdom has no matchMedia; the accent picker resolves the theme for its
  // Default swatch, which subscribes to it.
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useStore.setState({ closeModal: realCloseModal })
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

  it('rolls the theme back when it cannot be persisted', async () => {
    // The theme is applied optimistically so the click previews instantly, which
    // means a failed write leaves the user looking at a change that was never
    // saved — until some unrelated broadcast snaps it back for no visible reason.
    // Reverting here ties the failure to the click that caused it.
    seed('system')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setSettings.mockRejectedValueOnce(new Error('SQLITE_BUSY | database is locked'))
    render(<Settings />)

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    // Applied first: the whole point of the optimistic write.
    expect(useStore.getState().settings?.theme).toBe('dark')

    await vi.waitFor(() => expect(useStore.getState().settings?.theme).toBe('system'))
    expect(themeRadios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
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

  it('still writes nothing when the store moves under the open modal', async () => {
    // The case the test above cannot see, because nothing moves during it. Every
    // state broadcast replaces `settings` in the store, and main broadcasts
    // constantly; some of those carry a machine-global setting another workspace
    // instance just changed. The form is seeded once and never resyncs, so a Save
    // that diffs against the LIVE store reads the untouched field as an edit and
    // hands it back to this modal's opening snapshot — the lost update this
    // modal is supposed to prevent, reachable without the user typing anything.
    seed('dark')
    render(<Settings />)

    act(() => {
      useStore.setState({ settings: { ...makeSettings('dark'), defaultShell: 'bash.exe' } })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1))

    expect(setSettings.mock.calls[0][0]).toEqual({})
  })

  it('still writes a field the user did edit after the store moved', async () => {
    // The other half: diffing against the seed must not turn into ignoring the
    // user. A field they actually typed into goes out and wins — last writer,
    // which is what someone editing a form means.
    seed('dark')
    render(<Settings />)

    fireEvent.change(screen.getByLabelText('Default shell'), { target: { value: 'cmd.exe' } })
    act(() => {
      useStore.setState({ settings: { ...makeSettings('dark'), defaultShell: 'bash.exe' } })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1))

    expect(setSettings.mock.calls[0][0]).toEqual({ defaultShell: 'cmd.exe' })
  })

  it('keeps the modal open and explains itself when the write fails', async () => {
    // The settings write takes SQLite's write lock on a DB every instance shares,
    // so it can reject with SQLITE_BUSY. That used to escape as an unhandled
    // rejection: closeModal() never ran and the modal sat there saying nothing.
    seed('dark')
    const closeModal = vi.fn()
    useStore.setState({ closeModal })
    setSettings.mockRejectedValueOnce(new Error('SQLITE_BUSY | database is locked'))
    render(<Settings />)

    fireEvent.change(screen.getByLabelText('Default shell'), { target: { value: 'cmd.exe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/couldn't save settings/i)
    // The underlying reason, not just a shrug.
    expect(alert.textContent).toContain('database is locked')
    expect(closeModal).not.toHaveBeenCalled()
    // The edits are the only remaining copy — they must survive for a retry.
    expect((screen.getByLabelText('Default shell') as HTMLSelectElement).value).toBe('cmd.exe')
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Settings — accent colour', () => {
  /** The accent radio group's swatches, in rendered order. */
  function swatches(): HTMLElement[] {
    return within(screen.getByRole('radiogroup', { name: 'Accent color' })).getAllByRole('radio')
  }
  const hexField = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Accent hex' }) as HTMLInputElement
  const swatchNamed = (name: string): HTMLElement => swatches().find((r) => r.getAttribute('aria-label') === name)!

  it('offers Default, the presets and Custom, with Default checked when no accent is set', () => {
    seed('dark')
    render(<Settings />)
    const names = swatches().map((r) => r.getAttribute('aria-label'))
    expect(names[0]).toBe('Default')
    expect(names[names.length - 1]).toBe('Custom')
    expect(names.length).toBeGreaterThan(4)
    expect(swatches()[0].getAttribute('aria-checked')).toBe('true')
    expect(hexField().value).toBe('')
  })

  it('persists a clicked preset as accentColor and nothing else, applying it at once', () => {
    seed('dark')
    render(<Settings />)
    fireEvent.click(swatchNamed('Violet'))
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith({ accentColor: '#8b7cf6' })
    expect(useStore.getState().settings?.accentColor).toBe('#8b7cf6')
    expect(swatchNamed('Violet').getAttribute('aria-checked')).toBe('true')
    expect(hexField().value).toBe('#8b7cf6')
  })

  it('clears the accent back to Default with a null write', () => {
    seed('dark')
    useStore.setState({ settings: { ...makeSettings('dark'), accentColor: '#8b7cf6' } })
    render(<Settings />)
    fireEvent.click(swatches()[0])
    expect(setSettings).toHaveBeenCalledWith({ accentColor: null })
    expect(useStore.getState().settings?.accentColor).toBeNull()
  })

  it('checks Custom for a colour that is not a preset', () => {
    seed('dark')
    useStore.setState({ settings: { ...makeSettings('dark'), accentColor: '#123456' } })
    render(<Settings />)
    expect(swatchNamed('Custom').getAttribute('aria-checked')).toBe('true')
    expect(swatches()[0].getAttribute('aria-checked')).toBe('false')
  })

  it('applies a typed hex on Enter, normalised, and ignores one that is not a colour', () => {
    seed('dark')
    render(<Settings />)
    fireEvent.change(hexField(), { target: { value: 'ABCDEF' } })
    fireEvent.keyDown(hexField(), { key: 'Enter' })
    expect(setSettings).toHaveBeenCalledWith({ accentColor: '#abcdef' })

    setSettings.mockClear()
    fireEvent.change(hexField(), { target: { value: 'not a colour' } })
    fireEvent.blur(hexField())
    expect(setSettings).not.toHaveBeenCalled()
    // The field falls back to the applied colour rather than holding junk.
    expect(hexField().value).toBe('#abcdef')
  })

  it('previews a dragged custom colour at once and persists it when the drag pauses', async () => {
    vi.useFakeTimers()
    try {
      seed('dark')
      render(<Settings />)
      fireEvent.change(swatchNamed('Custom'), { target: { value: '#112233' } })
      fireEvent.change(swatchNamed('Custom'), { target: { value: '#445566' } })
      // Every movement re-tints the app...
      expect(useStore.getState().settings?.accentColor).toBe('#445566')
      // ...but nothing has been written yet.
      expect(setSettings).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      expect(setSettings).toHaveBeenCalledTimes(1)
      expect(setSettings).toHaveBeenCalledWith({ accentColor: '#445566' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rolls the accent back when it cannot be persisted', async () => {
    seed('dark')
    setSettings.mockRejectedValueOnce(new Error('SQLITE_BUSY'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Settings />)
    fireEvent.click(swatchNamed('Green'))
    expect(useStore.getState().settings?.accentColor).toBe('#3ddc97')
    await act(async () => {
      await Promise.resolve()
    })
    expect(useStore.getState().settings?.accentColor).toBeNull()
    error.mockRestore()
  })

  it('leaves the accent out of Save, which persists it on selection', async () => {
    seed('dark')
    render(<Settings />)
    fireEvent.click(swatchNamed('Teal'))
    setSettings.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(setSettings).toHaveBeenCalledWith({})
  })

  it('says the accent applies immediately, next to the control and to assistive tech', () => {
    seed('dark')
    render(<Settings />)
    const group = screen.getByRole('radiogroup', { name: 'Accent color' })
    const hint = document.getElementById(group.getAttribute('aria-describedby')!)
    expect(hint?.textContent).toMatch(/Applies immediately/)
  })
})
