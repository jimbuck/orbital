---
title: Dev servers
description: Let the cockpit know which dev servers are live, and open them in one click.
---

When an agent (or you) starts a dev server inside a Flight, tell Orbital:

```sh
orbital server add 3000            # → http://localhost:3000
orbital server add localhost:6006  # host:port works too
orbital server add https://dev.nebula.test:8443
```

Port-only and host-only forms are normalized to full URLs. Registrations are
**per Flight** and live only while Orbital runs — dev servers die with their
terminals, so there's nothing stale to clean up after a restart.

## What you see

The title bar shows a green **"N dev servers"** pill for the active Flight.
Click it to pick a server — it opens in an in-app browser tab right next to
your agent:

![The dev-server pill and its dropdown](../../../assets/screenshots/05-dev-servers.png)

The same servers appear in every pane's **add-tab menu**, under the standard tab
types:

![Dev servers listed in the add-tab menu](../../../assets/screenshots/06-add-tab-menu.png)

## Removing and listing

```sh
orbital server remove 3000   # by port…
orbital server remove http://localhost:3000/   # …or exact URL
orbital server list
```

## Briefing your agents

Agent tabs are told about these commands automatically. A one-line instruction
in your repo's agent config makes it stick for terminal-launched agents too:

> When you start a dev server, run `orbital server add <port>`; when you stop
> it, run `orbital server remove <port>`.
