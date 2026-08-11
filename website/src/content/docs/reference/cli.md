---
title: The orbital CLI
description: Complete reference for the CLI available inside every worktree terminal.
---

Every terminal Orbital spawns has `orbital` on its `PATH`, connected back to the
running app over a local pipe. It's how agents (and you) drive the cockpit from
inside a worktree. Outside an Orbital terminal the identity environment variables
are absent and most commands will refuse to run.

Add `--json` to any command to get the raw response payload instead of a
formatted table — use it whenever something is going to parse the output.

## Status

```sh
orbital status <idle|working|needs-attention|error|done>
```

Sets the calling terminal's status. `needs-attention` triggers the alert
pipeline (rail badge, title-bar banner, taskbar badge, optional chime).

```sh
orbital whoami
```

Everything the cockpit knows about the calling terminal — project, worktree,
branch, path, current status, linked task, and registered dev servers:

```
project      orbital
worktree     Login flow (linked)
branch       feature/login
path         C:\Projects\.orbital-worktrees\orbital\feature-login
status       working
task         #12 Add checkout flow (in_progress)
servers      http://localhost:5173/
```

## Worktrees

```sh
orbital worktrees
```

Lists the project's worktrees: status, name, branch, id.

```sh
orbital worktree new [--worktree <branch>] [--existing-branch <branch>] [--base <ref>] [--task <number>] [name]
```

Creates a linked worktree. The branch is slugified; an existing branch of that
name is attached to, otherwise a new one is forked. Env files sync automatically.

- `--existing-branch` checks out a branch that already exists instead of forking
  a new one. A remote-only pick (`origin/pr-42`) gets a local tracking branch.
- `--base` forks the new branch from a ref other than `HEAD`.
- `--task` links a task to the new worktree and moves it to *in progress*.

```sh
orbital worktree new --worktree feature/checkout "Checkout flow"
orbital worktree new --existing-branch origin/pr-42
orbital worktree new --worktree feature/x --base main
```

## Tabs

```sh
orbital tab new <terminal|browser|editor|agent> [arg]
```

Opens a tab in the calling worktree. The argument is type-specific: a URL for
`browser`, a file path for `editor`, a provider name for `agent`.

```sh
orbital tab new browser http://localhost:3000
orbital tab new editor src/lib/cart.ts
```

## Tasks

```sh
orbital task add "<title>" [--description <text>] [--tags <a,b,c>]
orbital task list [--all] [--status <status>] [--tag <tag>]
orbital task show <number|id>
orbital task update <number|id> [--status <status>] [--title <text>] [--description <text>] [--tags <a,b,c>]
orbital task start <number|id> [--worktree <branch>] [--base <ref>] [name]
orbital task done <number|id>
orbital task delete <number|id>
```

- `task list` prints open tasks by number (`--all` includes done ones; an
  explicit `--status` implies `--all`):

  ```
  ID   STATUS       TITLE                 TAGS       WORKTREE
  #12  in_progress  Add checkout flow     ui,cart    linked
  #13  todo         Fix cart badge count
  ```

- Every command that takes a task accepts its **number** (`12` or `#12`) or a
  **unique id prefix** — `f907` works.
- Statuses: `draft`, `todo`, `in-progress`, `ready-for-review`, `done` (hyphens or
  underscores both accepted).
- `task start` is the scriptable form of the task board's play button: it creates
  a worktree named after the task, links the two, and moves the task to
  *in progress*.

## Dev servers

```sh
orbital server add <url|port>
orbital server remove <url|port>
orbital server list
```

Registers/deregisters a live dev server for the calling worktree. `3000` expands
to `http://localhost:3000`; `remove` matches by exact URL or by port.
Registered servers appear in the title-bar pill and the add-tab menu. See
[Dev servers](/orbital/guides/dev-servers/).

## Environment

Orbital injects these into every worktree terminal:

| Variable | Meaning |
|---|---|
| `ORBITAL_TERMINAL_ID` | The calling terminal's tab id |
| `ORBITAL_WORKTREE_ID` | The worktree the terminal belongs to |
| `ORBITAL_PROJECT_ID` | The worktree's project |
| `ORBITAL_SOCKET` | The control pipe the CLI connects to |

`ORBITAL_WORKTREE_ID` is the reliable "am I inside Orbital?" check.

`orbital hook <event>` is used internally by the Claude Code hooks; it exits
silently outside Orbital sessions and never blocks Claude.

> `orbital flights` and `orbital flight new` still work as hidden aliases for the
> renamed `worktrees` / `worktree new` commands, so existing scripts keep running.
