import { app, ipcMain } from 'electron'
import { IPC } from '@shared/types'
import { runtime } from '../runtime'
import { updater } from '../services/updater'
import { zoom } from '../services/zoom'
import { handle } from './handle'

/** Frameless-window controls and the auto-updater. */
export function register(): void {
  const h = handle
  ipcMain.on(IPC.windowMinimize, () => runtime.window?.minimize())
  ipcMain.on(IPC.windowMaximize, () => {
    const w = runtime.window
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on(IPC.windowClose, () => runtime.window?.close())
  ipcMain.on(IPC.toggleDevTools, () => runtime.window?.webContents.toggleDevTools())

  // ---- zoom (View menu; the keyboard shortcuts are handled in main/index.ts) ----
  ipcMain.on(IPC.zoomIn, () => zoom.in(runtime.window))
  ipcMain.on(IPC.zoomOut, () => zoom.out(runtime.window))
  ipcMain.on(IPC.zoomReset, () => zoom.reset(runtime.window))
  h(IPC.getZoomFactor, () => zoom.factor())

  // ---- updates ----
  h(IPC.getVersion, () => app.getVersion())
  h(IPC.updateStatus, () => updater.status())
  h(IPC.updateCheck, () => updater.check())
  ipcMain.on(IPC.updateInstall, () => updater.install())
}
