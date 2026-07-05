import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC, type UpdateStatus } from '@shared/types'

/** Re-check cadence while the app stays open (ms). */
const CHECK_INTERVAL = 4 * 60 * 60 * 1000

/**
 * Auto-update over GitHub releases (electron-updater). Updates download in the
 * background; nothing is installed until the user clicks "Restart to update"
 * (or quits — autoInstallOnAppQuit applies a downloaded update on exit).
 *
 * In an unpackaged dev run there is no app-update.yml and no installed copy to
 * replace, so the whole service reports `disabled` and never touches the network.
 */
class UpdaterService {
  private current: UpdateStatus = { phase: 'idle' }
  private send: (channel: string, payload: unknown) => void = () => {}
  private timer: ReturnType<typeof setInterval> | null = null

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

  /** Quit and install the downloaded update, relaunching afterwards. */
  install(): void {
    if (this.current.phase !== 'ready') return
    // silent install + relaunch: the NSIS installer runs without UI and starts
    // the new version, so "Restart to update" feels like a plain restart.
    autoUpdater.quitAndInstall(true, true)
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
