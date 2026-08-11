/**
 * Opt-in `orbital` Agent Skill.
 *
 * Agent tabs get the `orbital` CLI explained to them in their per-launch briefing
 * (see briefing.ts), but that only covers sessions ORBITAL booted, and only for
 * providers that accept a system-prompt file. A `claude` the user runs by hand in
 * a terminal tab — the other documented way to run an agent — learns nothing.
 *
 * This installs a personal Agent Skill into the Claude profile directory THIS
 * WORKSPACE launches agents against, so any Claude session in an Orbital terminal
 * can pick it up. Skills load lazily (only the one-line description sits in the
 * listing until Claude decides it is relevant), so this costs nothing until used.
 *
 * Every file Orbital writes carries SKILL_MARKER in its frontmatter metadata:
 * uninstall only ever deletes a file that carries it, so a hand-written skill of
 * the same name is left alone rather than clobbered.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import type { ClaudeSkillPlan, ClaudeSkillStatus } from '@shared/types'
import { agentProfileDir } from './profiles'

/** Directory name under `<claude-config>/skills/`; also the `/orbital` command name. */
const SKILL_DIR_NAME = 'orbital'

/** Frontmatter line stamped on every file Orbital writes — the basis for a safe uninstall. */
const SKILL_MARKER = 'managed-by: orbital'

/** `<claude-config>/skills/orbital/SKILL.md` for the active workspace's profile. */
export function skillPath(): string {
  return join(agentProfileDir('claude'), 'skills', SKILL_DIR_NAME, 'SKILL.md')
}

/** App version stamped into the skill, so a stale copy is identifiable on disk. */
function version(): string {
  try {
    return app.getVersion()
  } catch {
    return 'dev'
  }
}

/**
 * The SKILL.md Orbital writes.
 *
 * Frontmatter uses only fields Claude Code accepts; `allowed-tools` pre-approves
 * the read-only and reporting commands (so an agent can say what it is doing
 * without a permission prompt) but deliberately NOT the commands that create
 * worktrees/tabs or delete tasks — those should still ask.
 */
