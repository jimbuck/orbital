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
`orbital help` prints the usage.

If you're an agent, [Working inside Orbital](/orbital/agents/overview/) covers
which of these to use and when.

## Status

```sh
orbital status <idle|working|needs-attention|error|done>
```

Sets the calling terminal's status. `needs-attention` triggers the alert
pipeline (rail badge, title-bar banner, taskbar badge, optional chime).

```sh
orbital whoami
```

Everything the cockpit knows about the calling terminal — project, repo,
worktree, branch, path, current status, linked task, and registered dev servers:

```
project      orbital
repo         orbital
worktree     Login flow (linked)
branch       feature/login
path         C:\Projects\.orbital-worktrees\orbital\feature-login
status       working
task         #12 Add checkout flow (in_progress)
servers      http://localhost:5173/
```

## Projects

```sh
orbital project
```

The calling terminal's project, read live: its root folder, its home repo, and
each member repo with the branch of its root checkout, whether that checkout has
uncommitted changes, how many worktrees Orbital has for it, and its path. The
calling terminal's own repo is marked `*`.

```
project      platform
root         C:\Projects\platform
home         docs (C:\Projects\platform\docs)

   NAME         BRANCH  STATE  WORKTREES  PATH
   docs (home)  main    clean  0          C:\Projects\platform\docs
*  api          main    dirty  2          C:\Projects\platform\api
   web          main    clean  1          C:\Projects\platform\web
```

`--json` adds each repo's remote, its worktrees (name, branch, path, linked
task), its open task count, and which of `AGENTS.md` / `CLAUDE.md` it has.

### Working across repos in a project

A project with more than one repo has a project session: its home repo's
checkout, or, with no home repo, a session in the project's root folder. Plan
work that spans repos there, then hand each repo its part:

```sh
orbital project                                                    # pick the repos
orbital worktree new --repo api --task 12 --worktree feat/health   # a worktree in api, linked to task #12
orbital tab new agent --repo api --worktree feat/health --prompt "Do task #12; run the tests"
orbital task add "Update the client for the new endpoint" --repo web
```

The folder session has no repo of its own, so task and worktree commands there
need `--repo`. Agents in the project session can read and edit every member repo
without a prompt (Claude and Codex get them through `--add-dir`); agents in a
member repo get the home repo the same way.

## Repos

```sh
orbital repos
```

Lists the repos in this instance's workspace: name, id, and repo path. The
calling terminal's own repo is marked `*`.

```
   NAME  ID                                    REPO PATH
*  web   3f1c2a9e-5b7d-4e0a-9c1b-8d2e6f4a7b10  C:\Projects\web
   api   b82d4e61-0a3c-4f9e-8b5d-1c7a2e9f6d34  C:\Projects\api
```

Task and worktree commands act on the calling terminal's repo. Add
`--repo <name|id>` to `worktrees`, `worktree new`, or any `task` command to
target a sibling repo in the same workspace instead. The name match ignores
case, and a unique id prefix works too. Passing the flag is the opt-in: without
it nothing reaches beyond your own repo, and with it reads and writes both go
through. Repos in other workspaces are never reachable, and neither the
flag nor a spoofed `ORBITAL_REPO_ID` gets past that check.

```sh
orbital task list --repo api
orbital task add "Bump the client to v2" --repo api
orbital worktree new --repo api --worktree feat/v2-client
```

## Worktrees

```sh
orbital worktrees [--repo <name|id>]
```

Lists the repo's worktrees: status, name, branch, id.

