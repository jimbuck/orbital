---
title: Settings
description: Shell, alerts, env-file sync, agent providers, the Claude hooks, and the orbital skill.
---

Open Settings from **File → Settings…**.

## Default shell

The shell new terminals run (PowerShell by default). Any executable on `PATH`
or an absolute path works — `pwsh`, `cmd`, a WSL launcher.

## Alerts

The three needs-attention channels are individually toggleable:

| Setting | Effect |
|---|---|
| In-app indicator | Rail badges + the title-bar "N agents need you" banner |
| Sound | A quiet chime on the *rising edge* (a newly blocked agent) |
| Taskbar badge | The taskbar icon's satellite swells and glows amber |

## Env-file sync (per project)

Glob patterns for untracked files to copy into new worktrees and keep synced
from the root checkout — `.env` and `.env.*` by default. Add patterns like
`.claude/settings.local.json` if your tooling keeps local config out of git.

## Agent (per project)

- **Default provider** — which agent an agent tab boots (Claude today).
- **Executable path** — explicit path override when the agent CLI isn't on
  `PATH`, or you want a specific installation.

## Claude status hooks

Installs Orbital's status hooks into the `settings.json` of the Claude profile
this workspace launches agents with (`~/.claude` unless the Claude agent above
sets a profile directory), so Claude sessions report status automatically:

- **Preview** the exact JSON before it's merged.
- Install is idempotent; **Remove** strips exactly Orbital's entries.
- Workspaces on different Claude profiles each need their own install — the
  badge reflects the profile this workspace actually uses.
- The hook guards on Orbital's env vars — Claude sessions outside Orbital are
  untouched.

## The orbital skill for Claude

Installs an [Agent Skill](https://code.claude.com/docs/en/skills) documenting the
`orbital` CLI, so Claude sessions you start by hand (agent tabs are briefed
already) know how to report status, file tasks, and register dev servers:

- **Preview** the exact `SKILL.md` before it's written.
- It goes to `skills/orbital/SKILL.md` in the Claude profile directory this
  workspace launches agents against, falling back to `~/.claude`.
- Orbital won't overwrite a skill it doesn't own, and **Remove** deletes only
  its own.

## Orbital instructions for Codex

Shown when Codex is one of the workspace's agents. Codex takes no briefing file,
so Orbital merges a short marked block into the `AGENTS.md` of its profile
directory (`CODEX_HOME`, else `~/.codex`) — the file Codex loads every session:

- **Preview** the exact block before it's written.
- Install rewrites just that block; **Remove** strips just that block and leaves
  the rest of your `AGENTS.md` alone.
