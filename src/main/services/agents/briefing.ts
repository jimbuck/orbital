/**
 * Per-launch agent briefing.
 *
 * Writes a short operational system-prompt file into Orbital's own app-data dir
 * (NOT the repo — zero git footprint) and returns its path. Regenerated on every
 * tab launch; deleted when the tab/worktree goes away (and swept at startup) so
 * the files never accumulate. This is harness wiring only; it deliberately does
 * not duplicate anything from the repo's CLAUDE.md.
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Project, Worktree } from '@shared/types'

function briefingDir(): string {
  return join(app.getPath('userData'), 'agent-briefings')
}

/** Stable per-tab briefing key (also the filename stem). */
export function briefingKey(worktreeId: string, tabId: string): string {
  return `${worktreeId}__${tabId}`
}

export interface BriefingInput {
  project: Project
  worktree: Worktree
  tabId: string
  /** Agent name used in the opener; defaults to 'Claude Code'. */
  providerName?: string
  /** When true, the cockpit learns status from Claude hooks, so drop the self-report block. */
  hooksInstalled: boolean
}

/** Write the briefing for an agent tab launch; returns the absolute file path. */
export function writeBriefing(input: BriefingInput): string {
  const dir = briefingDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${briefingKey(input.worktree.id, input.tabId)}.txt`)
  writeFileSync(file, briefingText(input), 'utf8')
  return file
}

/** Best-effort delete of a single agent tab's briefing file. */
export function deleteBriefing(worktreeId: string, tabId: string): void {
  try {
    rmSync(join(briefingDir(), `${briefingKey(worktreeId, tabId)}.txt`), { force: true })
  } catch {
    /* nothing to remove */
  }
}

/** Startup sweep: drop any briefing file whose worktree__tab key is not in `keep`. */
export function pruneBriefings(keep: Set<string>): void {
  let files: string[]
  try {
    files = readdirSync(briefingDir())
  } catch {
    return // dir not created yet — nothing to prune
  }
  for (const f of files) {
    if (!f.endsWith('.txt') || keep.has(f.slice(0, -4))) continue
    try {
      rmSync(join(briefingDir(), f), { force: true })
    } catch {
      /* ignore */
    }
  }
}

function briefingText({ project, worktree, providerName, hooksInstalled }: BriefingInput): string {
  const lines = [
    `You are ${providerName ?? 'Claude Code'} running inside an Orbital worktree — one checkout in the`,
    'Orbital cockpit, which runs several coding-agent sessions side by side, each in its own git',
    'worktree within a project.',
    '',
    'Worktree context:',
    `- Project: ${project.name}`,
    `- Worktree: ${worktree.name}`,
    `- Path: ${worktree.path}`,
    `- Branch: ${worktree.branch}`,
    '',
    'The `orbital` CLI is on your PATH — use it to work with the cockpit:',
    '- `orbital task add "<title>" [--description <text>] [--tags <a,b>]` — queue follow-up work you notice but should not tackle now.',
    "- `orbital task list` — see the project's open tasks (number, status, title); `--all` includes done ones.",
    '- `orbital task show <number>` — full detail for one task (e.g. `orbital task show 12`).',
    '- `orbital task update <number> --status <todo|in-progress|ready-for-review|done>` — progress a task you are working on; `orbital task done <number>` when it is finished; `orbital task delete <number>` to drop one.',
    "- `orbital worktrees` — list this project's worktrees.",
    '- `orbital worktree new [--worktree <branch>] [name]` — open a new worktree, optionally on a fresh git branch.',
    '- `orbital tab new <terminal|browser|editor|agent> [arg]` — open a tab in this worktree (browser arg = URL, editor arg = file path, agent arg = provider).',
    '- `orbital server add <url|port>` / `orbital server remove <url|port>` — tell the cockpit when you start or stop a dev server, so the human can open it in one click; `orbital server list` shows what is registered.'
  ]
  if (!hooksInstalled) {
    lines.push(
      '',
      'Report your status as you work so the cockpit can show what each worktree is doing:',
      '- `orbital status working` — actively working',
      '- `orbital status needs-attention` — blocked and waiting on a human',
      '- `orbital status idle` — waiting for the next instruction',
      '- `orbital status done` — the current task is complete'
    )
  }
  return lines.join('\n') + '\n'
}
