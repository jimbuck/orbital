# Remote access

**Status:** decided, not started.
**Date:** September 2026.
**Applies to:** Orbital v1.31+ (Projects / Worktrees / panes / tabs).

The job: sit at the laptop on a phone hotspot and work on the desktop at home
through Orbital, terminals and browser tabs included, as if the window were
local. Cost target is zero dollars a month. One owner, a few devices.

This replaces the earlier design notes that leaned on a Cloudflare broker and
WebRTC or iroh. Those are in "Rejected" below with reasons. It also formally
drops the persistent-terminal branch (`feature/persistent-terminal-support`,
never merged, complete on its own terms). An always-on host makes it moot.

## Decisions

1. Tailscale is the network. Orbital does no NAT traversal and runs no broker.
2. A remote host opens as its own window. The whole IPC contract is forwarded.
   Nothing is merged with local state.
3. One WebSocket per stream over the tailnet. No custom multiplexer.
4. Browser tabs in a remote window proxy through the host. No port forwarding.
5. Device pairing with Ed25519 keys and a one-time code shown on the host.
6. Host mode is a setting that adds a tray icon and a login item and keeps the
   process alive when the last window closes.

The rest of this document is the reasoning and the concrete shape of each.

## 1. Network: Tailscale

Both machines run Tailscale on the free Personal plan (six users, unlimited
devices as of September 2026). It handles the hotspot's carrier-grade NAT, the
home router, and falls back to DERP relays when hole punching fails. WireGuard
encrypts the link. MagicDNS gives the desktop a stable name.

Orbital binds its host listener to the tailnet interface only, found by
scanning `os.networkInterfaces()` for an address in 100.64.0.0/10, plus
127.0.0.1 for local testing. If no tailnet address exists, host mode reports
"Tailscale not detected" and does not listen. `ORBITAL_REMOTE_BIND` overrides
the bind address for development.

The client does not discover hosts. The user types the MagicDNS name once
(`desktop.tail1234.ts.net`), Orbital saves it, and shows online or offline by
attempting a connection. That is the entire discovery story. Parsec-style
account sign-in and presence would need a broker, and a broker is the thing we
are not building.

What this costs: Tailscale must be installed on both ends. For a personal dev
tool that is a fair trade against writing and hosting signaling, TURN, and
device registries. If Orbital ever wants zero-install remoting for other
people, that is a separate project and the stream protocol below survives it.

## 2. One window per host

Orbital already runs one Electron instance per workspace, keyed by
`ORBITAL_USER_DATA`, with the control pipe suffixed per workspace so instances
never collide. A remote host slots into that model: opening a host spawns a
window whose main-process backend is a forwarder rather than the real
handlers. Every `ipcMain.handle` channel in `IPC` (104 of them today) becomes
a request over the control stream. Every push event the host's main process
would send to its own renderer is sent instead to the client's main, which
re-emits it to the window.

The renderer does not know it is remote. The preload bridge is unchanged. This
avoids threading a `hostId` through a hundred channels and every id-carrying
type in `src/shared/types.ts`, which is what a single merged window would have
required. The window title carries the host name so it is obvious which
machine you are typing into.

A few channels stay local or are disabled in a remote window:

- Clipboard already goes through the preload directly. Stays local.
- `openExternal` and other shell hand-offs run on the client so links open in
  the laptop's browser.
- Native dialogs (add project, import workspace, file pickers) run on the host
  in v1, which means they open a dialog nobody can see. These actions are
  hidden in remote windows for now. Add a project from the desktop.
- Auto-update is local to each install.
- Settings edit the host's settings, including appearance. A single owner sees
  one theme either way. Revisit if that grates.

The host side is the mirror image. The host's main process keeps running its
normal handlers and additionally serves them to any paired client. A local
window on the desktop and a remote window on the laptop can both be open
against the same host state, because the host already broadcasts state changes
to whoever is listening.

## 3. Streams: one WebSocket each

The `ws` package is a new dependency in main. There is no framing layer and no
multiplexer. Each logical stream is its own WebSocket connection to the host:

