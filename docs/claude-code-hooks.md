# Wiring the `orbital` CLI into Claude Code

Orbital surfaces *which agent needs you* by reading each terminal's status. An
agent can set its own status by calling the `orbital` CLI, which is on `PATH`
inside every Flight terminal. You can drive it by hand:

```sh
orbital status working           # I'm busy
orbital status needs-attention   # I'm blocked, come look
orbital status idle              # nothing happening
orbital status error             # something broke
orbital status done              # finished
```

…but the point is to make it automatic. Claude Code's hook system can call
`orbital` at the right moments so the left-rail badge tracks the agent without
you thinking about it.

## Suggested hooks

Add this to your Claude Code settings (`~/.claude/settings.json`, or the
project's `.claude/settings.json`). It only takes effect inside terminals that
Orbital spawned, because that's where the control-channel env vars exist — in a
normal terminal the calls are harmless no-ops that simply can't reach the app.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "orbital status working" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "orbital status needs-attention" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "orbital status idle" }] }
    ]
  }
}
```

What each does:

| Hook | Fires when | Status set |
|------|------------|------------|
| `UserPromptSubmit` | you send the agent a prompt | `working` |
| `Notification` | the agent is waiting on input or a permission | `needs-attention` |
| `Stop` | the agent finishes its turn | `idle` |

## Other agents

Nothing here is Claude-specific. Codex or any CLI agent can call the same
commands, or you can wire them into whatever hook/event system that tool offers.

## Manual organization

The same CLI lets an agent organize its own workspace:

```sh
orbital flights                          # list sibling Flights (id, branch, status)
orbital flight new --worktree feat/x     # spin up a new worktree Flight
orbital tab new browser http://localhost:5173   # open a preview tab
orbital task add "Write changelog" --description "for the 1.2 release"
```