```sh
orbital worktree new [--worktree <branch>] [--existing-branch <branch>] [--base <ref>] [--task <number>] [--repo <name|id>] [name]
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

```sh
orbital worktree sync
```

Copies the root checkout's env files (the patterns in Settings ▸ Environment
file sync) into the calling worktree again, **overwriting** its copies. Env
files are copied once at creation and never kept in sync, so run this when the
root's copies have changed. Prints how many files it copied.

## Tabs

```sh
orbital tab new <terminal|browser|editor|agent|search> [arg] [--repo <name|id>] [--worktree <name|branch>]
orbital tab new agent [profile] --prompt "<text>" [--repo <name|id>] [--worktree <name|branch>]
```

Opens a tab in the calling worktree. The argument is type-specific: a URL for
`browser`, a file path for `editor`, the name of a configured agent profile for
`agent`, a query for `search`.

- `--repo` opens the tab in that repo's root checkout instead.
- `--worktree` opens it in one of the repo's worktrees, by name, branch or id
  (this terminal's repo unless `--repo` names another).
- `--prompt` starts the agent with that prompt. It is sent on the tab's first
  launch only; when the tab comes back after a restart it resumes the
  conversation and does not send the prompt again. Claude and Codex take one;
  Cursor does not. On Windows, when the agent runs through a `.cmd` shim, line
  breaks in the prompt become spaces and double quotes become single quotes.

```sh
orbital tab new browser http://localhost:3000
orbital tab new editor src/lib/cart.ts
orbital tab new agent "Claude (work)"
orbital tab new search "TODO("
orbital tab new terminal --repo api
orbital tab new agent --repo api --prompt "Add the /health endpoint, then run the tests"
```

## Tasks

```sh
orbital task add "<title>" [--description <text>] [--tags <a,b,c>]
orbital task list [--all | --archived] [--status <status>] [--tag <tag>]
orbital task show <number|id>
orbital task update <number|id> [--status <status>] [--title <text>] [--description <text>] [--tags <a,b,c>]
orbital task start <number|id> [--worktree <branch>] [--base <ref>] [name]
orbital task done <number|id>
orbital task archive <number|id>
orbital task unarchive <number|id>
```

Every `task` command also takes `--repo <name|id>` to work on a sibling
repo's tasks (see [Repos](#repos)).

- `task list` prints open tasks by number (`--all` includes done and archived
  ones; an explicit `--status` also shows done ones; `--archived` shows only
  archived tasks):

  ```
  ID   STATUS       TITLE                 TAGS       WORKTREE
  #12  in_progress  Add checkout flow     ui,cart    linked
  #13  todo         Fix cart badge count
  ```

- `task show` prints every field, including who filed the task (`user` from
  the cockpit UI, `agent` from this CLI) and when it was created and last
  updated, plus when it was archived if it was; `--json` carries them as
  `createdBy`, `createdAt`, `updatedAt` and `archivedAt` (unix milliseconds;
  `archivedAt` is `null` for an active task).
- Tasks are never deleted. `task archive` hides one from the board, the side
  panel and `task list`, but keeps it with its number; `task unarchive` brings
  it back. `task delete` is an alias for `task archive`, kept so existing
  scripts work.
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
| `ORBITAL_REPO_ID` | The worktree's repo; empty in a project's folder session, which has no repo |
| `ORBITAL_PROJECT_ID` | The worktree's project |
| `ORBITAL_SOCKET` | The control pipe the CLI connects to |

`ORBITAL_WORKTREE_ID` is the reliable "am I inside Orbital?" check.

`orbital hook <event>` is used internally by the Claude Code hooks; it exits
silently outside Orbital sessions and never blocks Claude.

> `orbital flights` and `orbital flight new` still work as hidden aliases for the
> renamed `worktrees` / `worktree new` commands, so existing scripts keep running.
> Likewise, `orbital projects` and `--project <name|id>` are deprecated aliases for
> `orbital repos` and `--repo <name|id>`: `--project` still names a repo.
>
> Before projects existed, `ORBITAL_PROJECT_ID` carried the repo id. The CLI
> reads the repo from `ORBITAL_REPO_ID` whenever that variable is set, and falls
> back to `ORBITAL_PROJECT_ID` only in a terminal an older build opened.