| Stream | Count | Payload |
| --- | --- | --- |
| Control | one per window | JSON. `{id, channel, args}` in, `{id, result}` or `{id, error}` back, and `{event, args}` pushes from the host. |
| Terminal | one per attached terminal tab | Binary PTY bytes host-to-client, binary input client-to-host, a small JSON frame for resize. |
| Proxy | one per TCP connection the browser tab opens | Raw bytes both ways. |

Why not multiplex over a single connection: a multiplexer needs its own
per-stream flow control or a chatty HMR socket will stall the terminal. With
one TCP connection per stream, the kernel does flow control and the code is
`socket.pipe()` plus `bufferedAmount` checks. The cost is a handshake per
proxied browser connection. Chromium keeps six connections per origin alive,
so a Vite page loads over six long-lived tunnels, not a tunnel per module. If
hotspot latency makes that hurt in practice, a yamux-style mux goes in under
the same stream interface and nothing above it changes.

Backpressure rule, applied everywhere bulk data moves: pause the source
(`socket.pause()` or the PTY) when the destination WebSocket's
`bufferedAmount` passes 1 MB, resume below 256 KB. Test it against a real
unbundled Vite page, not `echo`.

Reconnect: the client retries the control stream with backoff. Terminal
streams re-attach by sending the last sequence number seen. The host's existing
scrollback buffer in `src/main/services/terminals.ts` (200,000 characters with
a sequence cut-point, built for renderer remounts) replays only what was
missed. Nothing new is stored. PTYs live in the host process regardless of
whether anyone is attached, which is the whole reason persistence is gone.

Multiple clients on one terminal are mirrored. Same PTY, both see output, both
can type. Exclusive locking is more code for a case a single owner will rarely
hit by accident.

## 4. Browser tabs: proxy through the host

Browser tabs are a `<webview>`. In a remote window they use a dedicated
partition, `persist:remote-<hostId>`, and that partition's session is set to:

```js
session.fromPartition(partition).setProxy({
  proxyRules: `127.0.0.1:${localProxyPort}`,
  proxyBypassRules: '<-loopback>',
})
```

The bypass rule matters. Chromium never proxies `localhost`, `127.0.0.0/8`,
`[::1]`, or link-local addresses by default, because the web platform treats
localhost as a secure origin. `<-loopback>` removes that implicit bypass, so a
tab that loads `http://localhost:5173` sends the request to the proxy, and the
proxy resolves localhost on the desktop.

The proxy is split across the two machines:

- Client side is a dumb TCP listener on 127.0.0.1. Each accepted connection
  becomes one proxy stream to the host and bytes are piped. It parses nothing.
- Host side is a real HTTP proxy built on Node's `http.createServer`. Plain
  requests arrive with absolute URIs and are replayed with `http.request` to
  the target. `CONNECT` (used by Chromium for `https://`, `wss://`, and `ws://`
  through an HTTP proxy) does `net.connect` to the target and pipes. An
  `upgrade` handler covers any client that sends a bare upgrade.

What this buys over port forwarding, which the earlier notes had wrong: no
port collisions, no URL rewriting, and a dev server that redirects to
`localhost:3000` or has a hardcoded origin keeps working, because inside the
tab `localhost` means the host. The dev-server registry keeps its URLs
unchanged. `orbital server add 5173` on the host, click the pill on the laptop,
done. The registry is already broadcast on change, so the pill list updates
live.

Everything the tab loads goes through the host, including public sites. That
is deliberate. It matches "as if local" and avoids a rule set deciding which
hosts to tunnel. The host-side proxy accepts any target. A paired client
already has shell access, so restricting the proxy would protect nothing.

## 5. Pairing and auth

Tailscale authenticates machines to the tailnet. Orbital still checks that the
connecting Orbital is one you paired, so a shared tailnet does not equal shell
access.

Each install generates an Ed25519 keypair on first run. The private key is
encrypted at rest with Electron's `safeStorage` (DPAPI on Windows; not used
anywhere in the codebase yet, so this is new plumbing). The public key is the
device identity.

Pairing starts at the host, which sidesteps the "who approves on a headless
box" problem. In the desktop's Settings, "Remote host" shows a one-time
eight-character code, valid for ten minutes, plus the host's key fingerprint.
On the laptop, "Connect to a host" asks for the MagicDNS name and the code. The
handshake on the control stream:

