import type { BrowserWindow, Input } from 'electron'
import { IPC } from '@shared/types'
import { getDb } from '../db/database'

/**
 * UI zoom for the cockpit window: View ▸ Zoom In / Out / Reset and the usual
 * Ctrl + / Ctrl - / Ctrl 0 shortcuts, for demos and high-DPI screens where the
 * default scale reads small.
 *
 * Zoom is a Chromium *zoom level*: the factor is 1.2^level, one level per step,
 * the same progression Chrome itself uses. The level is persisted in the global
 * settings table (one value per machine, like the theme) and re-applied on every
 * load, because Chromium's own per-origin zoom memory does not cover the
 * `file://` origin a packaged build runs from — without this a zoom would be
 * lost on restart.
 */

/** Persisted level range: 1.2^-4 ≈ 48% up to 1.2^6 ≈ 299%. */
export const ZOOM_MIN_LEVEL = -4
export const ZOOM_MAX_LEVEL = 6

const SETTINGS_KEY = 'zoomLevel'

/** Chromium's zoom factor for a level. */
export function zoomFactorForLevel(level: number): number {
  return Math.pow(1.2, level)
}

/** The next level for a step, clamped to the supported range. */
export function stepZoomLevel(level: number, direction: 'in' | 'out'): number {
  const next = direction === 'in' ? level + 1 : level - 1
  return Math.max(ZOOM_MIN_LEVEL, Math.min(ZOOM_MAX_LEVEL, next))
}

/**
 * The zoom action a key press asks for, or null. Ctrl + (with or without Shift
 * — `=` and `+` share a key on most layouts) and the numpad plus zoom in;
 * Ctrl - and numpad minus zoom out; Ctrl 0 and numpad 0 reset. Alt is excluded
 * so AltGr combinations on European layouts keep typing their characters.
 */
export function zoomActionForInput(input: Input): 'in' | 'out' | 'reset' | null {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null
  switch (input.code) {
    case 'Equal':
    case 'NumpadAdd':
      return 'in'
    case 'Minus':
    case 'NumpadSubtract':
      return input.shift ? null : 'out'
    case 'Digit0':
    case 'Numpad0':
      return input.shift ? null : 'reset'
    default:
      return null
  }
}

function readLevel(): number {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined
  const parsed = row ? Number(row.value) : 0
  if (!Number.isFinite(parsed)) return 0
  return Math.max(ZOOM_MIN_LEVEL, Math.min(ZOOM_MAX_LEVEL, Math.round(parsed)))
}

function writeLevel(level: number): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SETTINGS_KEY, String(level))
}

export const zoom = {
  /** The current zoom factor (1 = 100%). */
  factor(): number {
    return zoomFactorForLevel(readLevel())
  },

  /** Apply the persisted level to a window — call once its document has loaded. */
  apply(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    const level = readLevel()
    win.webContents.setZoomLevel(level)
    win.webContents.send(IPC.evtZoomChanged, zoomFactorForLevel(level))
  },

  set(win: BrowserWindow | null, level: number): void {
    writeLevel(level)
    if (win) zoom.apply(win)
  },

  in(win: BrowserWindow | null): void {
    zoom.set(win, stepZoomLevel(readLevel(), 'in'))
  },

  out(win: BrowserWindow | null): void {
    zoom.set(win, stepZoomLevel(readLevel(), 'out'))
  },

  reset(win: BrowserWindow | null): void {
    zoom.set(win, 0)
  },

  /** Run the action a shortcut asks for; true when the input was consumed. */
  handleInput(win: BrowserWindow, input: Input): boolean {
    const action = zoomActionForInput(input)
    if (!action) return false
    if (action === 'in') zoom.in(win)
    else if (action === 'out') zoom.out(win)
    else zoom.reset(win)
    return true
  }
}
