import { join } from 'node:path'
import { existsSync } from 'node:fs'
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
  if (app.isPackaged) return orbitalShimPath()
  return installedShimPath() ?? orbitalShimPath()
}
