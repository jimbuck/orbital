import { spawn } from 'node:child_process'

/**
 * Open the platform's external terminal application with `dir` as its working
 * directory, detached so it outlives Orbital.
 *
 * Shared by the Worktree-scoped and project-scoped hand-offs so the Windows
 * "Windows Terminal, else a PowerShell window" fallback is written once —
 * `wt` is absent on stock Windows Server and on machines where the user
 * removed it, and the two entry points must degrade identically.
 *
 * `dir` is always a path MAIN derived (from a stored Worktree or project), so
 * whatever containment applies has already been applied by the caller.
 */
export function spawnExternalTerminal(dir: string): void {
  if (process.platform === 'win32') {
    const wt = spawn('wt', ['-d', dir], { detached: true, stdio: 'ignore' })
    wt.on('error', () => {
      const ps = spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit'], {
        cwd: dir,
        detached: true,
        stdio: 'ignore'
      })
      ps.unref()
    })
    wt.unref()
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
  }
}
