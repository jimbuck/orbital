/**
 * Orbital — agent-facing `orbital` CLI (PRD §9).
 *
 * This binary is injected on the PATH of every worktree terminal so the coding
 * agent running inside it can talk back to the cockpit: report its status, list
 * sibling worktrees, spawn new worktrees / tabs, and file tasks. It speaks the
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

const USAGE = `orbital — control the running Orbital cockpit from inside a worktree terminal.

Usage:
  orbital status <idle|working|needs-attention|error|done>
  orbital whoami
  orbital worktrees
  orbital worktree new [--worktree <branch>] [--existing-branch <branch>] [--base <ref>] [--task <number>] [name]
  orbital tab new <terminal|browser|editor|agent> [arg]
  orbital task add "<title>" [--description <text>] [--tags <a,b,c>]
  orbital task list [--all] [--status <status>] [--tag <tag>]
  orbital task show <number|id>
  orbital task update <number|id> [--status <draft|todo|in-progress|ready-for-review|done>] [--title <text>] [--description <text>] [--tags <a,b,c>]
  orbital task start <number|id> [--worktree <branch>] [--base <ref>] [name]
  orbital task done <number|id>
  orbital task delete <number|id>
  orbital server add <url|port>
  orbital server remove <url|port>
  orbital server list
  orbital help

Options:
  --json    print the raw JSON response instead of a table — use this when parsing

Examples:
  orbital status needs-attention
  orbital whoami --json
  orbital worktree new --worktree feature/login "Login flow"
  orbital worktree new --existing-branch origin/pr-42
  orbital tab new browser http://localhost:5173
  orbital task add "Write tests" --description "cover the parser" --tags test
  orbital task list --status todo
  orbital task start 12
  orbital task done 12
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
    worktreeId: process.env[ENV.worktreeId],
    projectId: process.env[ENV.projectId],
    args
  }
}

const TAB_TYPES = ['terminal', 'browser', 'editor', 'agent'] as const

/**
 * `--json` swaps every printer for the raw response payload. It is stripped from
 * argv before parsing: parseArgs would otherwise treat the token after a bare
 * `--json` as its value and swallow a positional (`--json "Login flow"`).
 */
let jsonMode = false

/**
 * Shared by `worktree new` and `task start` — both land on `worktree-new`, which
 * creates the checkout and (given a task) links and starts that task.
 */
function worktreeNewRequest(tokens: string[], taskId?: string): ControlRequest {
  const { positionals, flags } = parseArgs(tokens)
  const args: Record<string, unknown> = {}
  if (flags.worktree) args.worktree = flags.worktree
  if (flags['existing-branch']) args.existingBranch = flags['existing-branch']
  if (flags.base) args.base = flags.base
  // `task start <id>` names its task positionally; a stray `--task` must not
  // quietly redirect the worktree to a different one.
  const task = taskId ?? flags.task
  if (task) args.task = task
  if (positionals[0]) args.name = positionals[0]
  return request('worktree-new', args)
}

