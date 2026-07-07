/**
 * Orbital — agent-facing `orbital` CLI (PRD §9).
 *
 * This binary is injected on the PATH of every Flight terminal so the coding
 * agent running inside it can talk back to the cockpit: report its status, list
 * sibling Flights, spawn new Flights / tabs, and file tasks. It speaks the
 * `ControlRequest`/`ControlResponse` protocol over the local control pipe.
 *
 * It is bundled to `resources/cli/orbital.js` by esbuild, so it may use ONLY
 * Node builtins plus the shared contract types — and it imports those types by
 * RELATIVE path (the `@shared` alias is not resolvable at bundle time).
 */

import { connect } from 'node:net'
import {
  ENV,
  controlPipePath,
  type ControlRequest,
  type ControlResponse,
  type ControlCommand
} from '../shared/types'

/* ------------------------------------------------------------------ usage -- */

const USAGE = `orbital — control the running Orbital cockpit from inside a Flight terminal.

Usage:
  orbital status <idle|working|needs-attention|error|done>
  orbital flights
  orbital flight new [--worktree <branch>] [name]
  orbital tab new <terminal|browser|editor|agent> [arg]
  orbital task add "<title>" [--description <text>] [--tags <a,b,c>]
  orbital task list [--all]
  orbital task update <id> [--status <todo|in-progress|ready-for-review|done>] [--title <text>] [--description <text>] [--tags <a,b,c>]
  orbital task done <id>
  orbital server add <url|port>
  orbital server remove <url|port>
  orbital server list
  orbital help

Examples:
  orbital status needs-attention
  orbital flight new --worktree feature/login "Login flow"
  orbital tab new browser http://localhost:5173
  orbital task add "Write tests" --description "cover the parser"
  orbital task list
  orbital task done 4f21c
  orbital server add 5173
  orbital server remove 5173
`

/** Print usage to a stream and exit with the given code. */
function printUsage(stream: NodeJS.WriteStream, code: number): never {
  stream.write(USAGE)
  process.exit(code)
}

/** Bad invocation: usage to stderr, exit 1. */
function usageError(): never {
  return printUsage(process.stderr, 1)
}

/** Hard failure with a CLI-prefixed message on stderr. */
function fail(message: string): never {
  process.stderr.write(`orbital: ${message}\n`)
  process.exit(1)
}

/* ------------------------------------------------------------- arg parsing -- */

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string>
}

/**
 * Split tokens into positionals and `--flag value` / `--flag=value` pairs.
 * A `--flag` with no following value (or followed by another flag) is recorded
 * as an empty string.
 */
function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1)
      } else {
        const name = token.slice(2)
        const next = tokens[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[name] = next
          i++
        } else {
          flags[name] = ''
        }
      }
    } else {
      positionals.push(token)
    }
  }
  return { positionals, flags }
}

/** Build a request, stamping in the identity Orbital injected into the env. */
function request(cmd: ControlCommand, args: Record<string, unknown>): ControlRequest {
  return {
    cmd,
    terminalId: process.env[ENV.terminalId],
    flightId: process.env[ENV.flightId],
    workspaceId: process.env[ENV.workspaceId],
    args
  }
}

const TAB_TYPES = ['terminal', 'browser', 'editor', 'agent'] as const