export function skillMarkdown(): string {
  return `---
name: orbital
description: Report status, file and progress tasks, list sibling worktrees, open tabs, and register dev servers in the Orbital cockpit via the \`orbital\` CLI. Use when working inside an Orbital worktree terminal (ORBITAL_WORKTREE_ID is set) and you need to tell the human something, capture follow-up work, or spin up a worktree.
allowed-tools:
  - Bash(orbital status *)
  - Bash(orbital whoami *)
  - Bash(orbital worktrees *)
  - Bash(orbital task list *)
  - Bash(orbital task show *)
  - Bash(orbital task add *)
  - Bash(orbital task update *)
  - Bash(orbital task done *)
  - Bash(orbital server *)
  - Bash(orbital help *)
metadata:
  ${SKILL_MARKER}
  orbital-version: ${version()}
---

# The \`orbital\` CLI

[Orbital](https://github.com/jimbuck/orbital) is a cockpit that runs several
coding-agent sessions side by side, each in its own git worktree. \`orbital\` is on
your PATH inside every terminal it spawns, and talks to the running app over a
local pipe.

**This skill only applies inside an Orbital terminal.** \`ORBITAL_WORKTREE_ID\` is
set there; if it is absent, you are in an ordinary terminal and every command
below will fail with \`not connected to Orbital\`. Check once rather than guessing:

\`\`\`sh
orbital whoami          # project, worktree, branch, path, status, dev servers
\`\`\`

Add \`--json\` to any command to get machine-readable output instead of a table —
prefer it when you intend to parse the result.

## Telling the human what is going on

\`\`\`sh
orbital status working           # actively working
orbital status needs-attention   # blocked, waiting on a human (chimes + badges the rail)
orbital status idle              # waiting for the next instruction
orbital status error             # something broke
orbital status done              # the current task is complete
\`\`\`

\`needs-attention\` is the load-bearing one: it is what makes the human look at
this worktree. Use it when you are genuinely blocked, not for progress updates.

If the Orbital Claude status hooks are installed (Settings → Claude status
hooks), these transitions are already reported for you from Claude's own
lifecycle events and you do not need to call \`orbital status\` at all.

## Tasks

A per-project tracker the human watches. File follow-up work you notice instead
of expanding the scope of what you were asked to do.

\`\`\`sh
orbital task add "Write tests" --description "cover the parser" --tags test,parser
orbital task list [--all] [--status <status>] [--tag <tag>]   # open tasks (see below)
orbital task show 12                                          # full detail for one task
orbital task update 12 --status in-progress                   # progress it as you work
orbital task done 12
orbital task delete 12
\`\`\`

Tasks are addressed by their number (\`12\` or \`#12\`, as shown in \`task list\`) or by
a unique id prefix. Statuses: \`draft\`, \`todo\`, \`in-progress\`, \`ready-for-review\`,
\`done\`. \`task list\` hides done tasks unless you pass \`--all\` or name a status
yourself, so \`--status done\` works on its own.

## Worktrees

\`\`\`sh
orbital worktrees                                   # sibling worktrees: status, name, branch, id
orbital worktree new --worktree feat/login "Login flow"
orbital worktree new --existing-branch origin/pr-42 # check an existing branch out into a worktree
orbital worktree new --worktree feat/x --base main  # fork the new branch from a ref other than HEAD
orbital task start 12                               # worktree from task #12, branch named after it, task linked
\`\`\`

A new worktree gets the project's env files synced in automatically. \`task start\`
is the scriptable form of the cockpit's play button: it creates the worktree,
links the task to it, and moves the task to \`in-progress\`.

## Tabs and dev servers

\`\`\`sh
orbital tab new terminal
orbital tab new browser http://localhost:5173   # in-app browser tab
orbital tab new editor src/lib/cart.ts          # open a file in the cockpit's editor
orbital tab new agent claude                    # boot another agent in this worktree
\`\`\`

When you start or stop a long-running dev server, tell the cockpit — the human
gets a one-click way to open it, and the tab menu lists it:

\`\`\`sh
orbital server add 5173        # a bare port expands to http://localhost:5173
orbital server remove 5173
orbital server list
\`\`\`

## Conventions worth following

- Register dev servers you start, and deregister them when you stop them.
- File follow-ups with \`orbital task add\` rather than growing the current change.
- Set \`needs-attention\` before asking a question the human must answer, so the
  cockpit surfaces you instead of waiting silently.
`
}

/** What Orbital would write, shown to the user before anything touches disk. */
export function plan(): ClaudeSkillPlan {
  return { skillPath: skillPath(), markdown: skillMarkdown() }
}

/** Whether the file at `file` is one Orbital wrote (carries the marker). */
function isOrbitalSkill(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').includes(SKILL_MARKER)
  } catch {
    return false
  }
}

/**
 * Write the skill. Refuses to touch a SKILL.md that exists but is NOT ours —
 * the user (or another tool) owns that file, and a personal skill overrides a
 * project one, so silently replacing it could change how their sessions behave.
 */
export function install(): ClaudeSkillStatus {
  const file = skillPath()
  if (existsSync(file) && !isOrbitalSkill(file)) {
    throw new Error(
      `${file} already exists and was not written by Orbital. Move or delete it first — ` +
        'Orbital will not overwrite a skill it does not own.'
    )
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, skillMarkdown(), 'utf8')
  return status()
}

/** Delete the skill — but only the SKILL.md that is ours, never a whole tree. */
export function remove(): ClaudeSkillStatus {
  const file = skillPath()
  if (existsSync(file) && isOrbitalSkill(file)) {
    rmSync(file, { force: true })
    // Claude Code treats the directory as the skill, so an empty one left behind
    // is a broken entry — but a skill dir can also hold supporting files someone
    // added (scripts, references). Take the directory only if nothing is in it.
    try {
      rmdirSync(dirname(file))
    } catch {
      /* not empty (or already gone) — leave whatever else lives there */
    }
  }
  return status()
}

/** Read-only source-of-truth check; never throws. */
export function status(): ClaudeSkillStatus {
  const file = skillPath()
  const exists = existsSync(file)
  const ours = exists && isOrbitalSkill(file)
  return { installed: ours, skillPath: file, foreign: exists && !ours }
}
