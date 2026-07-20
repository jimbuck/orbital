import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import { closeDb } from './db/database'
import { runtime } from './runtime'
import { updater } from './services/updater'
import { logger } from './services/logger'
import {
  resolveBootWorkspace,
  activeControlPipePath,
  migrateLegacyWorkspaceFiles
} from './services/workspaces'
import { getSettings } from './services/settings'
import { registerIpc, handleControl, resumeProjects, resumeTerminals, stopWorktreesWatchers } from './ipc'

const RENDERER_URL = process.env['ELECTRON_RENDERER_URL']

// Settle this instance's workspace before ANYTHING opens. All data lives in ONE
// global DB under the app-storage root (workspaces are rows in it); what varies
// per instance is which workspace it scopes to (`--workspace-id` /
// ORBITAL_WORKSPACE_ID, defaulting to the most recently opened) and its own
// Chromium profile dir — which also keys the single-instance lock, giving
// exactly one window per workspace. ORBITAL_USER_DATA relocates the whole root
// for sandboxed test runs.
const bootWorkspace = resolveBootWorkspace(app.getPath('userData'))
app.setPath('userData', bootWorkspace.profileDir)

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

  // The renderer's static <title> would reset the window title to plain
  // "Orbital" on every (re)load; the workspace-aware title is owned by
  // runtime.refreshWindowTitle().
  win.on('page-title-updated', (e) => e.preventDefault())

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
    // The global DB opened (and migrated) during boot resolution; fold in any
    // files left behind by the short-lived files-as-source-of-truth design.
    migrateLegacyWorkspaceFiles(bootWorkspace.globalRoot)
    // Bring the opt-in debug logger up first thing so it can capture the rest of
    // startup. It writes to Electron's per-user logs dir and no-ops unless the
    // setting is on. The crash handlers add a log breadcrumb but must NOT change
    // the app's failure contract: they always mirror to console, and a fatal
    // uncaughtException still terminates. (Installing an uncaughtException
    // listener otherwise suppresses Node's default print-and-exit, silently
    // limping on in a corrupted state — and, with logging off, with no record.)
    logger.init(app.getPath('logs'))
    logger.setEnabled(getSettings().debugLogging)
    process.on('uncaughtException', (err) => {
      logger.error('uncaughtException', { message: err.message, stack: err.stack })
      console.error(err)
      app.exit(1)
    })
    process.on('unhandledRejection', (reason) => {
      logger.error('unhandledRejection', { reason: String(reason) })
      console.error(reason)
    })
    runtime.init()
    registerIpc()

    const win = createWindow()
    runtime.setWindow(win)
    win.on('closed', () => runtime.setWindow(null))

    resumeProjects()
    // Start the CLI control channel BEFORE respawning terminals so a single bad
    // worktree can never prevent the orbital-CLI pipe from coming up. The pipe is
    // scoped to this workspace so multiple instances never collide on one name.
    await runtime.control.start(handleControl, activeControlPipePath()).catch((err) => {
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
  }).catch((err) => {
    console.error('startup failed:', err)
  })

  // Quitting the app stops the agents (PTYs); minimizing does not (PRD §5, §12).
  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    updater.stop()
    stopWorktreesWatchers()
    runtime.shutdown()
    closeDb()
  })
}
