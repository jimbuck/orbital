---
title: Workspaces, Flights & tabs
description: Orbital's core model — how repos, worktrees, panes, and tabs fit together.
---

## Workspaces

A **workspace** is a local git repository opened in Orbital. The left rail lists
every workspace with an aggregate status dot and its Flights. Add one with the
**+** button; remove one from Orbital by right-clicking its header (the repo and
its worktrees stay on disk).

## Flights

A **Flight** is a working surface bound to one working directory:

- The **root Flight** (`main` badge) is your normal checkout. Every workspace has
  exactly one, and it can't be removed.
- **Worktree Flights** are real `git worktree` checkouts on their own branch,
  created via **New Flight from worktree** or from a task. They live in a
  sibling directory — for `C:\Projects\nebula-shop`, worktrees go under
  `C:\Projects\.orbital-worktrees\nebula-shop\<branch>` — so they never pollute
  the repo itself.

Branch names are slugified for you ("Login flow" → `login-flow`) and collisions
get numeric suffixes. If the branch already exists, Orbital attaches to it;
otherwise it forks a new branch from the base ref you chose (default `HEAD`).

Right-click a Flight to **rename** it, **close** it (keep the worktree), or
**delete the worktree**. Deleting refuses to discard uncommitted or unpushed
work unless you explicitly force it.

### Env-file sync

New worktrees are seeded with the workspace's untracked env files (`.env`,
`.env.*` by default — configurable per workspace in Settings), and changes to
those files in the root checkout keep syncing to worktrees while Orbital runs.
Your feature branches are runnable immediately.

## Panes & tabs

Each Flight owns a **split tree of panes**, each pane a strip of tabs:

- **Terminal** — a real PTY running your shell.
- **Claude (agent)** — a PTY that boots straight into your coding agent.
- **Browser** — an in-app preview (plain-clicking a URL in any terminal opens
  one; Ctrl+click uses your system browser).
- **Editor** — file tree, syntax-highlighted source, diffs, previews, images.

Drag a tab to another pane's strip to move it, or to a pane **edge** to split in
that direction. Drag the dividers to resize. Layouts, tabs, and Flights all
persist across restarts — terminals restart fresh (scrollback intentionally does
not persist), while scrollback *does* survive tab switches within a session.
