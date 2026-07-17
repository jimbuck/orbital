---
title: The git panel
description: Stage, diff, commit, and push the active worktree without leaving the cockpit.
---

The right panel's git section always shows the **active worktree's** working tree —
in a linked worktree that's its own checkout, in the root worktree your main checkout.

## What's there

- **Branch + ahead/behind** counts against the upstream, with Pull / Fetch, and
  a **Push** that sets the upstream automatically on first push.
- **Staged** and **Changes** lists with per-file state badges
  (modified / added / deleted / renamed / untracked / conflicted).
- Hover a file for **stage / unstage / discard** actions. Discard (and
  discard-all) is a two-step confirm: first click arms it, ✓ executes. Untracked
  files are deleted; staged changes always survive a discard-all.
- **Commit** with an **Amend** toggle that prefills HEAD's message.

## Diffs

Click any changed file to open its diff in an editor tab — unified view, line
numbers on both sides, syntax-highlighted code, and `+N −N` counts in the
header. Staged files diff against the index.

![A syntax-highlighted diff opened from the git panel](../../../assets/screenshots/07-diff-view.png)

## Always current

Filesystem watchers cover every checkout — the repo root *and* each linked
worktree (including their real `HEAD`/`index`, which git keeps inside the main
repo's `.git/worktrees/`). Agent edits, terminal commits, checkouts from another
tool: the panel refreshes on its own, no manual reload.

## A review flow that works

When an agent reports done in `nebula-shop`'s `checkout-flow` worktree:

1. Activate the worktree — the panel is already scoped to it.
2. Walk the changed files, reading each diff.
3. Stage what's good; leave (or discard) what isn't.
4. Commit, push, open the PR from the worktree's terminal.
5. Right-click the worktree → **Delete worktree** once merged.
