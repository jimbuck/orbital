---
title: Settings
description: Shell, alerts, env-file sync, agent providers, and the Claude hooks.
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

## Claude status hooks (machine-global)

Installs Orbital's status hooks into `~/.claude/settings.json` so Claude
sessions report status automatically:

- **Preview** the exact JSON before it's merged.
- Install is idempotent; **Remove** strips exactly Orbital's entries.
- The hook guards on Orbital's env vars — Claude sessions outside Orbital are
  untouched.