1. Client sends its public key and the code.
2. Host verifies the code, stores the client key in its paired-devices list,
   and replies with its own public key.
3. Client pins the host key. Later connections skip the code: the host sends a
   nonce, the client signs it, the host checks the signature against its list,
   and the host signs a client nonce in return so the client knows it reached
   the pinned machine.
4. The control stream hands the client a short-lived session token. Terminal
   and proxy streams present that token on connect and are refused without it.

Revocation is deleting a device from the host's list. Its open streams are
closed. The list lives in the host's SQLite alongside settings.

There is no TLS on the WebSocket. WireGuard encrypts the tailnet, and the
listener does not bind anywhere else. If a non-tailnet bind is ever allowed,
add TLS then.

Say it in the docs plainly: a paired client has a shell on the host. That is
the feature.

## 6. Host lifecycle

Today `window-all-closed` calls `app.quit()`, there is no tray, and no login
item. Host mode changes those three things when the setting is on:

- `app.setLoginItemSettings({ openAtLogin: true })`.
- A tray icon with connect status, the paired-device count, and Quit.
- Closing the last window hides to tray instead of quitting.

Windows Update reboots and the machine coming back: the login item covers
Orbital. Automatic sign-in for the Windows account is the user's call and
outside the app. Sleep is the other silent killer; the doc for host mode should
say to disable sleep, and the app can call `powerSaveBlocker.start('prevent-app-suspension')`
while at least one client is attached.

## Rejected

Cloudflare broker with Workers, Durable Objects, and a device registry. It is
the right shape for a product other people install. For one owner it is
infrastructure to build and run in exchange for not installing Tailscale.
Workers also cannot be a general tunnel, so the relay path needed TURN or a
second system anyway.

WebRTC via `node-datachannel`. A third native module next to `node-pty` and
`better-sqlite3`, plus manual SCTP backpressure on every bulk stream. Electron's
built-in WebRTC would have avoided the native build, but the transport is only
needed if there is no network layer underneath, and Tailscale is that layer.

Cloudflare TURN relay. 1,000 GB free then $0.05 per GB, and every byte of a
proxied dev server through a hotspot would ride it. Tailscale's DERP relays do
the same job at no charge.

iroh. Good technical fit (QUIC streams, dial-by-key, native flow control), but
its relays are not something Workers can host, its Node bindings are less
proven than `ws`, and it solves a problem Tailscale already solved on this
machine.

Port forwarding for dev servers. Collides on every port both machines use,
breaks hardcoded origins, and needs URL rewriting in the UI. The proxy does
none of that.

Persistent terminals. The branch works. It is also 4,800 lines to survive app
restarts on a machine that, in host mode, should not be restarting the app.

## Staging

M1. Host listener, pairing, control-stream forwarding. Opening a host from the
laptop shows the desktop's rail, worktrees, tasks, git panel, and editor.
Terminal tabs show a placeholder.

M2. Terminal streams with attach, replay from sequence number, resize, and
mirrored multi-client. Backpressure tested against a scrolling build log.

M3. Proxy partition and the two-sided HTTP proxy. Tested against a cold Vite
page with HMR, over the hotspot, with DERP forced (`tailscale debug derp` or
disable UDP) to see the worst case.

M4. Host mode: tray, login item, hide-on-close, power save blocker, reconnect
polish, connection state in the window title.

Nothing ships publicly before M4. M1 through M3 are behind
`ORBITAL_REMOTE=1`.

## Still open

- Which native-dialog actions get a remote-friendly replacement first. Add
  project by typing a path is the obvious one.
- Whether settings should split into host-owned and window-owned. Decided no
  for v1; the question stays until it bothers someone.
- Whether to support a direct tailnet-free connection with TLS. Not planned.
- Whether a multiplexer becomes necessary for hotspot latency. Measure in M3.

## Ideas on the shelf

Neither of these is planned. They are written down so the decisions above do
not accidentally close the door on them.

### Sign in on each device instead of pairing

The pairing code in section 5 assumes you are at the desktop once. The
Parsec-style alternative is an account: sign in on each machine and they find
each other. Two ways to get there.

