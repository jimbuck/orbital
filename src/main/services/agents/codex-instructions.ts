/**
 * Opt-in Codex instructions.
 *
 * Codex has no `--append-system-prompt-file` equivalent, so it never receives
 * the per-launch briefing Claude gets (see briefing.ts) — a Codex agent tab
 * would have no idea the cockpit or the `orbital` CLI exist. What Codex DOES
 * read, at the start of every session, is the AGENTS.md in its home directory
 * (`CODEX_HOME`, else ~/.codex), ahead of any project-level ones.
 *
 * That file belongs to the user, so Orbital manages a delimited BLOCK inside it
 * rather than the file: install rewrites just that block (idempotent), uninstall
 * removes just that block, and anything the user wrote around it is untouched.
 *
 * Which AGENTS.md depends on the Codex profile this acts on (Settings →
 * agents): two Codex profiles are two files, and so two installs.
 *
 * Unlike the Claude skill, this text is loaded into EVERY Codex session using
 * the profile, so it is deliberately short — a pointer to `orbital help` and the
 * few commands worth doing unprompted, guarded by the ORBITAL_WORKTREE_ID check
 * so sessions outside Orbital know to ignore it.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { AgentConfig, CodexInstructionsPlan, CodexInstructionsStatus } from '@shared/types'
import { agentProfileDir } from './profiles'

const BEGIN = '<!-- orbital:begin managed-by: orbital -->'
const END = '<!-- orbital:end -->'

/** `<codex-home>/AGENTS.md` for a given Codex profile. */
export function instructionsPath(agent: AgentConfig): string {
  return join(agentProfileDir(agent), 'AGENTS.md')
}

/** The managed block, markers included. */
export function instructionsBlock(): string {
  return `${BEGIN}
## Orbital cockpit

When \`ORBITAL_WORKTREE_ID\` is set, this session is running inside a worktree of
the Orbital cockpit, and the \`orbital\` CLI on your PATH talks to it. If that
variable is NOT set, ignore this section — the CLI has no cockpit to reach.

- \`orbital whoami\` — project, worktree, branch, path, status, linked task, dev servers.
- \`orbital status <working|needs-attention|idle|error|done>\` — keep the cockpit honest
  about what you are doing. \`needs-attention\` is what makes the human look at this
  worktree, so set it when you are genuinely blocked on them.
- \`orbital task add "<title>"\` — file follow-up work you notice instead of expanding
  the current change; \`orbital task list\` / \`orbital task update <n> --status <s>\` to
  see and progress the project's tasks.
- \`orbital server add <port>\` when you start a dev server, \`orbital server remove <port>\`
  when you stop it, so the human can open it in one click.

\`orbital help\` lists everything else (worktrees, tabs). Add \`--json\` to any command
when you intend to parse the output.
${END}`
}

/** What Orbital would write, shown to the user before anything touches disk. */
export function plan(agent: AgentConfig): CodexInstructionsPlan {
  return { path: instructionsPath(agent), markdown: instructionsBlock() }
}

/** The file's current content, or '' when it does not exist yet. */
function read(agent: AgentConfig): string {
  try {
    return readFileSync(instructionsPath(agent), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err // permission / IO error — surface it rather than overwriting blindly
  }
}

/** Write atomically so a crash can never leave the user's AGENTS.md half-written. */
function write(agent: AgentConfig, content: string): void {
  const file = instructionsPath(agent)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.orbital-${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** Everything except Orbital's block (and the blank lines that separated it). */
function withoutBlock(content: string): string {
  const start = content.indexOf(BEGIN)
  if (start === -1) return content
  const end = content.indexOf(END, start)
  // An END that went missing (hand-edited) would make a naive slice eat the rest
  // of the file — drop only the marker line in that case.
  const stop = end === -1 ? start + BEGIN.length : end + END.length
  return (content.slice(0, start).replace(/\s+$/, '') + '\n' + content.slice(stop).replace(/^\s+/, '')).trim()
}

/** Add or refresh Orbital's block, preserving everything the user wrote. */
export function install(agent: AgentConfig): CodexInstructionsStatus {
  const rest = withoutBlock(read(agent))
  write(agent, rest ? `${rest}\n\n${instructionsBlock()}\n` : `${instructionsBlock()}\n`)
  return status(agent)
}

/** Strip Orbital's block; delete the file only if nothing else was in it. */
export function remove(agent: AgentConfig): CodexInstructionsStatus {
  const current = read(agent)
  if (current.includes(BEGIN)) {
    const rest = withoutBlock(current)
    if (rest) write(agent, `${rest}\n`)
    else rmSync(instructionsPath(agent), { force: true })
  }
  return status(agent)
}

/** Read-only source-of-truth check; never throws. */
export function status(agent: AgentConfig): CodexInstructionsStatus {
  const path = instructionsPath(agent)
  try {
    return { installed: existsSync(path) && readFileSync(path, 'utf8').includes(BEGIN), path }
  } catch {
    return { installed: false, path }
  }
}
