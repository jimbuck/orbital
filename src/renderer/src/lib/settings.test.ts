import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { useStore } from '../store'
import { saveSetting, settingOf } from './settings'

const setStore = (settings: Partial<Settings> | null): void =>
  useStore.setState({ settings } as unknown as Parameters<typeof useStore.setState>[0])
const stored = (): Settings | null => useStore.getState().settings

describe('settingOf', () => {
  it('reads the default before settings have loaded', () => {
    expect(settingOf(null, 'fontLigatures')).toBe(true)
    expect(settingOf(null, 'defaultOpenAction')).toBe('right')
    expect(settingOf(null, 'agents')).toBe(DEFAULT_SETTINGS.agents)
  })

  it('reads the stored value once they have, falsy ones included', () => {
    const settings = { ...DEFAULT_SETTINGS, fontLigatures: false, defaultShell: '', accentColor: null }
    expect(settingOf(settings, 'fontLigatures')).toBe(false)
    expect(settingOf(settings, 'defaultShell')).toBe('')
    expect(settingOf(settings, 'accentColor')).toBeNull()
  })

  it('falls back to the default for a key the object is missing', () => {
    expect(settingOf({ theme: 'light' } as Settings, 'fontLigatures')).toBe(true)
  })
})

describe('saveSetting', () => {
  let resolveWrite: () => void
  let rejectWrite: (err: Error) => void
  const setSettings = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        resolveWrite = resolve
        rejectWrite = reject
      })
  )
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  beforeEach(() => {
    setSettings.mockClear()
    vi.stubGlobal('orbital', { setSettings })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setStore({ ...DEFAULT_SETTINGS })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('applies the value to the store at once and writes that key alone', () => {
    saveSetting('theme', 'light')
    expect(stored()?.theme).toBe('light')
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith({ theme: 'light' })
  })

  it('does not write a value the store already shows', () => {
    saveSetting('fontLigatures', true)
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('writes an unchanged value when asked to, for a control that previews through the store', () => {
    saveSetting('accentColor', null, { always: true })
    expect(setSettings).toHaveBeenCalledWith({ accentColor: null })
  })

  it('does nothing before settings have loaded', () => {
    setStore(null)
    saveSetting('theme', 'light')
    expect(stored()).toBeNull()
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('rolls the store back when the write fails', async () => {
    saveSetting('defaultOpenAction', 'left')
    expect(stored()?.defaultOpenAction).toBe('left')
    rejectWrite(new Error('database is locked'))
    await settle()
    expect(stored()?.defaultOpenAction).toBe('right')
    expect(console.error).toHaveBeenCalled()
  })

  it('leaves a newer value alone when an older write fails', async () => {
    saveSetting('defaultOpenAction', 'left')
    const failFirst = rejectWrite
    saveSetting('defaultOpenAction', 'top')
    failFirst(new Error('database is locked'))
    await settle()
    expect(stored()?.defaultOpenAction).toBe('top')
  })

  it('keeps the value when the write succeeds', async () => {
    saveSetting('fontLigatures', false)
    resolveWrite()
    await settle()
    expect(stored()?.fontLigatures).toBe(false)
  })
})
