import type { BrowserWindow, Input } from 'electron'
import { IPC, type WorkspaceSettings } from '@shared/types'
import { getDb } from '../db/database'
import { requireWorkspaceId, workspaces } from '../db/repositories'

/**
 * UI zoom for the cockpit window: View ▸ Zoom In / Out / Reset and the usual
 * Ctrl + / Ctrl - / Ctrl 0 shortcuts, for demos and high-DPI screens where the
 * default scale reads small.
 *
 * Zoom is a Chromium *zoom level*: the factor is 1.2^level, one level per step,
 * the same progression Chrome itself uses. The level is persisted on the
 * workspace's row (each workspace window keeps its own, like the theme) and
 * re-applied on every load, because Chromium's own per-origin zoom memory does
 * not cover the `file://` origin a packaged build runs from — without this a zoom would be
 * lost on restart.
 */

/** Persisted level range: 1.2^-4 ≈ 48% up to 1.2^6 ≈ 299%. */
export const ZOOM_MIN_LEVEL = -4
export const ZOOM_MAX_LEVEL = 6

/**
 * The key on the workspace row, and the legacy machine-global settings row the
 * level used to live in. A workspace that has never zoomed reads the legacy
 * value, so the move did not reset anyone's zoom; older builds still own that
 * row, so it is only ever read.
 */
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

/** A stored level as a supported integer, or null when it is not a number. */
function parseLevel(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return null
  return Math.max(ZOOM_MIN_LEVEL, Math.min(ZOOM_MAX_LEVEL, Math.round(parsed)))
}

function readLegacyLevel(): number | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined
  return row ? parseLevel(row.value) : null
}

function readLevel(): number {
  const stored = (workspaces.getSettings(requireWorkspaceId()) as Record<string, unknown>)[SETTINGS_KEY]
  return parseLevel(stored) ?? readLegacyLevel() ?? 0
}

function writeLevel(level: number): void {
  const workspaceId = requireWorkspaceId()
  // Merged over the whole stored row, inside an IMMEDIATE transaction, for the
  // same reasons setSettings does it that way: the row holds keys this build may
  // not know, and the DB is shared by every running instance.
  getDb()
    .transaction(() => {
      workspaces.updateSettings(workspaceId, {
        ...workspaces.getSettings(workspaceId),
        [SETTINGS_KEY]: level
      } as Partial<WorkspaceSettings>)
    })
    .immediate()
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
