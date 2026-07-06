---
title: The orbital CLI
description: Complete reference for the CLI available inside every Flight terminal.
---

Every terminal Orbital spawns has `orbital` on its `PATH`, connected back to the
running app over a local pipe. It's how agents (and you) drive the cockpit from
inside a Flight. Outside an Orbital terminal the identity environment variables
are absent and most commands will refuse to run.

## Status

```sh
orbital status <idle|working|needs-attention|error|done>
```

Sets the calling terminal's status. `needs-attention` triggers the alert
pipeline (rail badge, title-bar banner, taskbar badge, optional chime).

## Flights

```sh
orbital flights
```

Lists the workspace's Flights: status, name, branch, id.

```sh
orbital flight new [--worktree <branch>] [name]
```

Creates a worktree Flight. The branch is slugified; an existing branch is
attached to, otherwise a new one is forked. Env files sync automatically.

```sh
orbital flight new --worktree feature/checkout "Checkout flow"
```

## Tabs

```sh
orbital tab new <terminal|browser|editor|agent> [arg]
```

Opens a tab in the calling Flight. The argument is type-specific: a URL for
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
- Statuses: `todo`, `in-progress`, `ready-for-review`, `done` (hyphens or
  underscores both accepted).

## Dev servers

```sh
orbital server add <url|port>
orbital server remove <url|port>
orbital server list
```

Registers/deregisters a live dev server for the calling Flight. `3000` expands
to `http://localhost:3000`; `remove` matches by exact URL or by port.
Registered servers appear in the title-bar pill and the add-tab menu. See
[Dev servers](/orbital/guides/dev-servers/).

## Environment

Orbital injects these into every Flight terminal:

| Variable | Meaning |
|---|---|
| `ORBITAL_TERMINAL_ID` | The calling terminal's tab id |
| `ORBITAL_FLIGHT_ID` | The Flight the terminal belongs to |
| `ORBITAL_WORKSPACE_ID` | The Flight's workspace |
| `ORBITAL_SOCKET` | The control pipe the CLI connects to |

`orbital hook <event>` is used internally by the Claude Code hooks; it exits
silently outside Orbital sessions and never blocks Claude.
