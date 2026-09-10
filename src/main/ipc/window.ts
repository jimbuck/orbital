import { app, ipcMain } from 'electron'
import { IPC } from '@shared/types'
import { runtime } from '../runtime'
import { updater } from '../services/updater'
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

  // ---- updates ----
  h(IPC.getVersion, () => app.getVersion())
  h(IPC.updateStatus, () => updater.status())
  h(IPC.updateCheck, () => updater.check())
  ipcMain.on(IPC.updateInstall, () => updater.install())
}
