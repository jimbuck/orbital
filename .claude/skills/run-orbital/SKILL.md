---
name: run-orbital
description: Build, run, and drive the Orbital Electron app. Use when asked to start the app, take a screenshot of it, or verify a UI change (git panel, tabs, rail) in the real running app.
---

Orbital is a Windows Electron app (electron-vite). For agent/automated use,
drive it via the line-oriented driver at `.claude/skills/run-orbital/driver.mjs`
(playwright-core `_electron`). No xvfb needed — this repo targets Windows with a
real display.

## Prerequisites

`playwright-core` is a devDependency — `npm install` covers it.

## Build

The driver launches the **built** app (`out/`, package.json `main`), not the dev
server — so main/preload/renderer changes all need a build first:

```powershell
npm run build
```

## Run (agent path)

Pipe commands on stdin (bash heredoc works well); the driver is also an
interactive REPL when run from a terminal:

```bash
node .claude/skills/run-orbital/driver.mjs <<'EOF'
launch
ss boot
panel
click-title Stage all
waittext Working tree clean
msg My commit title\n\nBody line.
click-text Commit
waittext No staged changes
ss committed
quit
EOF
```

Screenshots land in `%TEMP%\orbital-shots` (override: `SCREENSHOT_DIR`).
**Look at the screenshots** — a blank frame means the launch failed.

### Commands

| command | what it does |
|---|---|
| `launch` | launch the built app, wait for the UI |
| `ss [name]` | screenshot → `%TEMP%\orbital-shots\NN-<name>.png` |
| `click <css-sel>` | DOM click (works on hover-hidden buttons) |
| `click-title <title>` | click a button by `title` attr (exact, then prefix) |
| `click-text <text>` | click a button/link/tab by its text |
| `row <path> <title>` | git-panel row action, e.g. `row src/foo.ts Stage`, `row _tmp.txt Delete file`, then `row _tmp.txt Confirm` |
| `panel` | print the right rail's text (git status + tasks) — the quickest state check |
| `msg <text>` | fill the commit textarea (`\n` → newline) |
| `type <text>` / `press <key>` | keyboard input |
| `wait <css-sel>` | wait for element (10s) |
| `waittext <substr>` | poll page text for substring (15s); `waittext !<substr>` waits for it to disappear |
| `eval <js>` / `text [sel]` | evaluate JS / print innerText |
| `windows` | list windows |
| `sleep <ms>` | pause |
| `quit` | close app, exit |

Lines starting with `#` are comments.

## Run (human path)

```powershell
npm run dev   # electron-vite dev with renderer HMR (main/preload changes still need a restart)
```

## Gotchas (all actually hit)

- **Single-instance lock (per workspace).** The lock is keyed by the instance's
  profile dir (`<root>/profiles/<workspace-id>`), so there is one window per
  WORKSPACE; a second launch of the same workspace quits instantly and focuses
  the first. Kill strays with `Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force`
  (same cleanup if the driver crashes — the app child is NOT auto-killed).
  **If the user's installed cockpit (`Orbital.exe`) is running, do NOT kill it** —
  set `ORBITAL_USER_DATA=<fresh dir>` in the driver's environment instead: it
  relocates the whole app-storage root (the shared `orbital.db` + profiles), so a
  sandboxed instance runs side-by-side. The Add Project flow needs a native folder
  picker, so seed the sandbox DB directly (sqlite via python; schema is in
  `src/main/db/database.ts`). Easiest recipe: boot once against the empty sandbox
  (creates the schema + a Default workspace row), then insert projects with
  `workspace_id = (SELECT id FROM workspaces)` + a root worktree + one pane row.
  A no-arg launch opens the most recently opened workspace;
  `ORBITAL_WORKSPACE_ID=<id>` (or `--workspace-id`) pins one. Each instance binds
  its own control pipe (`orbital-control-<id16>`), and `ORBITAL_SOCKET` in its
  terminals points at the right one — but a CLI invoked OUTSIDE an Orbital
  terminal falls back to the legacy global pipe name and may find nothing.
- **`app.close()` can hang** when PTY children linger; the driver's `quit`
  races it against a 10s deadline and then hard-kills. If a run still leaves an
  `electron.exe` behind, use the Stop-Process line above.
- **The app uses the real user DB** (`%APPDATA%\orbital\orbital.db`): it opens
  every registered workspace, respawns saved tabs (including `agent` tabs, which
  boot a real idle agent session — Claude or Codex), and git actions hit real
  repos. The first
  workspace ("orbital", this repo) is auto-selected at boot.
- **Both rails are `<aside>`.** The git panel / task rail is `aside.border-l`;
  a bare `aside` selector gets the left workspace rail.
- **Git-panel row actions are hover-revealed** (`opacity-0`), so coordinate
  clicks miss them — the driver's DOM-based `click`/`row` work regardless.
- **Buttons disable while a git op runs, and the panel can repaint before the
  busy flag clears** — e.g. right after "Stage all", `waittext Working tree clean`
  passes while Commit is still disabled, so an immediate click lands on a
  disabled button and silently does nothing. The driver's click commands retry
  for 5s while the target is missing/disabled (`DISABLED_TIMEOUT` on give-up).
- **When amending with a new message, `msg` BEFORE clicking the Amend checkbox**
  — toggling Amend with an empty box async-prefills HEAD's message and would
  clobber a message filled afterwards.
- **Locate the commit textarea by element, not placeholder** — toggling Amend
  changes the placeholder from "Commit message…" to "Amended commit message…".
  (`msg` already does this.)
- **`AttachConsole failed` stderr spam from node-pty** when launched without a
  console — harmless, terminals work; the driver swallows it.
- **Inspecting the DB:** the repo's `better-sqlite3` is rebuilt for Electron's
  ABI, so plain `node` can't load it — use `python -c "import sqlite3; ..."`.

## Troubleshooting

- **Launch timeout:** `out/` missing or stale → `npm run build`.
- **`aside.border-l` wait times out:** renderer crashed — `ss` anyway and check
  the screenshot; renderer console errors are visible via `eval` on a relaunch.
