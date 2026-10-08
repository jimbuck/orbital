import { join } from 'node:path'
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { app } from 'electron'

/**
 * Directory holding the bundled `orbital` CLI + shims. Prepended to every Worktree
 * terminal's PATH, and referenced by absolute path from the global Claude hooks.
 */
export function cliDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'cli') : join(app.getAppPath(), 'resources', 'cli')
}

/**
 * Absolute path to the platform `orbital` shim. The Claude hooks in the global
 * ~/.claude/settings.json invoke this by absolute path so they launch regardless
 * of the user's PATH (a bare `orbital` would error in non-Orbital sessions).
 */
export function orbitalShimPath(): string {
  return join(cliDir(), process.platform === 'win32' ? 'orbital.cmd' : 'orbital')
}

/** The installed app's shim (default install locations), or null when none is found. */
function installedShimPath(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          // electron-builder NSIS per-user default: %LOCALAPPDATA%\Programs\<productName>
          join(
            process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
            'Programs',
            'Orbital',
            'resources',
            'cli',
            'orbital.cmd'
          )
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Orbital.app/Contents/Resources/cli/orbital']
        : []
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

/**
 * Shim path to embed in PERSISTED, machine-global config — the Claude hooks in
 * ~/.claude/settings.json. Those hooks outlive the session that wrote them, so a
 * dev/worktree run must not leak its checkout path into them (the checkout moves,
 * gets deleted, or is one of many worktrees). Non-packaged runs prefer the
 * installed copy of Orbital when one exists; only when none is found do they fall
 * back to their own repo shim.
 */
export function hookShimPath(): string {
  if (process.env.APPIMAGE) return appImageShimPath(process.env.APPIMAGE)
  if (app.isPackaged) return orbitalShimPath()
  return installedShimPath() ?? orbitalShimPath()
}

/**
 * A Linux AppImage runs from a mount point that changes on every launch
 * (/tmp/.mount_OrbitXXXXXX), so the bundled shim's path is dead by the next
 * session. Hooks get a stable copy instead, under the XDG data dir: the CLI
 * script, plus a shim that runs it on the AppImage itself as plain Node. The
 * copy is refreshed on every call (boot included), so it tracks the installed
 * version, and a moved AppImage is picked up the next time it runs.
 */
export function appImageShimPath(appImage: string): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const dir = join(dataHome, 'orbital', 'cli')
  const shim = join(dir, 'orbital')
  try {
    mkdirSync(dir, { recursive: true })
    copyFileSync(join(cliDir(), 'orbital.js'), join(dir, 'orbital.js'))
    // Single-quoted for sh, so no character in the path is special.
    const quoted = `'${appImage.replace(/'/g, `'\\''`)}'`
    writeFileSync(
      shim,
      '#!/bin/sh\n' +
        '# Written by Orbital: runs the bundled CLI on the AppImage as plain Node.\n' +
        `ELECTRON_RUN_AS_NODE=1 exec ${quoted} "$(dirname "$0")/orbital.js" "$@"\n`
    )
    chmodSync(shim, 0o755)
  } catch {
    // Leave whatever copy is there; hooks are best-effort.
  }
  return shim
}
