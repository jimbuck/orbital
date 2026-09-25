---
title: The orbital skill
description: The full text of the Agent Skill and the Codex instructions Orbital installs.
---

This is exactly what Orbital writes when you install the `orbital` skill for a
Claude profile (**Settings ▸ Agents**, on the profile's card). It lands at
`<profile>/skills/orbital/SKILL.md`. Settings shows the same text under
**Preview** before anything touches disk.

The frontmatter pre-approves the read-only and status-reporting commands, so an
agent can say what it's doing without a permission prompt. Creating worktrees
or tabs and deleting tasks still ask.

If you'd rather not let Orbital write into your profile, you can copy this into
a skill or a `CLAUDE.md` yourself.

## SKILL.md

````md
---
name: orbital
description: Report status, file and progress tasks, list sibling worktrees, open tabs, and register dev servers in the Orbital cockpit via the `orbital` CLI. Use when working inside an Orbital worktree terminal (ORBITAL_WORKTREE_ID is set) and you need to tell the human something, capture follow-up work, or spin up a worktree.
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
  managed-by: orbital
  orbital-version: <app version>
---

# The `orbital` CLI

[Orbital](https://github.com/jimbuck/orbital) is a cockpit that runs several
coding-agent sessions side by side, each in its own git worktree. `orbital` is on
your PATH inside every terminal it spawns, and talks to the running app over a
local pipe.

**This skill only applies inside an Orbital terminal.** `ORBITAL_WORKTREE_ID` is
set there; if it is absent, you are in an ordinary terminal and every command
below will fail with `not connected to Orbital`. Check once rather than guessing:

```sh
orbital whoami          # project, worktree, branch, path, status, dev servers
```

Add `--json` to any command to get machine-readable output instead of a table —
prefer it when you intend to parse the result.

## Telling the human what is going on

```sh
orbital status working           # actively working
orbital status needs-attention   # blocked, waiting on a human (chimes + badges the rail)
orbital status idle              # waiting for the next instruction
orbital status error             # something broke
orbital status done              # the current task is complete
```

`needs-attention` is the load-bearing one: it is what makes the human look at
this worktree. Use it when you are genuinely blocked, not for progress updates.

If the Orbital Claude status hooks are installed (Settings → Claude status
hooks), these transitions are already reported for you from Claude's own
lifecycle events and you do not need to call `orbital status` at all.

## Tasks

A per-project tracker the human watches. File follow-up work you notice instead
of expanding the scope of what you were asked to do.

```sh
orbital task add "Write tests" --description "cover the parser" --tags test,parser
orbital task list [--all] [--status <status>] [--tag <tag>]   # open tasks (see below)
orbital task show 12                                          # full detail for one task
orbital task update 12 --status in-progress                   # progress it as you work
orbital task done 12
orbital task delete 12
```

Tasks are addressed by their number (`12` or `#12`, as shown in `task list`) or by
a unique id prefix. Statuses: `draft`, `todo`, `in-progress`, `ready-for-review`,
`done`. `task list` hides done tasks unless you pass `--all` or name a status
yourself, so `--status done` works on its own.

**Move the task as you work it.** The board is how the human sees what is
underway, and a task sitting in `todo` while you work on it tells them nobody
picked it up — which is how two people end up doing the same thing.

```sh
orbital task update 12 --status in-progress   # the moment you start on it
orbital task update 12 --status ready-for-review
orbital task done 12
```

Do this whether the task came from the human or from your own `task add`. The
one case you can skip it is a worktree opened with `orbital task start`, which
has already moved the task for you.

## Worktrees

```sh
orbital worktrees                                   # sibling worktrees: status, name, branch, id
orbital worktree new --worktree feat/login "Login flow"
orbital worktree new --existing-branch origin/pr-42 # check an existing branch out into a worktree
orbital worktree new --worktree feat/x --base main  # fork the new branch from a ref other than HEAD
orbital task start 12                               # worktree from task #12, branch named after it, task linked
orbital worktree sync                               # copy the root checkout's env files into this worktree again
```

A new worktree gets the project's env files (`.env`, agent config dirs) copied in
when it is created — once. They are not kept in sync afterwards, so if the root
checkout's copies have changed, `orbital worktree sync` copies them again
(overwriting this worktree's). `task start` is the scriptable form of the
cockpit's play button: it creates the worktree, links the task to it, and moves
the task to `in-progress`.

## Tabs and dev servers

```sh
orbital tab new terminal
orbital tab new browser http://localhost:5173   # in-app browser tab
orbital tab new editor src/lib/cart.ts          # open a file in the cockpit's editor
orbital tab new agent claude                    # boot another agent (by its configured name) here
orbital tab new search "TODO("                  # content search across this checkout
```

When you start or stop a long-running dev server, tell the cockpit — the human
gets a one-click way to open it, and the tab menu lists it:

```sh
orbital server add 5173        # a bare port expands to http://localhost:5173
orbital server remove 5173
orbital server list
```

## Conventions worth following

- Move the task you are working on to `in-progress` when you pick it up, and off
  it when you are done.
- Register dev servers you start, and deregister them when you stop them.
- File follow-ups with `orbital task add` rather than growing the current change.
- Set `needs-attention` before asking a question the human must answer, so the
  cockpit surfaces you instead of waiting silently.
````

## The Codex block

Codex loads its `AGENTS.md` in full at the start of every session, so its
block is shorter. Orbital writes it between
`<!-- orbital:begin managed-by: orbital -->` and `<!-- orbital:end -->`
markers in `$CODEX_HOME/AGENTS.md` (else `~/.codex/AGENTS.md`):

````md
## Orbital cockpit

When `ORBITAL_WORKTREE_ID` is set, this session is running inside a worktree of
the Orbital cockpit, and the `orbital` CLI on your PATH talks to it. If that
variable is NOT set, ignore this section — the CLI has no cockpit to reach.

- `orbital whoami` — project, worktree, branch, path, status, linked task, dev servers.
- `orbital status <working|needs-attention|idle|error|done>` — keep the cockpit honest
  about what you are doing. `needs-attention` is what makes the human look at this
  worktree, so set it when you are genuinely blocked on them.
- `orbital task add "<title>"` — file follow-up work you notice instead of expanding
  the current change; `orbital task list` to see the project's open tasks.
- `orbital task update <n> --status in-progress` the moment you start work on a task,
  and `orbital task done <n>` when it is finished. The board is how the human sees
  what is underway; a task left in `todo` while you work on it reads as unclaimed.
- `orbital server add <port>` when you start a dev server, `orbital server remove <port>`
  when you stop it, so the human can open it in one click.

`orbital help` lists everything else (worktrees, tabs). Add `--json` to any command
when you intend to parse the output.
````
