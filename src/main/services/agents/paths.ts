import { join } from 'node:path'
import { app } from 'electron'

/**
 * Directory holding the bundled `orbital` CLI + shims. Prepended to every Flight
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
