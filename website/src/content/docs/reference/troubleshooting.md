---
title: Troubleshooting
description: Common issues and how to resolve them.
---

## "orbital: not connected to Orbital — is the app running?"

The CLI couldn't reach the control pipe. Ensure the Orbital app is running, and
that you're in a terminal Orbital spawned (the CLI reads identity from the
`ORBITAL_*` environment variables — a terminal opened elsewhere won't have them).

## Deleting a worktree says it is dirty

That's the unpushed-work guard: `git worktree remove` refuses when the worktree
has uncommitted changes (or git considers it locked). The context menu then
offers **Force remove**, which discards those changes — commit or stash first if
you want them.

## A worktree's terminal is dead after restart

Terminals intentionally restart fresh (scrollback doesn't persist). If the
worktree's directory was deleted outside Orbital while the app was
closed, its terminals can't respawn — remove the worktree, or recreate it
at the same path.

## Native module errors when building from source

`node-pty` and `better-sqlite3` must be compiled against Electron's ABI:

```sh
npm run rebuild
```

You need the MSVC C++ build tools and Python. If winpty's helper build fails
with `MSB8040` (Spectre-mitigated libraries), the bundled patch already disables
that requirement — make sure `npm install` ran its postinstall step.

## Terminal renders oddly / GPU issues

Orbital uses xterm.js with WebGL and falls back to the canvas renderer when
WebGL is unavailable (e.g. a blocklisted GPU). If rendering looks wrong after a
driver update, restart the app first.

## The app won't start a second time

Orbital runs one window per workspace: launching a workspace that's already
open focuses its window instead of starting a new process. To open a
different workspace side by side, use **File ▸ Workspaces…** or the taskbar
icon's **Recent** list.

## A worktree doesn't have my latest `.env` changes

Env files are copied into a worktree once, when it's created, and not kept in
sync after that. Right-click the worktree and choose **Sync env files from
root**, or run `orbital worktree sync` in one of its terminals. Both overwrite
the worktree's copies.

## Agents don't report status

- Check the hooks are installed for the profile the agent tab uses: **Settings ▸
  Agents**, on that profile's card. Each profile directory needs its own install.
- If the card says **Update available**, update it. An Orbital update that
  moves the install location changes the CLI path the hooks call.
- A status that got stuck can be reset from the worktree's right-click menu
  with **Clear Status**.

## Reporting a crash

Turn on **Settings ▸ Debug logging**, reproduce the problem, then use **Open
log folder** and attach the latest log to a
[GitHub issue](https://github.com/jimbuck/orbital/issues).
