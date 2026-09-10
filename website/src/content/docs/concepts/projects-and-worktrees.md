---
title: Projects, Worktrees & tabs
description: Orbital's core model — how repos, worktrees, panes, and tabs fit together.
---

## Projects

A **project** is a local git repository opened in Orbital. The left rail lists
every project with an aggregate status dot and its worktrees. Add one with the
**+** button; remove one from Orbital by right-clicking its header (the repo and
its worktrees stay on disk).

The **Add project** dialog has three sources:

- **Local folder** — pick a folder that is already a git repository.
- **Clone from GitHub** — pick one of your repositories (or type `owner/repo`)
  and clone it into a folder of your choosing.
- **New GitHub repo** — create a repository on GitHub and clone it in one go.
  The form mirrors `gh repo create`: owner (you or one of your organizations),
  a name with a live availability check, visibility, description, and under
  *More options* a README, `.gitignore` template, license, template repository,
  homepage, issues/wiki toggles and an org team.

The GitHub sources use the [GitHub CLI](https://cli.github.com) (`gh`), so it
needs to be installed and signed in with `gh auth login`. Cloning goes through
`gh repo clone`, which picks HTTPS or SSH from your `gh` configuration and
supplies credentials, so private repositories work without extra setup.

## Worktrees

A **worktree** is a working surface bound to one working directory:

- The **root worktree** (`main` badge) is your normal checkout. Every project has
  exactly one, and it can't be removed.
- **Linked worktrees** are real `git worktree` checkouts on their own branch,
  created via **New Worktree** or from a task. They live in a
  sibling directory — for `C:\Projects\nebula-shop`, worktrees go under
  `C:\Projects\.orbital-worktrees\nebula-shop\<branch>` — so they never pollute
  the repo itself.

Orbital is a worktree *dashboard*, not just a worktree creator: every checkout
`git worktree list` reports shows up under the project automatically, wherever
it lives and however it was created. Run `git worktree add` in any terminal and
the new worktree appears in the rail within a second; remove one externally and
its entry (with its tabs and layout) goes away. Discovery runs at launch and
live, by watching each repo's `.git/worktrees` directory.

Branch names are slugified for you ("Login flow" → `login-flow`) and collisions
get numeric suffixes. If the branch already exists, Orbital attaches to it;
otherwise it forks a new branch from the base ref you chose (default `HEAD`).

Right-click a worktree to **rename** it, **close** it (keeping it on disk), or
**delete the worktree**. Deleting refuses to discard uncommitted or unpushed
work unless you explicitly force it.

### Env-file sync

New worktrees are seeded with the project's untracked env files (`.env`,
`.env.*` by default — configurable per project in Settings), and changes to
those files in the root checkout keep syncing to linked worktrees while Orbital
runs. Your feature branches are runnable immediately.

## Panes & tabs

Each worktree owns a **split tree of panes**, each pane a strip of tabs:

- **Terminal** — a real PTY running your shell.
- **Claude (agent)** — a PTY that boots straight into your coding agent.
- **Browser** — an in-app preview (plain-clicking a URL in any terminal opens
  one; Ctrl+click uses your system browser).
- **Editor** — file tree, syntax-highlighted source, diffs, previews, images.

Drag a tab to another pane's strip to move it, or to a pane **edge** to split in
that direction. Drag the dividers to resize. Layouts, tabs, and worktrees all
persist across restarts — terminals restart fresh (scrollback intentionally does
not persist), while scrollback *does* survive tab switches within a session.
