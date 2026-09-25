---
title: Working inside Orbital
description: What a coding agent needs to know when it runs in an Orbital worktree terminal.
---

This page is written for coding agents (Claude Code, Codex, Cursor, or a
script) as much as for the people who configure them. If you're an agent and
`ORBITAL_WORKTREE_ID` is set in your environment, you're running inside
Orbital, and this is how to behave.

## Where you are

Orbital runs several agent sessions side by side, each in its own git
worktree. A human is watching all of them from one window. They see a status
dot for your terminal, a task board for the project, and a list of dev
servers, and you control all three with the `orbital` CLI on your `PATH`.

Check once rather than guessing:

```sh
orbital whoami
```

```
project      nebula-shop
worktree     Checkout flow (linked)
branch       checkout-flow
path         C:\Projects\.orbital-worktrees\nebula-shop\checkout-flow
status       working
task         #12 Add checkout flow (in_progress)
servers      http://localhost:3000/
```

If `ORBITAL_WORKTREE_ID` is missing you're in an ordinary terminal. Every
`orbital` command will then fail with `not connected to Orbital`, and nothing
on this page applies.

Add `--json` to any command when you're going to parse the output.

## The conventions

These are what make an agent pleasant to run in a cockpit of several.

**Say when you're blocked.** Run `orbital status needs-attention` before asking
a question the human has to answer. That's what lights up the rail, the title
bar and the taskbar. Don't use it for progress updates; a chime has to mean
something. If Orbital's Claude status hooks are installed, Claude's own
lifecycle events already report `working`, `needs-attention`, `idle` and
`done`, and you don't need to call `orbital status` at all.

**Claim the task you're working on.** The board is how the human sees what's
underway. Move a task to `in-progress` the moment you start it, and to
`ready-for-review` or `done` when you finish:

```sh
orbital task update 12 --status in-progress
orbital task update 12 --status ready-for-review
```

A worktree opened with `orbital task start` has already done this for you.

**File follow-ups instead of growing the change.** When you notice unrelated
work (a flaky test, a missing index), capture it and carry on with what you
were asked to do:

```sh
orbital task add "Cart total ignores discounts" --description "seen in cart.ts:88" --tags bug,cart
```

**Register dev servers you start.** The human gets a one-click way to open
them, and so does every pane's add-tab menu:

```sh
orbital server add 5173      # when it starts
orbital server remove 5173   # when you stop it
```

**Stay in your worktree.** Your working directory is your own checkout on your
own branch. Other agents are working in the sibling worktrees that
`orbital worktrees` lists. Leave them alone.

## Useful beyond reporting

```sh
orbital tab new browser http://localhost:5173   # show the human a page, next to you
orbital tab new editor src/lib/cart.ts          # open a file in the cockpit's editor
orbital tab new search "TODO("                  # a content search the human can work through
orbital worktree new --worktree feat/x --base main "Spike: x"
orbital worktree sync                           # re-copy env files from the root checkout
```

Env files (`.env`, agent config directories) are copied into a worktree once,
when it's created. If the root checkout's copies have changed since, run
`orbital worktree sync`. It overwrites your worktree's copies.

The full command list is in the [CLI reference](/orbital/reference/cli/).

## How agents learn this

Orbital teaches the CLI to agents three ways, depending on how they were
started:

| Session | Gets the instructions from |
|---|---|
| An agent tab running Claude Code | A per-launch briefing passed as a system-prompt file |
| Claude started by hand in a terminal | [The `orbital` skill](/orbital/agents/skill/), if installed |
| Codex (tab or terminal) | A managed block in the profile's `AGENTS.md`, if installed |
| Cursor, or anything else | Nothing automatic. `orbital help` prints the usage. |

The briefing tells the agent its project, worktree, path and branch, then the
same conventions as above. It lives in Orbital's app-data folder and never in
your repository.

For a repository whose agents run both inside and outside Orbital, this line in
your `CLAUDE.md` or `AGENTS.md` covers the gap:

> If `ORBITAL_WORKTREE_ID` is set, you are inside the Orbital cockpit: report
> status, claim and file tasks, and register dev servers with the `orbital`
> CLI (`orbital help`).

## Machine-readable docs

These docs are also published as plain text for LLMs, see
[llms.txt](/orbital/agents/llms-txt/).
