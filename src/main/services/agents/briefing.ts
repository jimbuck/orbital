/**
 * Per-launch agent briefing.
 *
 * Writes a short operational system-prompt file into Orbital's own app-data dir
 * (NOT the repo — zero git footprint) and returns its path. Regenerated on every
 * tab launch; deleted when the tab/flight goes away (and swept at startup) so the
 * files never accumulate. This is harness wiring only; it deliberately does not
 * duplicate anything from the repo's CLAUDE.md.
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Workspace, Flight } from '@shared/types'

function briefingDir(): string {
  return join(app.getPath('userData'), 'agent-briefings')
}

/** Stable per-tab briefing key (also the filename stem). */
export function briefingKey(flightId: string, tabId: string): string {
  return `${flightId}__${tabId}`
}

export interface BriefingInput {
  workspace: Workspace
  flight: Flight
  tabId: string
  /** When true, the cockpit learns status from Claude hooks, so drop the self-report block. */
  hooksInstalled: boolean
}

/** Write the briefing for an agent tab launch; returns the absolute file path. */
export function writeBriefing(input: BriefingInput): string {
  const dir = briefingDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${briefingKey(input.flight.id, input.tabId)}.txt`)
  writeFileSync(file, briefingText(input), 'utf8')
  return file
}

/** Best-effort delete of a single agent tab's briefing file. */
export function deleteBriefing(flightId: string, tabId: string): void {
  try {
    rmSync(join(briefingDir(), `${briefingKey(flightId, tabId)}.txt`), { force: true })
  } catch {
    /* nothing to remove */
  }
}

/** Startup sweep: drop any briefing file whose flight__tab key is not in `keep`. */
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

function briefingText({ workspace, flight, hooksInstalled }: BriefingInput): string {
  const lines = [
    'You are Claude Code running inside an Orbital flight — one workspace in the Orbital',
    'cockpit, which runs several coding-agent sessions side by side, each in its own git',
    'worktree.',
    '',
    'Flight context:',
    `- Workspace: ${workspace.name}`,
    `- Flight: ${flight.name}`,
    `- Worktree: ${flight.worktreePath}`,
    `- Branch: ${flight.branch}`,
    '',
    'The `orbital` CLI is on your PATH. Use `orbital task add "<title>"` to queue follow-up',
    'work you notice but should not tackle right now.'
  ]
  if (!hooksInstalled) {
    lines.push(
      '',
      'Report your status as you work so the cockpit can show what each flight is doing:',
      '- `orbital status working` — actively working',
      '- `orbital status needs-attention` — blocked and waiting on a human',
      '- `orbital status idle` — waiting for the next instruction',
      '- `orbital status done` — the current task is complete'
    )
  }
  return lines.join('\n') + '\n'
}
