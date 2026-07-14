---
title: The orbital CLI
description: Complete reference for the CLI available inside every worktree terminal.
---

Every terminal Orbital spawns has `orbital` on its `PATH`, connected back to the
running app over a local pipe. It's how agents (and you) drive the cockpit from
inside a worktree. Outside an Orbital terminal the identity environment variables
are absent and most commands will refuse to run.

## Status

```sh
orbital status <idle|working|needs-attention|error|done>
```

Sets the calling terminal's status. `needs-attention` triggers the alert
pipeline (rail badge, title-bar banner, taskbar badge, optional chime).

## Worktrees

```sh
orbital worktrees
```

Lists the project's worktrees: status, name, branch, id.

```sh
orbital worktree new [--worktree <branch>] [name]
```

Creates a linked worktree. The branch is slugified; an existing branch is
attached to, otherwise a new one is forked. Env files sync automatically.

```sh
orbital worktree new --worktree feature/checkout "Checkout flow"
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
orbital task add "<title>" [--description <text>]
orbital task list [--all]
orbital task update <id> [--status <status>] [--title <text>] [--description <text>]
orbital task done <id>
```

- `task list` prints open tasks with short ids (`--all` includes done):

  ```
  ID        STATUS       TITLE
  f907b669  in_progress  Add checkout flow
  cfff155f  todo         Fix cart badge count
  ```

- `task update` / `task done` accept any **unique id prefix** — `f907` works.
- Statuses: `draft`, `todo`, `in-progress`, `ready-for-review`, `done` (hyphens or
  underscores both accepted).

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

`orbital hook <event>` is used internally by the Claude Code hooks; it exits
silently outside Orbital sessions and never blocks Claude.

> `orbital flights` and `orbital flight new` still work as hidden aliases for the
> renamed `worktrees` / `worktree new` commands, so existing scripts keep running.
