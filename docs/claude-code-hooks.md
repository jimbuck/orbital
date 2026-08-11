# Wiring Orbital into your agent

Orbital surfaces *which agent needs you* by reading each terminal's status. There
are three pieces of agent configuration it can install for you, all opt-in from
**Settings**, all previewed before anything is written, and all removable without
touching anything else in your config:

| | What it does | Where it lands |
|---|---|---|
| **Claude status hooks** | Worktrees report status from Claude's own lifecycle events | `settings.json` in the workspace's Claude profile dir |
| **The `orbital` skill** | Teaches Claude the `orbital` CLI in sessions Orbital didn't boot | `skills/orbital/SKILL.md` in the same dir |
| **Codex instructions** | Teaches Codex the same, since it takes no briefing | a marked block in `AGENTS.md` in the workspace's Codex profile dir |

Each targets the profile directory **this workspace launches that agent against**
(Settings → agents → *provider* → profile directory), falling back to the
provider's own env var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and then `~/.claude` /
`~/.codex`. That is the only directory the agent will read: a workspace pointing
an agent at its own profile needs its own install, and the Settings badges report
the state of that profile, not the machine default.

## Claude status hooks

Orbital registers one hook per lifecycle event, each invoking its own CLI:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"C:\\...\\resources\\cli\\orbital.cmd\" hook Notification --orbital-managed",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Three details matter:

- **`orbital hook <event>`, not `orbital status <x>`.** The event→status policy
  lives in the app (`hookEventToStatus` in `src/main/ipc.ts`), so settings.json
  stays a dumb list of invocations and the mapping can change without rewriting
  your config.
- **An absolute path to the shim**, because these hooks fire for *every* Claude
  session using that profile, including ones started far away from Orbital's
  `PATH`.
- **`--orbital-managed`** marks Orbital's entries. Install is idempotent, and
  uninstall strips exactly these and leaves every other hook in place.

The CLI guards on `ORBITAL_WORKTREE_ID`: outside an Orbital terminal it exits 0
immediately, printing nothing. It never blocks Claude and never reports an error
back to it.

Events registered, and the status each produces:

| Event | Status |
|---|---|
| `SessionStart` | `idle` |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | `working` |
| `Notification`, when it's a human-blocking one | `needs-attention` |
| `Notification`, when an elicitation resolves | `working` |
| `Stop` | `idle` |
| `StopFailure` | `error` |
| `SessionEnd` | `done` |

The blocking notification types are `permission_prompt`, `idle_prompt`,
`elicitation_dialog`, `elicitation_url_dialog`, and `agent_needs_input` — every
way Claude can stop and wait for a person. `elicitation_complete` /
`elicitation_response` mean such a dialog was answered elsewhere (a URL opened in
the browser produces no keystroke here), so they release the worktree back to
`working`. Anything else — `auth_success`, `agent_completed`, types added in
future Claude versions — says nothing about whether a human is needed and is
ignored.

Typing into a terminal flagged `needs-attention` clears it immediately — Orbital
reads your keystrokes, never the agent's output. Answering a permission prompt or
an elicitation dialog goes straight to `working`; typing at an idle prompt is
just composing, so it drops to `idle` until you actually submit.

## The `orbital` skill

Agent tabs are briefed about the CLI when they launch. A `claude` you start by
hand in a terminal tab is not — it is an ordinary session that happens to have
`orbital` on its `PATH`. Installing the skill closes that gap: Claude loads it
when the cockpit becomes relevant, and it documents the whole CLI.

It refuses to overwrite a `SKILL.md` it did not write, and only ever deletes one
carrying its own `managed-by: orbital` marker.

## Codex instructions

Codex has no `--append-system-prompt-file` equivalent, so it never receives the
per-launch briefing — a Codex agent tab would have no idea the cockpit exists.
What it *does* read at the start of every session is the `AGENTS.md` in its home
directory (`CODEX_HOME`, else `~/.codex`), ahead of any project-level ones.

That file is yours, so Orbital manages a delimited block inside it rather than
the file itself:

```md
<!-- orbital:begin managed-by: orbital -->
## Orbital cockpit
…
<!-- orbital:end -->
```

Install rewrites just that block (so it never stacks up), uninstall removes just
that block, and anything you wrote around it is untouched. Because this text
loads into *every* Codex session using the profile — unlike the Claude skill,
which loads only when relevant — it is deliberately short: the few commands worth
running unprompted, plus a pointer to `orbital help`, guarded by the same
`ORBITAL_WORKTREE_ID` check so sessions outside Orbital know to ignore it.

**Cursor** has no equivalent: `cursor-agent` takes no instructions flag at launch
and reads no profile-level rules file — the only channel is `.cursor/rules`
inside the repo, which Orbital will not write (zero git footprint). A Cursor
session still has the CLI on its `PATH`; `orbital help` is how it finds out.

## Doing it by hand

Nothing here is magic, and nothing is Claude-specific. Any agent that can run a
command can drive the same CLI:

```sh
orbital status working           # I'm busy
orbital status needs-attention   # I'm blocked, come look
orbital status idle              # nothing happening
orbital status done              # finished
```

Codex, Cursor, or a plain shell script can call these directly, or wire them into
whatever hook system that tool offers. See [the CLI reference][cli] for
everything else it can do — tasks, worktrees, tabs, and dev servers.

[cli]: ../website/src/content/docs/reference/cli.md