/** Turn argv into a ControlRequest, or terminate the process on a usage error. */
function buildRequest(argv: string[]): ControlRequest {
  const [cmd, ...rest] = argv

  switch (cmd) {
    case 'status': {
      const token = rest[0]
      if (!token) usageError()
      // The raw token is forwarded; the main process normalizes it. firedAt lets
      // the cockpit order this against async hook events racing over the pipe.
      return request('status', { status: token, firedAt: Date.now() })
    }

    case 'whoami':
      return request('whoami', {})

    // `flights` is a hidden backward-compat alias for `worktrees`.
    case 'worktrees':
    case 'flights':
      return request('worktrees', {})

    // `flight` is a hidden backward-compat alias for `worktree`.
    case 'worktree':
    case 'flight': {
      if (rest[0] !== 'new') usageError()
      return worktreeNewRequest(rest.slice(1))
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
        const args: Record<string, unknown> = { all: 'all' in flags }
        if (flags.status) args.status = flags.status
        if (flags.tag) args.tag = flags.tag
        return request('task-list', args)
      }
      if (sub === 'start') {
        const id = positionals[0]
        if (!id) usageError()
        // Everything after the task id is worktree options (`--worktree`, `--base`,
        // an optional name) — the task itself supplies the default branch/name.
        return worktreeNewRequest(rest.slice(2), id)
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
      if (sub === 'show') {
        const id = positionals[0]
        if (!id) usageError()
        return request('task-show', { id })
      }
      if (sub === 'done') {
        const id = positionals[0]
        if (!id) usageError()
        return request('task-update', { id, status: 'done' })
      }
      if (sub === 'delete') {
        const id = positionals[0]
        if (!id) usageError()
        return request('task-delete', { id })
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

function printWorktrees(data: unknown): void {
  const list = Array.isArray(data) ? data : []
  if (list.length === 0) {
    process.stdout.write('No worktrees.\n')
    return
  }
  printTable(
    [
      { key: 'status', head: 'STATUS' },
      { key: 'name', head: 'NAME' },
      { key: 'branch', head: 'BRANCH' },
      { key: 'id', head: 'ID' }
    ],
    list.map((worktree) => {
      const o = (worktree ?? {}) as Record<string, unknown>
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
      { key: 'tags', head: 'TAGS' },
      { key: 'worktree', head: 'WORKTREE' }
    ],
    list.map((task) => {
      const o = (task ?? {}) as Record<string, unknown>
      return {
        // The task number addresses `orbital task update/done`; a uuid prefix
        // is the fallback for rows from an app build that predates numbers.
        id: o.seq != null ? `#${o.seq}` : String(o.id ?? '').slice(0, 8),
        status: String(o.status ?? ''),
        title: String(o.title ?? ''),
        tags: Array.isArray(o.tags) ? o.tags.join(',') : '',
        worktree: o.worktreeId ? 'linked' : ''
      }
    })
  )
}

/** Key/value block: the shape `task show` and `whoami` both print. */
function printFields(rows: [string, string][]): void {
  for (const [key, value] of rows) process.stdout.write(`${key.padEnd(12)} ${value}\n`)
}

/** Where am I, and what does the cockpit think I'm doing? */
function printWhoami(data: unknown): void {
  const o = (data ?? {}) as Record<string, unknown>
  const task = (o.task ?? null) as { seq?: number; title?: string; status?: string } | null
  const servers = Array.isArray(o.servers) ? o.servers : []
  printFields([
    ['project', String(o.project ?? '')],
    ['worktree', `${String(o.worktree ?? '')}${o.kind ? ` (${String(o.kind)})` : ''}`],
    ['branch', String(o.branch ?? '')],
    ['path', String(o.path ?? '')],
    ['status', String(o.status ?? '')],
    ['task', task ? `#${task.seq} ${task.title} (${task.status})` : '(none)'],
    ['servers', servers.length ? servers.map(String).join(', ') : '(none)']
  ])
}

/** Full detail block for `orbital task show`. */
function printTaskDetail(data: unknown): void {
  const o = (data ?? {}) as Record<string, unknown>
  printFields([
    ['number', o.seq != null ? `#${o.seq}` : '(none)'],
    ['id', String(o.id ?? '')],
    ['status', String(o.status ?? '')],
    ['title', String(o.title ?? '')],
    ['description', String(o.description ?? '') || '(none)'],
    ['tags', Array.isArray(o.tags) && o.tags.length > 0 ? o.tags.join(', ') : '(none)'],
    ['worktree', o.worktreeId ? String(o.worktreeId) : '(not linked)']
  ])
}

function printServers(data: unknown): void {
  const list = Array.isArray(data) ? data : []
  if (list.length === 0) {
    process.stdout.write('No dev servers registered. (`orbital server add <url|port>`)\n')
    return
  }
  for (const url of list) process.stdout.write(`${String(url)}\n`)
}

/** A one-line confirmation for the non-`worktrees` commands. */
function confirmation(req: ControlRequest, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>
  switch (req.cmd) {
    case 'status':
      return `terminal status set to ${String(req.args.status ?? '')}`
    case 'worktree-new': {
      const name = d.name ?? req.args.name
      const branch = d.branch ?? req.args.worktree
      const task = (d.task ?? null) as { seq?: number } | null
      return (
        `worktree created${name ? `: ${String(name)}` : ''}${branch ? ` (${String(branch)})` : ''}` +
        (task ? ` — task #${task.seq} started here` : '')
      )
    }
    case 'tab-new':
      return `opened ${String(req.args.type ?? '')} tab`
    case 'task-add':
      return `task added: ${d.seq != null ? `#${d.seq} ` : ''}${String(d.title ?? req.args.title ?? '')}`
    case 'task-update':
      return `task updated: ${String(d.title ?? '')} → ${String(d.status ?? '')}`
    case 'task-delete':
      return `task deleted: ${String(d.title ?? '')}`
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
    // Keep --json honest on the failure path too: one parseable object on stderr,
    // still exit 1 so plain shell checks keep working.
    if (jsonMode) {
      process.stderr.write(JSON.stringify({ ok: false, error: res.error || 'command failed' }) + '\n')
      process.exit(1)
    }
    fail(res.error || 'command failed')
  }

  if (jsonMode) {
    // The payload verbatim, so callers parse the app's own shapes rather than
    // a table this CLI happened to format.
    process.stdout.write(JSON.stringify(res.data ?? null, null, 2) + '\n')
  } else if (req.cmd === 'whoami') {
    printWhoami(res.data)
  } else if (req.cmd === 'worktrees') {
    printWorktrees(res.data)
  } else if (req.cmd === 'task-list') {
    printTasks(res.data)
  } else if (req.cmd === 'task-show') {
    printTaskDetail(res.data)
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
 * The guard lives HERE (not in the settings JSON): if ORBITAL_WORKTREE_ID is absent
 * the session is not an Orbital one, so we exit 0 immediately and Claude is wholly
 * unaffected. Otherwise we read the event JSON from stdin and fire it at the cockpit
 * as a best-effort, never printing anything and ALWAYS exiting 0 so Claude is never
 * blocked or shown a hook error.
 */
function runHook(args: string[]): void {
  if (!process.env[ENV.worktreeId]) process.exit(0)
  const event = args.find((a) => !a.startsWith('--')) ?? ''

  // Stamp the fire time NOW, before the stdin wait. Hooks run async, each in its
  // own short-lived process, so pipe DELIVERY order is not fire order — the
  // cockpit uses this stamp to drop events that arrive after a later-fired one.
  const firedAt = Date.now()

  let input = ''
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    deliverHook(event, input, firedAt)
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => (input += chunk))
  process.stdin.on('end', finish)
  process.stdin.on('error', finish)
  // stdin may not be piped in every Claude build; cap the wait so we never hang.
  setTimeout(finish, 400)
}

/** Send the hook event over the control pipe, then exit 0 regardless of outcome. */
function deliverHook(event: string, input: string, firedAt: number): void {
  let payload: Record<string, unknown> = {}
  try {
    payload = input.trim() ? (JSON.parse(input) as Record<string, unknown>) : {}
  } catch {
    payload = {}
  }

  const req = request('hook', { event, firedAt, payload })
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

const rawArgv = process.argv.slice(2)
jsonMode = rawArgv.includes('--json')
const argv = jsonMode ? rawArgv.filter((a) => a !== '--json') : rawArgv
if (argv[0] === 'hook') {
  // Hooks are observational only and must never disturb Claude — handled apart
  // from the normal request/response path (no stdout, always exit 0).
  runHook(argv.slice(1))
} else {
  send(buildRequest(argv))
}