/** Turn argv into a ControlRequest, or terminate the process on a usage error. */
function buildRequest(argv: string[]): ControlRequest {
  const [cmd, ...rest] = argv

  switch (cmd) {
    case 'status': {
      const token = rest[0]
      if (!token) usageError()
      // The raw token is forwarded; the main process normalizes it.
      return request('status', { status: token })
    }

    case 'flights':
      return request('flights', {})

    case 'flight': {
      if (rest[0] !== 'new') usageError()
      const { positionals, flags } = parseArgs(rest.slice(1))
      const args: Record<string, unknown> = {}
      if (flags.worktree) args.worktree = flags.worktree
      if (positionals[0]) args.name = positionals[0]
      return request('flight-new', args)
    }

    case 'tab': {
      if (rest[0] !== 'new') usageError()
      const { positionals } = parseArgs(rest.slice(1))
      const type = positionals[0]
      if (!type || !TAB_TYPES.includes(type as (typeof TAB_TYPES)[number])) usageError()
      const args: Record<string, unknown> = { type }
      if (positionals[1]) args.arg = positionals[1]
      return request('tab-new', args)
    }

    case 'task': {
      const sub = rest[0]
      const { positionals, flags } = parseArgs(rest.slice(1))

      if (sub === 'add') {
        const title = positionals[0]
        if (!title) usageError()
        const args: Record<string, unknown> = { title }
        if (flags.description) args.description = flags.description
        if (flags.tags) args.tags = flags.tags
        return request('task-add', args)
      }
      if (sub === 'list') {
        return request('task-list', { all: 'all' in flags })
      }
      if (sub === 'update') {
        const id = positionals[0]
        if (!id) usageError()
        const args: Record<string, unknown> = { id }
        if (flags.status !== undefined) args.status = flags.status
        if (flags.title !== undefined) args.title = flags.title
        if (flags.description !== undefined) args.description = flags.description
        if (flags.tags !== undefined) args.tags = flags.tags
        return request('task-update', args)
      }
      if (sub === 'done') {
        const id = positionals[0]
        if (!id) usageError()
        return request('task-update', { id, status: 'done' })
      }
      return usageError()
    }

    case 'server': {
      const sub = rest[0]
      const { positionals } = parseArgs(rest.slice(1))
      if (sub === 'add' || sub === 'remove') {
        const url = positionals[0]
        if (!url) usageError()
        return request(sub === 'add' ? 'server-add' : 'server-remove', { url })
      }
      if (sub === 'list') return request('server-list', {})
      return usageError()
    }

    case 'help':
    case '--help':
    case '-h':
      printUsage(process.stdout, 0)
      break

    default:
      usageError()
  }

  // Unreachable: every branch above either returns or exits.
  return usageError()
}

/* --------------------------------------------------------------- output ---- */

/** Render rows as a small fixed-width table. */
function printTable(cols: { key: string; head: string }[], rows: Record<string, string>[]): void {
  const widths = cols.map((c) => Math.max(c.head.length, ...rows.map((r) => (r[c.key] ?? '').length)))
  const line = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i])).join('  ').replace(/\s+$/, '')
  process.stdout.write(line(cols.map((c) => c.head)) + '\n')
  for (const r of rows) {
    process.stdout.write(line(cols.map((c) => r[c.key] ?? '')) + '\n')
  }
}

function printFlights(data: unknown): void {
  const list = Array.isArray(data) ? data : []
  if (list.length === 0) {
    process.stdout.write('No flights.\n')
    return
  }
  printTable(
    [
      { key: 'status', head: 'STATUS' },
      { key: 'name', head: 'NAME' },
      { key: 'branch', head: 'BRANCH' },
      { key: 'id', head: 'ID' }
    ],
    list.map((flight) => {
      const o = (flight ?? {}) as Record<string, unknown>
      return {
        status: String(o.status ?? ''),
        name: String(o.name ?? ''),
        branch: String(o.branch ?? ''),
        id: String(o.id ?? '')
      }
    })
  )
}

function printTasks(data: unknown): void {
  const list = Array.isArray(data) ? data : []
  if (list.length === 0) {
    process.stdout.write('No open tasks. (`--all` includes done tasks.)\n')
    return
  }
  printTable(
    [
      { key: 'id', head: 'ID' },
      { key: 'status', head: 'STATUS' },
      { key: 'title', head: 'TITLE' },
      { key: 'flight', head: 'FLIGHT' }
    ],
    list.map((task) => {
      const o = (task ?? {}) as Record<string, unknown>
      return {
        // The short prefix is enough for `orbital task update/done`.
        id: String(o.id ?? '').slice(0, 8),
        status: String(o.status ?? ''),
        title: String(o.title ?? ''),
        flight: o.flightId ? 'linked' : ''
      }
    })
  )
}

function printServers(data: unknown): void {
  const list = Array.isArray(data) ? data : []
  if (list.length === 0) {
    process.stdout.write('No dev servers registered. (`orbital server add <url|port>`)\n')
    return
  }
  for (const url of list) process.stdout.write(`${String(url)}\n`)
}

/** A one-line confirmation for the non-`flights` commands. */
function confirmation(req: ControlRequest, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>
  switch (req.cmd) {
    case 'status':
      return `terminal status set to ${String(req.args.status ?? '')}`
    case 'flight-new': {
      const name = d.name ?? req.args.name
      const branch = d.branch ?? req.args.worktree
      return `flight created${name ? `: ${String(name)}` : ''}${branch ? ` (${String(branch)})` : ''}`
    }
    case 'tab-new':
      return `opened ${String(req.args.type ?? '')} tab`
    case 'task-add':
      return `task added: ${String(d.title ?? req.args.title ?? '')}`
    case 'task-update':
      return `task updated: ${String(d.title ?? '')} → ${String(d.status ?? '')}`
    case 'server-add': {
      const n = Array.isArray(d.servers) ? d.servers.length : 0
      return `dev server registered: ${String(d.url ?? '')} (${n} live)`
    }
    case 'server-remove': {
      const n = Array.isArray(d.servers) ? d.servers.length : 0
      return `dev server removed: ${String(d.url ?? '')} (${n} live)`
    }
    default:
      return typeof data === 'string' ? data : 'ok'
  }
}

