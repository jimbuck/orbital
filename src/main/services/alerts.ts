import { join } from 'node:path'
import { app, BrowserWindow, nativeImage } from 'electron'
import type { Worktree, Settings, AlertEvent } from '@shared/types'

/**
 * AlertManager owns the Windows taskbar leg of the three-way needs-attention
 * alert. Sound + in-app banner are handled in the renderer.
 *
 * The badge is the app icon itself: when a Worktree needs attention the window
 * icon swaps to a variant where the orbiting satellite swells and glows amber
 * (resources/icons/icon-alert.png, rendered from build/icon-alert.svg by
 * scripts/render-icons.js), and swaps back once everything is quiet.
 *
 * On every state change the orchestrator calls `update(worktrees)`; the manager
 * computes how many Worktrees need attention, swaps the window icon, and returns
 * an AlertEvent that the renderer consumes for chime/banner.
 */
export class AlertManager {
  /** Needs-attention count from the previous `update`, for rising-edge detection. */
  private prev = 0
  /** Lazily-loaded window icon variants (normal / satellite-lit-amber). */
  private icons: { normal: Electron.NativeImage; alert: Electron.NativeImage } | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getSettings: () => Settings
  ) {}

  /**
   * Recompute the needs-attention set, drive the taskbar icon, and report the
   * transition. `rising` is true when a *new* Worktree has just started needing
   * attention (count grew), which the renderer uses to decide whether to
   * chime/re-badge rather than re-alert on every tick.
   */
  update(worktrees: Pick<Worktree, 'id' | 'status'>[]): AlertEvent {
    const needing = worktrees.filter((w) => w.status === 'needs_attention')
    const count = needing.length
    const firstId = count > 0 ? needing[0].id : null
    const rising = count > this.prev

    // Setting the icon on every update (not just on edges) keeps it self-healing:
    // a recreated window or a mid-alert settings toggle converges on next tick.
    const win = this.getWindow()
    if (win && !win.isDestroyed()) {
      const badge = count > 0 && this.getSettings().alerts.taskbarBadge
      const icon = this.icon(badge ? 'alert' : 'normal')
      if (!icon.isEmpty()) {
        try {
          win.setIcon(icon)
        } catch {
          // The window can still be destroyed between the check and the call;
          // the badge is best-effort, so swallow and keep the loop alive.
        }
      }
    }

    this.prev = count
    return { count, worktreeId: firstId, rising }
  }

  private icon(kind: 'normal' | 'alert'): Electron.NativeImage {
    if (!this.icons) {
      // Same layout rule as the bundled CLI: packaged builds ship the icons via
      // extraResources, dev runs read them straight from the repo.
      const dir = app.isPackaged
        ? join(process.resourcesPath, 'icons')
        : join(app.getAppPath(), 'resources', 'icons')
      this.icons = {
        normal: nativeImage.createFromPath(join(dir, 'icon.png')),
        alert: nativeImage.createFromPath(join(dir, 'icon-alert.png'))
      }
    }
    return this.icons[kind]
  }
}
