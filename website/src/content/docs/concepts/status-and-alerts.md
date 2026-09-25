---
title: Status & alerts
description: How Orbital knows what every agent is doing, and how it gets your attention.
---

Every terminal and agent tab carries one of five statuses:

| Status | Meaning |
|---|---|
| `idle` | Waiting for the next instruction |
| `working` | Actively doing something |
| `needs-attention` | **Blocked on a human** — the load-bearing signal |
| `error` | Something failed |
| `done` | The current task is complete |

Each status has its own mark: a comet orbiting while *working*, an amber beacon
for *needs-attention*, a red core for *error*, a heavy green ring for *done*,
and a thin grey ring at rest.

A worktree surfaces the most attention-worthy status among its terminals
(`needs-attention` beats `error` beats `working` …). A project's header row is
its root worktree, so its dot reports the root alone. The linked worktrees
beneath it roll up into the project's chevron, which takes their most urgent
colour and, while collapsed, pulses for needs-attention or error. One glance at
the rail answers "who needs me?"

![An agent needing attention: rail badge, title-bar banner, taskbar badge](../../../assets/screenshots/04-status-alert.png)

## The three-way alert

When a worktree flips to needs-attention:

1. The **rail** shows an amber count badge on the project (counting its linked
   worktrees) and a "needs you" label on the worktree.
2. The **title bar** shows an "N agents need you" banner.
3. The **Windows taskbar** icon lights up — the orbiting satellite in the app
   icon swells and glows amber — the taskbar button **flashes** while Orbital
   is in the background, and an optional **chime** plays on the rising edge.

Each channel can be toggled independently in Settings.

## How statuses update

- **Claude Code hooks (recommended).** Install once per Claude profile from
  **Settings ▸ Agents**; every Claude
  session launched inside Orbital then reports itself automatically — *working*
  on tool use, *needs-attention* on permission/idle prompts, *idle* on stop,
  *done* on session end. See [Wiring up your agent](/orbital/agents/integration/#claude-status-hooks).
- **Explicitly, from any agent or script:** `orbital status needs-attention`.
- **Typing clears it.** When you type into an agent or terminal that is
  needs-attention, you have by definition responded — the status flips back
  immediately (to *working* after a permission prompt, *idle* otherwise)
  instead of waiting for the next hook event.
- A terminal whose process exits stops contributing its stale status.
