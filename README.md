# Orbital

> **Get work done from orbit.** A native Windows desktop cockpit for running and
> managing many interactive coding-agent sessions (Claude Code, Codex, or any CLI
> agent) side by side — each in its own git worktree, each grouping its own
> terminals, browser previews, and a file/diff viewer, with an at-a-glance signal
> of which agent needs you.

Orbital does **not** run agents or spend tokens. It spawns **real interactive
terminals**, so all agent usage stays on your existing subscription. See
[`Orbital_PRD_v1.1.md`](./Orbital_PRD_v1.1.md) for the full product spec.

## Concepts

- **Workspace** — a local git repo opened in Orbital (left rail).
- **Flight** — a working surface bound to one working directory: the **root**
  checkout (always present) or a **worktree**. Owns split panes of tabs.
- **Tab** — a terminal, an in-app browser, or a lightweight editor (file tree +
  diffs + light inline edits).
- **Status** — each terminal reports `idle · working · needs-attention · error ·
  done`; a Flight shows the most attention-worthy of its terminals.
- **Task** — a lightweight per-workspace tracker (list / board) with a one-action
  bridge to *start a Flight from a task*.
- **Orbital CLI** — an `orbital` command on `PATH` inside every Flight terminal
  that lets an agent set its status, list/create Flights, open tabs, and add tasks.

## Stack

Electron · electron-vite · React 18 · Tailwind v4 · TypeScript ·
node-pty (ConPTY) + xterm.js (WebGL) · better-sqlite3 · chokidar · zustand · Lucide.

## Getting started

```sh
npm install        # installs deps; postinstall applies the node-pty patch (below)
npm run rebuild    # compile node-pty + better-sqlite3 against Electron's ABI
npm start          # build the CLI, then launch the app (electron-vite dev)
```

Then:

1. Click **+** in the left rail (or the Add-workspace card) and pick a local git
   repo. A **root Flight** appears with a live terminal.
2. Run an agent (`claude`, `codex`, …) in the terminal.
3. Have the agent (or you) run `orbital status needs-attention` — the rail badge
   pulses, a title-bar banner appears, and the taskbar icon is badged.
4. **New Flight from worktree** (rail) creates a git worktree, a new Flight, and
   syncs your `.env` files into it.

### Native build notes (Windows)

`node-pty` and `better-sqlite3` are native modules compiled for Electron's ABI.

- `npm run rebuild` runs `electron-rebuild` for both.
- A small patch (`patches/node-pty+1.1.0.patch`, applied automatically by the
  `postinstall` hook via `patch-package`) makes node-pty's bundled **winpty**
  build portable: it calls its helper `.bat` scripts with a `.\` prefix (so it
  works even when `NoDefaultCurrentDirectoryInExePath` is set) and disables the
  optional **Spectre-mitigated libraries** requirement (`MSB8040`), which is not
  installed by default with Visual Studio Build Tools.
- You need the **MSVC C++ build tools** and Python (the standard node-gyp
  prerequisites).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm start` / `npm run dev` | build the CLI and launch the app in dev (HMR) |
| `npm run build` | type-check-free production build of main/preload/renderer |
| `npm run make` | build + package a Windows installer (electron-builder) |
| `npm run rebuild` | recompile native modules for Electron |
| `npm run typecheck` | `tsc --noEmit` for node + web project references |
| `npm run lint` | ESLint |
| `npm run build:cli` | bundle the `orbital` CLI to `resources/cli/orbital.js` |

## The `orbital` CLI

Available inside any Flight terminal:

```sh
orbital status <idle|working|needs-attention|error|done>
orbital flights
orbital flight new [--worktree <branch>] [name]
orbital tab new <terminal|browser|editor> [arg]
orbital task add "<title>" [--description <text>]
```

Wire it into Claude Code's hooks so status updates happen automatically — see
[`docs/claude-code-hooks.md`](./docs/claude-code-hooks.md).

## Layout

```
src/
  shared/types.ts          Shared contract (domain types, IPC channels, CLI protocol)
  main/                    Electron main process
    index.ts               App lifecycle + frameless window
    ipc.ts                 IPC handlers + CLI control dispatcher
    runtime.ts             Service hub + renderer broadcasts
    db/                    better-sqlite3 schema + repositories
    services/              git · worktree · env-sync · terminals · control-channel · alerts
  preload/index.ts         contextBridge -> window.orbital
  renderer/                React + Tailwind cockpit
  cli/orbital.ts           The `orbital` CLI (bundled to resources/cli)
design/                    The source design (cockpit + Tailwind guide) as HTML
```
