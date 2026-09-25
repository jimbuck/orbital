---
title: Tasks
description: Capture work in one keystroke, launch it as a worktree, and let agents work the same board.
---

Each project has a lightweight task tracker in the right panel, built for
capture speed rather than ceremony.

## Capturing

Type into **Capture a task…** and press Enter. The task lands in the active
project as `todo` with the next task number. Numbers are unique across all
your projects, so `#42` always means one task.

Each card shows its number and title, a status chip, tags, a link to its
worktree when it has one, and a small mark when an agent filed it rather than
you.

## Editing

Click a task's title to open it in the **Edit Task** dialog:

- the title
- a **status**: `draft → todo → in progress → ready for review → done`
- a **Markdown description** with a write/preview toggle
- **tags**, with suggestions from the tags you've already used (Enter or comma
  adds one, Backspace removes the last)
- who filed it (you or an agent) and when it was created and last updated

![The Edit Task dialog](../../../assets/screenshots/09-tasks-board.png)

Right-click a card for **Edit task**, **Start Worktree** (or **Go to Worktree**
once it has one) and **Delete task**.

`draft` is for half-formed ideas you don't want to read as ready work.

## The full board

The expand button at the top of the task list opens the **full board**: every
project as a swim-lane across the status columns. Drag cards between columns to
change status, and between lanes to move a task to another project. Hover an
empty spot in a column to add a task straight into it. The same board is on
**View ▸ All Tasks…**.

![The all-projects board](../../../assets/screenshots/10-board-all.png)

## From task to worktree

Press the ▶ button on any unlinked task to open **New Worktree** pre-filled and
pre-linked: the name comes from the task title, and once created the task
shows a link to its worktree and moves to *in progress*. Finish the work, mark
the task done, delete the worktree. The whole loop lives in one panel.

## Tasks for agents

Agents see the same board through the `orbital` CLI:

```sh
orbital task add "Fix cart badge count" --description "Badge shows items, not quantity" --tags ui,cart
orbital task list
# ID   STATUS       TITLE                 TAGS     WORKTREE
# #12  in_progress  Add checkout flow     ui       linked
# #13  todo         Fix cart badge count  ui,cart
orbital task update 13 --status in-progress
orbital task done 13
```

Every command takes a task number (`13` or `#13`) or a unique id prefix.
Orbital's briefing and skill tell agents to move a task to `in-progress` when
they start it and to file discovered work instead of drifting scope. See
[Working inside Orbital](/orbital/agents/overview/).