/* --------------------------------------------------------------- transport - */

/** Connect to the control pipe, send the request, print the single response. */
function send(req: ControlRequest): void {
  // ORBITAL_SOCKET pins the exact pipe per terminal; fall back to the well-known path.
  const pipePath = process.env[ENV.socket] || controlPipePath()
  const socket = connect(pipePath)
  socket.setEncoding('utf8')

  let settled = false
  let buffer = ''

  const finish = (fn: () => void): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.removeAllListeners()
    socket.destroy()
    fn()
  }

  const notConnected = (): never => {
    process.stderr.write('orbital: not connected to Orbital — is the app running?\n')
    process.exit(1)
  }

  const timer = setTimeout(() => finish(notConnected), 3000)

  socket.on('connect', () => {
    socket.write(JSON.stringify(req) + '\n')
  })

  socket.on('data', (chunk: string) => {
    buffer += chunk
    const nl = buffer.indexOf('\n')
    if (nl === -1) return
    const lineText = buffer.slice(0, nl)
    finish(() => handleResponse(req, lineText))
  })

  socket.on('error', (err: NodeJS.ErrnoException) => {
    finish(() => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') notConnected()
      fail(err.message)
    })
  })

  socket.on('close', () => {
    finish(() => fail('connection closed before a response was received'))
  })
}

/** Parse and act on the response line. */
function handleResponse(req: ControlRequest, lineText: string): void {
  let res: ControlResponse
  try {
    res = JSON.parse(lineText) as ControlResponse
  } catch {
    fail('received a malformed response from Orbital')
  }

  if (!res.ok) {
    fail(res.error || 'command failed')
  }

  if (req.cmd === 'flights') {
    printFlights(res.data)
  } else if (req.cmd === 'task-list') {
    printTasks(res.data)
  } else if (req.cmd === 'server-list') {
    printServers(res.data)
  } else {
    process.stdout.write(confirmation(req, res.data) + '\n')
  }
  process.exit(0)
}

/* ------------------------------------------------------------------ hook --- */

/**
 * `orbital hook <event>` — invoked by Claude Code hooks from ~/.claude/settings.json.
 *
 * The guard lives HERE (not in the settings JSON): if ORBITAL_FLIGHT_ID is absent
 * the session is not an Orbital one, so we exit 0 immediately and Claude is wholly
 * unaffected. Otherwise we read the event JSON from stdin and fire it at the cockpit
 * as a best-effort, never printing anything and ALWAYS exiting 0 so Claude is never
 * blocked or shown a hook error.
 */
function runHook(args: string[]): void {
  if (!process.env[ENV.flightId]) process.exit(0)
  const event = args.find((a) => !a.startsWith('--')) ?? ''

  let input = ''
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    deliverHook(event, input)
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => (input += chunk))
  process.stdin.on('end', finish)
  process.stdin.on('error', finish)
  // stdin may not be piped in every Claude build; cap the wait so we never hang.
  setTimeout(finish, 400)
}

/** Send the hook event over the control pipe, then exit 0 regardless of outcome. */
function deliverHook(event: string, input: string): void {
  let payload: Record<string, unknown> = {}
  try {
    payload = input.trim() ? (JSON.parse(input) as Record<string, unknown>) : {}
  } catch {
    payload = {}
  }

  const req = request('hook', { event, payload })
  const pipePath = process.env[ENV.socket] || controlPipePath()
  const bail = setTimeout(() => process.exit(0), 1200)
  const socket = connect(pipePath)
  socket.on('connect', () => {
    socket.write(JSON.stringify(req) + '\n', () => socket.end())
  })
  socket.on('close', () => {
    clearTimeout(bail)
    process.exit(0)
  })
  socket.on('error', () => {
    clearTimeout(bail)
    process.exit(0)
  })
}

/* ----------------------------------------------------------------- main ---- */

const argv = process.argv.slice(2)
if (argv[0] === 'hook') {
  // Hooks are observational only and must never disturb Claude — handled apart
  // from the normal request/response path (no stdout, always exit 0).
  runHook(argv.slice(1))
} else {
  send(buildRequest(argv))
}
