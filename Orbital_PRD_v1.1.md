# PRD: Orbital

**Author:** Jim Buck
**Status:** Draft v1.1 (clean break)
**Last updated:** June 23, 2026
**Audience:** Personal project / self-use only, not for distribution
**Name & theme:** Orbital. The theme is orbital mechanics; the tagline is *get work done from orbit*. You sit above several agents at once and drop into whichever one needs you.

> **Get work done from orbit.** Orbital is a native Windows desktop cockpit for running and managing many interactive coding-agent sessions (Claude Code, Codex, or any CLI agent) side by side, each in its own git worktree, each grouping its own terminals, browser previews, and a file/diff viewer. It adds the one thing a plain terminal cannot: an at-a-glance view of which agent needs you, plus a lightweight per-workspace task list to capture the work in the first place.

> **This is a clean break from v0.x.** The previous Orbital line (Orbit / Mission / Flight as an execution engine, the Claude Agent SDK, autonomous scheduling, gates, budgets) is **discarded**. Orbital no longer runs agents itself, calls any model, or spends any tokens. It spawns **real interactive terminals**, so all agent usage stays on your existing Claude (or other) subscription. What carries over is only the name, the space theme, the worktree-isolation instinct, and the goal of grouping terminals, code, and browser per active agent task. The model is inspired by Pane (runpane.com), rebuilt native, faster, simpler, and with the task tracking Pane lacks.

> **Note on the word "Flight."** It is reused. In v0.x a Flight was one execution episode of a workflow. Here a **Flight** is a working surface: a working directory (the repo root or a worktree) plus the tabs and status that ride on it. Anyone coming from the old PRDs should reset that meaning.

> **Changed in v1.1:** stack locked to **Electron**. Status now lives **per terminal**, and a Flight's status is the **aggregate** of its terminals' statuses; the status set adds **error** and **done**. **.env sync** is in scope (a user-editable wildcard list, Pane-style). The file tab is a **lightweight editor with inline edits**, not just a viewer. Terminal links: **plain click opens the in-app browser, Ctrl+Click opens the external browser** (reversed from v1.0). Agents keep running while the window is **minimized** and stop when the app is **closed**. The CLI gains **`orbital task add`**. A needs-attention Flight is surfaced three ways: a **global indicator, a sound, and a taskbar badge**.

---

## 1. Summary

Orbital opens local git repositories as **workspaces**, listed in a left rail. Under each workspace are its **Flights**. A Flight is a working surface bound to one working directory: every workspace always has a root-folder Flight (the main checkout), plus one Flight per git worktree. A workspace therefore has a minimum of one Flight and no maximum. The root Flight is a full Flight and can do everything a worktree Flight can.

A Flight owns a set of **tabs** in the main body of the window: terminals (where you run `claude`, `codex`, or anything else), in-app browsers (mainly to preview a dev server), and a lightweight VS Code-like file viewer (a file tree with git-status badges and diff viewing). Tabs split vertically or horizontally and resize freely. The point is that everything for one agent task, its terminal(s), its dev-server preview, its files and diffs, lives together in one Flight, and you switch between Flights to switch between agents.

