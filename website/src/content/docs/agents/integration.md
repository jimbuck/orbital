---
title: Wiring up your agent
description: How Orbital's status hooks, skill and Codex instructions plug into each agent profile, and how to integrate other tools.
---

Orbital can install three pieces of agent configuration. All are opt-in from
Settings, previewed before anything is written, and removable without
touching the rest of your config.

| | What it does | Where it goes |
|---|---|---|
| **Claude status hooks** | Claude reports its status from its own lifecycle events | `settings.json` in that Claude profile's directory |
| **The `orbital` skill** | Teaches Claude the CLI in sessions Orbital didn't boot | `skills/orbital/SKILL.md` in the same directory |
| **Codex instructions** | Teaches Codex the CLI, since it takes no briefing | A marked block in `AGENTS.md` in that Codex profile's directory |

## One install per profile

Each belongs to an **agent profile** and sits on that profile's card in
**Settings ▸ Agents**. It lands in the directory the profile launches with: its
*Profile directory* field, else the provider's own variable
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), else `~/.claude` or `~/.codex`. That's the
only directory those sessions read, so a workspace with a personal Claude and a
work Claude installs into each separately, and each card's badge reports its
own profile.

![Agent profiles in Settings, each with its own install cards](../../../assets/screenshots/16-settings-agents.png)

When an Orbital update changes what it would write, the card says
**Update available**. Update rewrites Orbital's own file or block in place, so
there's never a gap where your agents have no skill or hooks.

## Claude status hooks

Orbital registers one hook per Claude lifecycle event, each running
`orbital hook <event>` through an absolute path to the CLI shim:

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

- The event-to-status mapping lives in the app, so `settings.json` stays a
  plain list of calls and the mapping can change without rewriting your config.
- The path is absolute because the hooks fire for every session using the
  profile, including ones started nowhere near Orbital's `PATH`.
- `--orbital-managed` marks Orbital's entries. Install is idempotent, and
  Remove strips exactly these.

The CLI checks `ORBITAL_WORKTREE_ID` first. Outside an Orbital terminal it exits
0 immediately and prints nothing, so it never blocks Claude or reports an error
back to it.

| Claude event | Status |
|---|---|
| `SessionStart` | `idle` |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | `working` |
| `Notification` that blocks on a human | `needs-attention` |
| `Notification` saying an elicitation was answered | `working` |
| `Stop` | `idle` |
| `StopFailure` | `error` |
| `SessionEnd` | `done` |

The blocking notification types are `permission_prompt`, `idle_prompt`,
`elicitation_dialog`, `elicitation_url_dialog` and `agent_needs_input`. Other
types, including ones future Claude versions add, say nothing about whether a
human is needed and are ignored.

Typing into a terminal marked `needs-attention` clears it straight away.
Orbital reads your keystrokes, never the agent's output. Answering a permission
prompt goes to `working`; typing at an idle prompt drops to `idle` until you
submit.

## The orbital skill

Agent tabs are briefed when they launch. A `claude` you start by hand in a
terminal isn't; it's an ordinary session that happens to have `orbital` on its
`PATH`. The skill closes that gap. Claude only loads a skill's full text when
it becomes relevant, so it costs nothing until then.

Orbital refuses to overwrite a `SKILL.md` it didn't write, and only deletes one
carrying its `managed-by: orbital` marker. The full text is on
[The orbital skill](/orbital/agents/skill/).

## Codex instructions

Codex has no system-prompt flag, so it never sees the per-launch briefing. It
does read the `AGENTS.md` in its home directory at the start of every session.
That file is yours, so Orbital manages one delimited block inside it:

```md
<!-- orbital:begin managed-by: orbital -->
## Orbital cockpit
…
<!-- orbital:end -->
```

Install rewrites only that block and Remove deletes only that block. Because it
loads into every Codex session on the profile, it's kept short: the commands
worth running unprompted and a pointer to `orbital help`, behind the same
`ORBITAL_WORKTREE_ID` check.

## Cursor and other tools

`cursor-agent` takes no instructions at launch and reads no profile-level rules
file. The only channel is `.cursor/rules` inside the repo, and Orbital doesn't
write into repositories. A Cursor session still has the CLI on its `PATH`.

Nothing here is Claude-specific. Any tool that can run a command can drive the
same CLI, from its own hook system or a wrapper script:

```sh
orbital status working           # busy
orbital status needs-attention   # blocked, come look
orbital status idle              # nothing happening
orbital status done              # finished
```

## Session resume

Agent tabs are pinned to their session. When a tab comes back (the app
restarts, a workspace reopens), Orbital resumes the conversation instead of
starting a blank one: `claude --resume <id>`, `cursor-agent --resume=<id>`, or
`codex resume <id>`. See [Running agents](/orbital/guides/running-agents/#sessions-survive-a-restart)
for the details per provider.
