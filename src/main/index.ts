import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import { getDb, closeDb } from './db/database'
import { runtime } from './runtime'
import { updater } from './services/updater'
import { registerIpc, handleControl, resumeWorkspaces, resumeTerminals } from './ipc'

const RENDERER_URL = process.env['ELECTRON_RENDERER_URL']

// Sandbox override for tests/demos: point all persistent state (DB, briefings)
// at a different profile dir so a scripted run never touches the real one.
if (process.env['ORBITAL_USER_DATA']) {
  app.setPath('userData', process.env['ORBITAL_USER_DATA'])
}

// Must match `appId` in electron-builder.yml so notifications, taskbar pinning
// and jump-list identity line up between the dev run and the installed app.
const APP_ID = 'dev.jimbuck.orbital'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0a0d12',
    title: 'Orbital',
    // In dev the host process is electron.exe, so without an explicit icon the
    // taskbar/Alt-Tab show the generic Electron logo. Point at the source icon
    // (build/ isn't shipped, but a packaged build embeds it in the exe instead).
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Push the initial state once the renderer is live.
  win.webContents.on('did-finish-load', () => runtime.broadcastState())

  // Ctrl+Shift+R reloads the window. Handled in the main process (not a renderer
  // keydown listener) so it still fires when the renderer itself is wedged —
  // which is exactly when a reload is most useful.
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.control &&
      input.shift &&
      !input.alt &&
      !input.meta &&
      input.code === 'KeyR'
    ) {
      event.preventDefault()
      win.webContents.reloadIgnoringCache()
    }
  })

  // Dev diagnostics: surface renderer console + load/crash failures in the terminal.
  if (RENDERER_URL) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = level >= 3 ? 'error' : level === 2 ? 'warn' : 'log'
      console.log(`[renderer:${tag}] ${message}${line ? ` (${sourceId}:${line})` : ''}`)
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) =>
      console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`)
    )
    win.webContents.on('render-process-gone', (_e, details) =>
      console.error('[renderer] render-process-gone', details.reason)
    )
  }

  const load = RENDERER_URL ? win.loadURL(RENDERER_URL) : win.loadFile(join(__dirname, '../renderer/index.html'))
  // Otherwise a failed initial load in a packaged build is a silent blank window.
  load.catch((err) => console.error('[main] window load failed:', err))

  return win
}

// A single instance keeps one owner of the control-channel pipe.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = runtime.window
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    // Register Orbital's identity with Windows so the shell attributes the taskbar
    // group, pinning and notifications to "Orbital" rather than to "Electron".
    app.setAppUserModelId(APP_ID)
    getDb()
    runtime.init()
    registerIpc()

    const win = createWindow()
    runtime.setWindow(win)
    win.on('closed', () => runtime.setWindow(null))

    resumeWorkspaces()
    // Start the CLI control channel BEFORE respawning terminals so a single bad
    // worktree can never prevent the orbital-CLI pipe from coming up.
    await runtime.control.start(handleControl).catch((err) => {
      console.error('control channel failed to start:', err)
    })
    resumeTerminals()

    // Background update check against GitHub releases (no-op in dev).
    updater.init((channel, payload) => runtime.send(channel, payload))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const w = createWindow()
        runtime.setWindow(w)
        w.on('closed', () => runtime.setWindow(null))
      }
    })
  }).catch((err) => console.error('startup failed:', err))

  // Quitting the app stops the agents (PTYs); minimizing does not (PRD §5, §12).
  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    updater.stop()
    runtime.shutdown()
    closeDb()
  })
}
