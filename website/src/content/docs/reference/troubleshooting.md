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

Orbital is single-instance per profile: launching it again focuses the existing
window instead of starting a new process.