The cheap one uses Tailscale as the account. The host runs
`tailscale whois <peer-ip>` on connect and accepts any node owned by the same
tailnet login. The client runs `tailscale status --json`, probes each online
node on Orbital's port, and lists the ones that answer. About a hundred lines
and a dependency on the Tailscale CLI being on PATH. It fits one owner exactly
and would be the first thing to try.

The real one is a small broker on Cloudflare Workers and D1, inside the free
tier. It does identity, a device registry, and presence, and carries no
traffic. Identity comes from GitHub OAuth device flow, the same mechanism
`gh auth login` uses, so no redirect server. The registry is one table:

```
users    (id, github_id, login)
devices  (id, user_id, name, pubkey, role, addr, last_seen, revoked_at)
```

```
POST   /auth/github/start        -> { user_code, verification_uri }
POST   /auth/github/poll         -> { session_token }
PUT    /devices/{id}             upsert name, pubkey, role, tailnet addr+port
POST   /devices/{id}/heartbeat   host, every 60s; online = seen < 2 min ago
GET    /devices                  your devices with online flag and addr
DELETE /devices/{id}             revoke
```

The host fetches the account's device list instead of keeping its own, and the
nonce handshake stays as it is. The trust model shifts: the host trusts
whatever the broker says belongs to your account, so a stolen GitHub session
or a compromised broker can add a device with a shell. A first-connect
notification and an opt-in "approve new devices on the host" setting bring
back the current model for anyone who wants it. The Worker source would live
under `broker/` with the URL as a setting, so each person deploys their own.
Defaulting to a broker someone else hosts puts them in the trust path for
strangers' shells, which is a policy call, not a code one.

If the WebRTC transport ever comes back, this broker is also its signaling
server, and that is what would finally drop Tailscale from the requirements.

### A browser client

The client owns nothing, so it does not need Electron. The renderer already
talks to the outside only through the preload bridge. Swap that bridge for one
that speaks the control WebSocket and the same bundle runs in Chrome. The host
serves the bundle at its own root, so there is nothing to host and the client
version always matches the host.

A browser cannot join a tailnet, so the host needs a public door. Cloudflare
Tunnel plus Access is the pick: `cloudflared` on the desktop, a hostname on
your own domain with TLS, GitHub login enforced by Access before a request
reaches the machine. Tunnel is unmetered and Access is free to 50 users. The
host verifies the Access JWT on every request and binds only to loopback so
the tunnel is the only way in. Tailscale Funnel does the same job on a ts.net
name but always rides DERP relays, has an undisclosed bandwidth cap, and only
listens on three ports.

What breaks is the browser-tab proxy. A web page cannot set a per-session
proxy the way an Electron partition can. The substitute is one hostname per
dev-server port through the tunnel, `5173.dev.example.com` style, mapped back
to the local port on the host and embedded in an iframe. Absolute paths keep
working because the app sits at the root of its own origin. Hardcoded
`localhost:3000` redirects break again, for the web client only. The Electron
remote window keeps the proxy and the tailnet.

Doing this would mean two deliverables sharing the bridge and the stream
protocol: an Electron remote window over Tailscale, and a browser client over
Cloudflare Tunnel. It would not need the accounts broker above, because Access
already supplies the identity.

## Sources

- [Tailscale free plans](https://tailscale.com/docs/account/manage-plans/free-plans-discounts) and [pricing](https://tailscale.com/pricing): Personal plan limits.
- [Chromium proxy documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md): implicit localhost bypass and the `<-loopback>` rule.
- [Electron ProxyConfig](https://www.electronjs.org/docs/latest/api/structures/proxy-config) and [session API](https://www.electronjs.org/docs/latest/api/session): `setProxy` fields and rule syntax.
- [Cloudflare TURN pricing](https://developers.cloudflare.com/realtime/turn/faq/): free tier and per-GB rate.
- [Cloudflare Zero Trust free plan](https://costbench.com/software/business-vpn/cloudflare-zero-trust/free-plan/) and [Tunnel pricing](https://toolradar.com/tools/cloudflare-tunnel/pricing): Access user limit, unmetered tunnels.
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel): relay-only path, port restrictions, undisclosed bandwidth cap.
