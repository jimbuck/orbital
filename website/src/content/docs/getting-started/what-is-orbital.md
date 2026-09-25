---
title: What is Orbital?
description: A native Windows cockpit for running many interactive coding agents side by side.
---

Orbital is a desktop app for people who run **multiple coding agents at once** —
Claude Code, Codex, or any CLI tool — across one or many repositories.

![The Orbital cockpit: projects and worktrees on the left, terminals in the middle, git panel and tasks on the right](../../../assets/screenshots/01-cockpit-overview.png)

## The problem it solves

An agent working on a real task blocks on you constantly: permission prompts,
clarifying questions, finished work waiting for review. With one agent that's
manageable. With three or four, plain terminal windows turn *you* into the
scheduler — alt-tabbing around, discovering that one agent has been stuck on a
permission prompt for ten minutes while another finished long ago.

Orbital's answer is a cockpit:

- Each stream of work runs in its own **worktree** — an isolated git worktree with
  its own branch, terminals, browser previews, and editor.
- Projects group into **workspaces**, each in its own window with its own theme,
  accent and agent profiles, so work and personal repos never mix.
- Every terminal carries a live **status**. The left rail, the title bar, and the
  Windows taskbar all tell you the moment an agent needs you.
- A built-in **git panel** and **task tracker** close the loop: review the diff,
  commit, push, mark the task done, delete the worktree.
- A **command palette** and cross-worktree **search** get you to any file,
  task, worktree or command from the keyboard.
- Agents take part through the `orbital` CLI: they report their status, claim
  and file tasks, and register dev servers. See
  [Working inside Orbital](/orbital/agents/overview/).

## What Orbital is *not*

- **It is not a wrapper around your agent, and it never spends tokens.** Orbital
  spawns the real interactive CLI in a real terminal (ConPTY), so you keep the
  full feature set of your preferred harness — slash commands, hooks, MCP
  servers, permission modes — and everything runs on your existing subscription
  instead of metered API usage. Orbital launches **Claude Code**, **Codex** and
  **Cursor**, with the deepest integration for Claude Code.
- **It is not a merge tool or CI system.** It orchestrates working copies and
  surfaces state; git semantics stay plain git.
- **It never writes into your repositories.** All of Orbital's state lives in
  SQLite under your user profile, and briefings and skills go into Orbital's
  app-data folder or your agent's profile directory. Worktrees are created in a sibling
  `.orbital-worktrees` directory, not inside your repo.

## The core loop

Throughout these docs we use three example projects: **nebula-shop** (a
storefront), **comet-api** (its order service), and **stardust-blog** (a content
site).

1. Add `nebula-shop` as a project.
2. Capture tasks as they occur to you ("Add checkout flow", "Fix cart badge count").
3. Start a worktree from a task — branch, worktree, terminal, one click.
4. Boot an agent in the worktree and brief it.
5. Keep working yourself; Orbital chimes when the agent needs you.
6. Review the diff in the git panel, commit, push, mark the task done.