Each Flight carries a **status** (idle, working, needs attention). An agent running inside a Flight reports its own status through the **Orbital CLI** (directly, or wired into the agent's hooks), so the left rail shows at a glance which of your several running agents is waiting on you. This is the core value: managing many Claude Code instances without babysitting each terminal.

Orbital also provides a deliberately **lightweight task tracker** per workspace: title, optional description, and a status (todo, in progress, ready for review, done), shown as a list or a kanban board. Tasks are just captured work. They are not tied to a Flight and create no worktree on their own. The one bridge is a **"start a Flight from this task"** action, which creates a worktree and a Flight for that task when you are ready to work it.

Orbital is native Windows, built fresh, with performance treated as a first-class requirement.

---

## 2. Goals & Non-Goals

### Goals

- Replicate the core of Pane: workspaces and their worktrees in one window, terminals/browser/editor grouped per working surface, an agent-operable CLI, a keyboard-friendly git workflow.
- Manage **many interactive agent sessions at once**, with a clear at-a-glance signal of which one needs attention.
- Make every Flight a real interactive terminal host, so agent usage stays on the user's subscription and Orbital spends no tokens.
- Provide a **lightweight per-workspace task tracker** (the feature Pane lacks), decoupled from execution, with a one-action bridge to start a Flight from a task.
- Provide the **Orbital CLI** so an agent inside a Flight can set the Flight's status, list workspace Flights, create Flights, and open tabs.
- Show **git state fast**: branch, ahead/behind, dirty state, a file tree with status badges, and diffs, updating responsively.
- **Sync gitignored environment files** (a user-editable wildcard list) from the root checkout into each worktree, so worktree Flights run with the same local config.
- Be **native Windows** and hit a clearly usable performance bar (§13).

### Non-Goals (v1)

- Running agents, calling any model, or spending tokens. Orbital hosts terminals; the agent runs in them.
- The entire v0.x engine (Orbit / Mission, the Agent SDK, autonomous scheduling, gates, exchanges, budgets). Discarded, not deferred.
- A server / remote-daemon version (control agents running on another machine or box). Deferred to a later version (§16).
- A mobile companion. Deferred.
- Per-worktree isolated ports. Out of scope for now. (`.env` sync is in scope, §5.)
- A full IDE. The editor tab is a lightweight editor (file tree with git status, diffs, and light inline edits with save), not a replacement for VS Code.
- Multi-user, accounts, cloud sync, or distribution.

---

## 3. Users & Use Cases

Single user: the author, who runs several Claude Code (and sometimes Codex) instances across one or more repos and wants to stop juggling scattered terminal windows, editors, and browser tabs, while always knowing which agent is blocked on him.

1. **Run several agents in parallel.** Open a workspace, create a few Flights (each on its own worktree), start `claude` in each. The left rail shows each Flight's status; the one that goes "needs attention" stands out, so you drop into it, answer, and move on.
2. **Capture work as a task.** Jot a task (title, maybe a description) into the workspace's list. Leave it as todo. Later, start a Flight from it, which spins up a worktree, and begin.
3. **Work the root checkout directly.** Use the root-folder Flight to run an agent or do git work straight on the main checkout, no worktree, exactly like any other Flight.
4. **Preview a dev server.** In a Flight, open a browser tab pointed at the dev server the agent just started; plain-click a link in the terminal to open it in that in-app browser, or Ctrl+Click to send it to the external browser.
5. **Review changes in place.** Open the file viewer in a Flight to see which files changed (git badges), read diffs, then commit and push from the right-hand git panel without leaving the window.
6. **Let agents self-organize.** An agent, instructed or hooked to do so, calls the Orbital CLI to mark itself "needs attention" when it stops for input, "working" when busy, and can even open a browser tab on the dev server it just launched or create a follow-up Flight.

---

## 4. Core Concepts

- **Workspace.** A local folder that is a git repo, added to Orbital and shown in the left rail. Contains Flights and a task list. Roughly "one project."
- **Flight.** A working surface bound to one working directory: either the **root checkout** (always present, one per workspace) or a **worktree** (zero or more). Owns a set of tabs; its status is an aggregate of its terminals' statuses. The root Flight has the same capabilities as worktree Flights. Minimum one per workspace, no maximum.
- **Worktree.** A git worktree under the workspace repo, created by Orbital (from a task, from the git panel, or via the CLI), backing a Flight. On creation, env files are synced into it (§5). Removable; on removal its Flight closes.
- **Tab.** A pane inside a Flight's main body. Three types: **terminal**, **browser**, **editor** (file tree + git status + diffs + light inline edits). Tabs split horizontally/vertically and resize.
- **Task.** A lightweight tracker item in a workspace: title, optional description, and a task status. Not bound to a Flight; creates no worktree by itself. Can launch a Flight.
- **Terminal status** (agent-activity signal, per terminal): `idle`, `working`, `needs attention`, `error`, `done`. Set by the agent in that terminal via the CLI or its hooks, or by the user. Default `idle`.
- **Flight status** (aggregate): derived from the Flight's terminal statuses by precedence (needs attention > error > working > idle > done), so the Flight surfaces its most attention-worthy terminal. Drives the left-rail badges.
- **Task status** (tracker state): `todo`, `in progress`, `ready for review`, `done`. Always set manually by the user.
- **Env sync.** A user-editable list of wildcard patterns per workspace; files matching them are synced from the root checkout into each worktree, so gitignored local config (`.env` and friends) is present in worktree Flights.
- **Orbital CLI.** A small `orbital` command available inside Flight terminals that lets an agent (or the user) act on Orbital: set the current terminal's status, list/create Flights in the current workspace, open tabs, and add a task.

Two distinct status concepts, kept deliberately separate: **terminal status** (rolled up into the Flight aggregate) is live agent activity; **task status** is tracker state. The CLI touches terminal status; the user touches task status.

---

## 5. Flights

A Flight is the cockpit unit. It binds a working directory to a set of tabs and a status.

- **Root Flight.** Always exists, one per workspace, bound to the repo's main checkout on whatever branch it is on. Full-featured: terminals, browser, viewer, git, status, agents.
- **Worktree Flights.** Created on demand. Each is bound to a git worktree (its own branch, isolated checkout), so multiple Flights run in parallel without colliding. Created from a task, from the git panel, or via the CLI.
- **Tabs.** Each Flight remembers its open tabs and their split layout, so switching back to a Flight restores its terminals, browser, and editor as they were. Terminal scrollback does not persist across app restarts; terminals start fresh.
- **Status.** Each terminal in a Flight has its own status; the Flight's status is the aggregate of them, by precedence (needs attention > error > working > idle > done), so the Flight surfaces its most attention-worthy terminal. Statuses are set per terminal by the agent through the CLI or its hooks, or by the user. The left rail renders the Flight aggregate, and needs-attention Flights are surfaced prominently so nothing is buried across many running agents.
- **Lifecycle.** Creating a worktree creates its Flight and syncs env files into it (below). On closing or completing a Flight, Orbital prompts to remove its worktree, guarding against unpushed work. The root Flight cannot be removed while its workspace is open. Agents and their terminals keep running while the app window is minimized; quitting the app (closing it) stops them.

**Environment file sync.** A fresh worktree lacks gitignored local files like `.env`, which a dev server needs. Orbital syncs them: each workspace has a user-editable list of wildcard patterns (for example `.env`, `.env.*`, `**/.env.local`), and files matching them are copied from the root checkout into every worktree Flight on creation and kept in sync as the source changes. This mirrors Pane's approach; the pattern list is edited in workspace settings. (Overwrite/conflict behavior when a worktree's own copy is edited locally is an open question, §16.)

