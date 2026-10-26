import { spawn } from 'node:child_process'
import { resolveExecutable } from './agents/executable'

/** What an empty `externalEditor` setting means: VS Code's command-line launcher. */
export const DEFAULT_EXTERNAL_EDITOR = 'code'

/**
 * Open `target` (an absolute path main derived and containment-checked) in the
 * user's external editor, detached so it outlives Orbital.
 *
 * `command` is the Settings value: a bare name looked up on PATH, or a path to
 * the executable when it contains a separator. Resolution goes through the same
 * helper the agents use, so a `code.cmd` shim on Windows runs through cmd.exe
 * rather than failing to exec. Resolves once the process has started and
 * rejects with a message the git panel can show when it could not.
 */
export async function spawnExternalEditor(command: string, target: string): Promise<void> {
  const name = command.trim() || DEFAULT_EXTERNAL_EDITOR
  const isPath = /[\\/]/.test(name)
  let exe
  try {
    exe = await resolveExecutable(isPath ? name : undefined, name)
  } catch {
    throw new Error(
      isPath
        ? `External editor not found: ${name}`
        : `'${name}' was not found on your PATH. Set the external editor in Settings.`
    )
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe.file, [...exe.prefixArgs, target], { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
