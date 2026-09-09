/**
 * Cursor CLI agent provider.
 *
 * Boots `cursor-agent` (Cursor's CLI binary) directly in the Worktree's checkout.
 * The Cursor CLI has no --append-system-prompt-file equivalent, so the briefing
 * file is not passed.
 *
 * Sessions: `cursor-agent create-chat` mints an empty chat and prints its id,
 * and `--resume=<id>` opens a chat by id — so, like Claude, the id is known
 * before the interactive session starts. Chats are kept under
 * `<profile>/chats/<workspace-hash>/<chat-id>/`; the hash is undocumented, so a
 * stored id is looked for under every hash rather than derived.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { AgentContext, AgentProvider, ResolvedCommand, SessionLookup } from './provider'
import { resolveExecutable } from './executable'
import { isDir, subdirs } from './sessions'

/** Where the Cursor CLI files its chats under the profile dir. */
const CHATS_SUBDIR = 'chats'

/** How long `create-chat` gets to print an id before Orbital gives up on minting one. */
const CREATE_CHAT_TIMEOUT_MS = 20_000

/** A chat id somewhere in `create-chat`'s output (a bare UUID line), or null. */
export function cursorChatIdFromOutput(output: string): string | null {
  const m = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(output)
  return m ? m[1].toLowerCase() : null
}

/** The directory of chat `id`, under whichever workspace hash holds it, or null. */
export function cursorChatDir(profileDir: string, id: string): string | null {
  const root = join(profileDir, CHATS_SUBDIR)
  for (const hash of subdirs(root)) {
    const dir = join(root, hash, id)
    if (isDir(dir)) return dir
  }
  return null
}

/**
 * Run `cursor-agent create-chat` in `cwd` and return the id it prints. The
 * command has been known to keep running after printing (a CLI regression),
 * so the process is torn down as soon as an id is seen, and again on timeout;
 * on Windows the shim is a `.cmd`, so the whole tree is killed, not just the shell.
 */
export async function cursorCreateChat(lookup: SessionLookup): Promise<string | null> {
  const { file, prefixArgs } = await resolveExecutable(lookup.execPath, 'cursor-agent')
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn(file, [...prefixArgs, 'create-chat'], {
      cwd: lookup.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const finish = (id: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child.pid)
      resolve(id)
    }
    const timer = setTimeout(() => finish(cursorChatIdFromOutput(output)), CREATE_CHAT_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const id = cursorChatIdFromOutput(output)
      if (id) finish(id)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', () => finish(null))
    child.on('exit', () => finish(cursorChatIdFromOutput(output)))
  })
}

/** Best-effort kill of a process and its children. */
function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch {
    /* already gone */
  }
}

export const cursorProvider: AgentProvider = {
  id: 'cursor',
  displayName: 'Cursor',
  // Used later to auto-suggest a provider per project; defined now, unused for now.
  detectFiles: ['.cursor', '.cursorrules', 'AGENTS.md'],
  // cursor-agent has no launch-time instructions flag and no profile-level rules
  // file; the only channel is `.cursor/rules` INSIDE the repo, which Orbital will
  // not write (zero git footprint). Cursor sessions learn the CLI from `orbital help`.
  acceptsBriefingFile: false,

  sessions: {
    mint: cursorCreateChat,
    async find({ profileDir }: SessionLookup, id: string): Promise<string | null> {
      return cursorChatDir(profileDir, id)
    }
  },

  async resolveCommand(ctx: AgentContext): Promise<ResolvedCommand> {
    const { file, prefixArgs } = await resolveExecutable(ctx.execPath, 'cursor-agent')
    const args = [...prefixArgs]
    // `--resume` opens the chat by id whether it is the one just minted (still
    // empty) or a stored one; `=` form because the flag's value is optional.
    if (ctx.session) args.push(`--resume=${ctx.session.id}`)
    return { file, args }
  }
}
