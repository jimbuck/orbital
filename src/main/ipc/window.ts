import { app } from 'electron'
import { IPC } from '@shared/contract'
import { runtime } from '../runtime'
import { updater } from '../services/updater'
import { zoom } from '../services/zoom'
import { handle, listen } from './handle'

/** Frameless-window controls and the auto-updater. */
export function register(): void {
  const h = handle
  listen(IPC.windowMinimize, () => runtime.window?.minimize())
  listen(IPC.windowMaximize, () => {
    const w = runtime.window
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  listen(IPC.windowClose, () => runtime.window?.close())
  listen(IPC.toggleDevTools, () => runtime.window?.webContents.toggleDevTools())

  // ---- zoom (View menu; the keyboard shortcuts are handled in main/index.ts) ----
  listen(IPC.zoomIn, () => zoom.in(runtime.window))
  listen(IPC.zoomOut, () => zoom.out(runtime.window))
  listen(IPC.zoomReset, () => zoom.reset(runtime.window))
  h(IPC.getZoomFactor, () => zoom.factor())

  // ---- updates ----
  h(IPC.getVersion, () => app.getVersion())
  h(IPC.updateStatus, () => updater.status())
  h(IPC.checkForUpdates, () => updater.check())
  listen(IPC.installUpdate, () => void updater.install(runtime.window))
}