---

## 6. Tabs

The main body of a Flight is a set of tabs across the top with a split, resizable pane area below.

- **Terminal.** A real interactive shell (PowerShell or the user's configured shell) running in the Flight's working directory, with the Orbital environment injected (§9) so the CLI works. This is where `claude`, `codex`, etc. run. Multiple terminals per Flight are allowed; each terminal carries its own status, and the Flight aggregates them (§5).
- **Browser.** An in-app web view, primarily to preview a dev server the Flight is running, usable for general browsing too. No per-worktree port isolation in v1. Terminal hyperlinks open here on plain click and in the external browser on Ctrl+Click (§7).
- **Editor.** A lightweight, VS Code-like view: a **file tree showing git status** (modified, added, untracked, etc.), a **diff/file viewer**, and **light inline edits with save**. It is not a full IDE, but you can read files, review diffs, and make quick edits without leaving the Flight.

Tabs split vertically or horizontally and resize, so a Flight can show, for example, a terminal beside a diff viewer with a browser preview below.

---

## 7. Terminal Links and the Browser

- A URL printed in a terminal is clickable.
- **Plain click** opens it in an in-app browser tab within the current Flight (the dev-server preview path).
- **Ctrl+Click** opens it in the system default browser.
- This keeps a Flight's preview alongside its terminal and diffs, while still letting you pop out when you want a real browser.

---

## 8. Tasks (lightweight tracker)

The capture surface that Pane lacks, deliberately minimal so it stays a sticky note rather than a second project tool.

- **Shape.** Title (required), description (optional), status (`todo` / `in progress` / `ready for review` / `done`). Per workspace.
- **Views.** A list or a kanban board, user's choice, surfaced both in the right-hand action panel (quick capture and triage) and in a fuller per-workspace view.
- **Decoupled by design.** Creating a task only records the work. It is not linked to any Flight and creates no worktree. The user changes a task's status by hand at any time, with or without ever starting a Flight.
- **The one bridge: start a Flight from a task.** This action creates a worktree on a branch named from the task title (slugified, with simple suffixing on collision) and a Flight for it, and leaves the first terminal ready (not seeded with anything special for now). The task and the new Flight are linked from that point (the Flight knows its originating task), but the task's status is **not** changed automatically; the user still moves it manually. A task can exist with no Flight, and starting a Flight from it is optional.

---

## 9. The Orbital CLI (agent-facing control)

A small `orbital` command is on PATH inside every Flight terminal. It is how an agent reports activity and organizes its own workspace, and it is what makes the cockpit aware of many agents at once.

- **Context.** When Orbital spawns a terminal, it injects environment variables identifying the terminal, Flight, and workspace and the local control channel (for example `ORBITAL_TERMINAL_ID`, `ORBITAL_FLIGHT_ID`, `ORBITAL_WORKSPACE_ID`, `ORBITAL_SOCKET`). The CLI reads these and talks to the running app over a local control channel (a Windows named pipe or a loopback socket). No network exposure.
- **Commands (initial set):**
  - `orbital status <idle|working|needs-attention|error|done>` sets the **current terminal's** status; the Flight status is the aggregate of its terminals (§5).
  - `orbital flights` lists the Flights in the **current workspace** (id, name, aggregate status), so an agent can see its siblings.
  - `orbital flight new [--worktree <branch>] [name]` creates a new Flight (and worktree) scoped to the current workspace.
  - `orbital tab new <terminal|browser|editor> [arg]` opens a tab within a Flight (for example a browser tab on a dev-server URL).
  - `orbital task add "<title>" [--description <text>]` adds a task to the current workspace.
- **Automation via hooks.** Status updates can be wired into the agent's own hook system so they happen without explicit calls: for example, Claude Code hooks can call `orbital status needs-attention` when the agent pauses for input and `orbital status working` / `idle` otherwise. Orbital ships suggested hook snippets; direct CLI calls are the baseline and work for any agent.
- **Agent-agnostic.** Nothing in the CLI is Claude-specific. Codex or any other CLI agent can call the same commands.

---

## 10. Git Integration (right action panel)

The resizable, collapsible right panel is the keyboard-friendly git surface for the active Flight.

- **Status at a glance:** current branch, ahead/behind, clean/dirty, staged vs unstaged counts, updating responsively (§13).
- **Actions:** stage / unstage, commit, push, pull, fetch, create/switch branch, and create a worktree (which creates a Flight).
- **Diffs:** view file diffs (in the file-viewer tab or the panel), with the file tree's git-status badges as the entry point.
- **Quick tasks:** the panel also hosts quick task capture and triage (§8), so capturing a thought and committing code both live on the right without leaving the Flight.

---

## 11. Layout and Surfaces

A single native window:

- **Left rail (resizable, collapsible).** Workspaces, each expandable to its Flights. Each Flight shows its aggregate status badge; `needs attention` is surfaced prominently. Add-workspace control at the bottom. When any Flight needs attention, Orbital surfaces it three ways so a blocked agent is never buried even when its workspace is collapsed or another workspace is focused: a global in-app indicator, a sound, and a Windows taskbar badge.
- **Main body.** The active Flight's tabs across the top, with a split, resizable pane area below (terminals, browser, editor).
- **Right action panel (resizable, collapsible).** Git for the active Flight, plus quick tasks. A fuller list/kanban task view is reachable per workspace.

Keyboard-first navigation throughout (switch Flights, switch/split tabs, run git actions) is a design priority, in the spirit of Pane.

---

## 12. Architecture and Stack

- **Shell / runtime.** **Electron (decided).** The proven, fast terminal stack on Windows (node-pty over ConPTY plus xterm.js) is exactly what VS Code's terminal and Pane use, and it is JavaScript-native. This **supersedes the NW.js choice** from the old PRDs. Tauri was considered for its lighter footprint but set aside to keep the stack all-JS and lean on the proven node-pty + xterm.js path.
- **Terminals.** node-pty (ConPTY) per terminal, rendered with **xterm.js** using its GPU (WebGL) renderer for low input latency; PTY output handled efficiently so keystrokes and arrow-key navigation in a TUI like Claude Code stay snappy (a specific Pane pain point, §13).
- **Git.** A fast git path (libgit2 bindings, or `git` shelled out with caching) plus filesystem watching so branch/status updates are reactive rather than slow polls (another Pane pain point).
- **Editor.** Monaco (the VS Code editor component) for the editor tab: file tree with git status, diff view, and light inline edits with save.
- **CLI control channel.** A local named pipe / loopback IPC the app listens on; the `orbital` CLI is a thin client using the injected env vars. No external network surface.
- **Env sync.** A per-workspace wildcard list; a filesystem watcher copies matching files from the root checkout into worktrees on creation and on change (§5).
- **State.** SQLite (workspaces, Flights and their tab layouts, tasks, env-sync patterns) in the app data directory.
- **Process model.** Agents and their PTYs keep running while the app runs, including when the window is minimized; quitting the app stops them. There is no persistence beyond the app's lifetime in v1.

---

## 13. Performance Requirements (first-class)

Performance is a stated reason for building fresh, so it is a requirement, not a hope. The bar is "usable speeds," made concrete against the three things that felt broken in Pane:

- **Window drag is smooth.** No main-thread blocking or heavy synchronous re-render during move/resize; use the native window frame and keep layout work off the critical path.
- **Terminal input is immediate.** Typing and arrow-key selection inside an agent TUI (the Claude Code up/down option selection that lagged in Pane) must feel instant: GPU-rendered xterm.js, efficient PTY data pumping, no per-keystroke full re-render.
- **Git status is responsive.** Branch and dirty-state updates reflect within a beat of a change (filesystem watch plus cache), not the long delay Pane showed.
- **General responsiveness** across many open Flights and PTYs: switching Flights, opening tabs, and scrolling diffs stay smooth as the count grows.

These are acceptance criteria, validated on the author's native Windows machine.

---

## 14. Data Model (sketch)

- `workspaces(id, name, repo_path, env_sync_patterns, added_at)` where `env_sync_patterns` is the user-editable wildcard list (JSON array).
- `flights(id, workspace_id, kind, name, worktree_path, branch, status, task_id, created_at)` where `kind` is `root | worktree`, `status` is the cached **aggregate** of the Flight's terminal statuses (`idle | working | needs_attention | error | done`), `worktree_path`/`branch` describe the working directory, and `task_id` is the originating task (nullable).
- `tabs(id, flight_id, type, status, layout_position, config)` where `type` is `terminal | browser | editor`, `status` (terminals only, null otherwise) is `idle | working | needs_attention | error | done`, and `config`/`layout_position` capture the split layout and per-tab state (cwd, URL, file, etc.).
- `tasks(id, workspace_id, title, description, status, created_at, updated_at)` where `status` is `todo | in_progress | ready_for_review | done`.

Terminal status (rolled up into the Flight aggregate) and task status are separate fields on separate tables, never conflated.

---

## 15. Security and Access

- Native desktop app, single user, single machine. The CLI control channel is a local named pipe / loopback only, with no network surface.
- Terminals run with the user's own shell and environment; agent auth (the `claude` / `codex` login) is whatever the user already has. Orbital handles no model tokens and makes no model calls.
- Orbital's file and git operations are scoped to the registered workspace repo paths.

---

## 16. Open Questions

Most prior questions are now decided (Electron; per-terminal status with a Flight aggregate; minimize keeps running and close stops; prompt to remove worktree; terminals start fresh; editor allows inline edits; status set adds error/done; branch named from the task; CLI adds `task add`; needs-attention surfaced via indicator, sound, and taskbar badge). What remains:

1. **Env-sync conflict behavior.** Files are copied from the root into worktrees and kept in sync as the source changes. Decide what happens when a worktree's own copy is edited locally: overwrite on next sync, skip if modified, or warn. A per-pattern or per-file rule may be needed.
2. **Flight aggregate precedence.** Confirm the order `needs attention > error > working > idle > done`, and the corner case where some terminals are `done` and others `idle` (does the Flight read idle, done, or a mixed state?).
3. **CLI scope creep.** `task add` is in; attaching a branch/PR to a Flight or posting a note from the agent are possible later additions, deferred until there is a clear need.
4. **Done-terminal semantics.** When a terminal finishes its agent and goes `done`, should its tab auto-close, stay for scrollback, or be reused? Relatedly, whether `done` should ever roll up to the Flight badge or be treated as quiet.

---

## 17. Milestones

- **M1, Shell and workspaces.** Native window, left rail, add-workspace, the root Flight per workspace, SQLite. Branch/status display.
- **M2, Terminals and Flights.** node-pty + xterm.js terminal tabs, worktree creation and worktree Flights, env-file sync into worktrees, the split/resizable tab body, per-terminal status with the Flight aggregate (set manually in-UI), the env injection. The core cockpit: run several agents in several Flights and see their status.
- **M3, Orbital CLI.** The `orbital` command and control channel: `status`, `flights`, `flight new`, `tab new`, plus suggested Claude Code hook snippets so status updates are automatic.
- **M4, Git panel and editor.** The right-hand git panel (stage/commit/push/branch/worktree, fast status), the file-tree-with-git-status editor with diffs and light inline edits.
- **M5, Tasks.** The lightweight per-workspace tracker (list and kanban), quick tasks in the right panel, "start a Flight from a task" (branch named from the task), and `orbital task add`.
- **M6, Browser and polish.** In-app browser tabs, terminal link handling (plain click in-app, Ctrl+Click external), the three-way needs-attention signal (indicator, sound, taskbar badge), performance pass against §13, keyboard navigation.
- **(Future).** Server / remote version; mobile; per-worktree ports.

---

## 18. Success Criteria

- I can run several Claude Code instances at once, each in its own Flight and worktree, and tell at a glance from the left rail which one needs me.
- An agent can report its own status and open its own tabs through the Orbital CLI, so I am not babysitting terminals.
- Capturing a task takes seconds, lives per workspace as a simple list or board, and turns into a worktree-backed Flight in one action when I am ready, without ever being forced to.
- The root checkout and worktrees are equally first-class Flights, and worktrees come up with my local `.env` config already synced in.
- Terminal typing, window dragging, and git status all feel immediate, fixing the specific slowness that drove me off Pane.
- Everything runs native on Windows, and all agent usage stays on my existing subscription because Orbital only hosts terminals and never calls a model.
