import { app, dialog, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC, controlPipePath, type UpdateStatus } from '@shared/types'
import { requireWorkspaceId, workspaces } from '../db/repositories'
import { logger } from './logger'
import { findLivePeers, peerUpdatePrompt, quitPeers } from './peer-instances'

/** Re-check cadence while the app stays open (ms). */
const CHECK_INTERVAL = 4 * 60 * 60 * 1000

/**
 * Auto-update over GitHub releases (electron-updater). Updates download in the
 * background; nothing is installed until the user clicks "Update" (or quits —
 * autoInstallOnAppQuit applies a downloaded update on exit).
 *
 * Every workspace runs as its own instance, and the installer can't replace
 * files a running instance holds, so "Update" first finds the other open
 * workspaces, confirms closing them, and asks them to quit before installing.
 *
 * In an unpackaged dev run there is no app-update.yml and no installed copy to
 * replace, so the whole service reports `disabled` and never touches the network.
 */
class UpdaterService {
  private current: UpdateStatus = { phase: 'idle' }
  private send: (channel: string, payload: unknown) => void = () => {}
  private timer: ReturnType<typeof setInterval> | null = null
  /** Set while an Update click is confirming / closing peers, so a second click is a no-op. */
  private installing = false

  init(send: (channel: string, payload: unknown) => void): void {
    this.send = send

    if (!app.isPackaged) {
      this.current = { phase: 'disabled' }
      return
    }

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => this.setStatus({ phase: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.setStatus({ phase: 'downloading', version: info.version, percent: 0 })
    )
    autoUpdater.on('download-progress', (p) =>
      this.setStatus({
        phase: 'downloading',
        version: this.current.version,
        percent: Math.round(p.percent)
      })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.setStatus({ phase: 'ready', version: info.version })
    )
    autoUpdater.on('update-not-available', () => this.setStatus({ phase: 'uptodate' }))
    autoUpdater.on('error', (err) => {
      // A downloaded update stays installable even if a later check fails.
      if (this.current.phase === 'ready') return
      this.setStatus({ phase: 'error', error: err.message })
    })

    this.check()
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL)
  }

  status(): UpdateStatus {
    return this.current
  }

  /** Kick off a check; the outcome streams to the renderer as evtUpdate events. */
  check(): UpdateStatus {
    if (!app.isPackaged || this.current.phase === 'downloading' || this.current.phase === 'ready') {
      return this.current
    }
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('update check failed:', err)
    })
    return this.current
  }

  /**
   * Close every Orbital window and install the downloaded update, relaunching
   * afterwards. When other workspaces are open the user confirms first (a
   * native dialog over `win`), then those instances are asked to quit and
   * waited on, so the installer never finds them holding the install dir.
   */
  async install(win: BrowserWindow | null): Promise<void> {
    if (this.current.phase !== 'ready' || this.installing) return
    this.installing = true
    try {
      const selfId = requireWorkspaceId()
      const candidates = workspaces
        .list()
        .filter((w) => w.id !== selfId)
        .map((w) => ({ id: w.id, name: w.name, pipePath: controlPipePath(w.id) }))
      const peers = await findLivePeers(candidates)

      if (peers.length > 0) {
        const { message, detail } = peerUpdatePrompt(
          this.current.version,
          peers.map((p) => p.name)
        )
        const opts = {
          type: 'question' as const,
          buttons: ['Close All and Update', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: 'Update Orbital',
          message,
          detail
        }
        const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
        if (response !== 0) return

        const stragglers = await quitPeers(peers)
        // The silent installer closes whatever is still running itself; this is
        // just a trail for when an old build (no quit-for-update) was open.
        if (stragglers.length > 0) {
          logger.error('update: peers still running, installing anyway', {
            peers: stragglers.map((p) => p.name)
          })
        }
      }

      // The relaunch after install takes no --workspace-id, so it opens the most
      // recently opened workspace; make that the one the user clicked Update in.
      workspaces.touchOpened(selfId)
      // silent install + relaunch: the NSIS installer runs without UI and starts
      // the new version, so "Update" feels like a plain restart.
      autoUpdater.quitAndInstall(true, true)
    } catch (err) {
      logger.error('update: install failed', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.installing = false
    }
  }

  /**
   * Another instance is installing an update and asked this one to get out of
   * the way. Quit WITHOUT installing — that instance runs the installer, and a
   * second copy launched from this exit would race it.
   */
  quitForPeerUpdate(): void {
    if (app.isPackaged) autoUpdater.autoInstallOnAppQuit = false
    // Let the control channel write its reply before the pipe goes down.
    setTimeout(() => app.quit(), 100)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private setStatus(status: UpdateStatus): void {
    this.current = status
    this.send(IPC.evtUpdate, status)
  }
}

export const updater = new UpdaterService()
