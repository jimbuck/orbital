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
  orbital tab new <terminal|browser|editor> [arg]
  orbital task add "<title>" [--description <text>]
  orbital help

Examples:
  orbital status needs-attention
  orbital flights
  orbital flight new --worktree feature/login "Login flow"
  orbital tab new browser http://localhost:5173
  orbital task add "Write tests" --description "cover the parser"
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

const TAB_TYPES = ['terminal', 'browser', 'editor'] as const

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
      if (rest[0] !== 'add') usageError()
      const { positionals, flags } = parseArgs(rest.slice(1))
      const title = positionals[0]
      if (!title) usageError()
      const args: Record<string, unknown> = { title }
      if (flags.description) args.description = flags.description
      return request('task-add', args)
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

/** Render the `flights` payload as a small fixed-width table. */
function printFlights(data: unknown): void {
  const list = Array.isArray(data) ? data : []
  if (list.length === 0) {
    process.stdout.write('No flights.\n')
    return
  }

  const rows = list.map((flight) => {
    const o = (flight ?? {}) as Record<string, unknown>
    return {
      status: String(o.status ?? ''),
      name: String(o.name ?? ''),
      branch: String(o.branch ?? ''),
      id: String(o.id ?? '')
    }
  })

  const cols = [
    { key: 'status', head: 'STATUS' },
    { key: 'name', head: 'NAME' },
    { key: 'branch', head: 'BRANCH' },
    { key: 'id', head: 'ID' }
  ] as const

  const widths = cols.map((c) =>
    Math.max(c.head.length, ...rows.map((r) => r[c.key].length))
  )
  const line = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i])).join('  ').replace(/\s+$/, '')

  process.stdout.write(line(cols.map((c) => c.head)) + '\n')
  for (const r of rows) {
    process.stdout.write(line(cols.map((c) => r[c.key])) + '\n')
  }
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
  } else {
    process.stdout.write(confirmation(req, res.data) + '\n')
  }
  process.exit(0)
}

/* ----------------------------------------------------------------- main ---- */

send(buildRequest(process.argv.slice(2)))
