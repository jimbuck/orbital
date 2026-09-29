import { connect } from 'node:net'
import type { ControlRequest, ControlResponse } from '@shared/types'

/**
 * Other running Orbital instances ("peers"). Each workspace runs as its own
 * process bound to its own control pipe, so a workspace is open exactly when
 * its pipe accepts a connection. The updater uses this to find the windows an
 * install would take down, and to ask them to quit cleanly first — otherwise
 * the silent NSIS installer finds them still holding the install dir and
 * force-kills them mid-write.
 *
 * Kept free of Electron imports so it runs under vitest.
 */

/** A workspace that might have a live instance. */
export interface PeerCandidate {
  id: string
  name: string
  /** Its control pipe (see controlPipePath). */
  pipePath: string
}

/** How long a probe waits for a pipe to accept before calling it closed. */
const PROBE_TIMEOUT_MS = 750

/**
 * Whether something is listening on `pipePath`. Opens and immediately drops a
 * connection — the control channel ignores a socket that never sends a line.
 */
export function probeControlPipe(pipePath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(pipePath)
    const done = (alive: boolean): void => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.on('error', () => {}) // a late error on a dropped socket is noise
      socket.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Send one request over a control pipe and resolve with the reply, or reject
 * when the pipe is closed, the peer hangs up, or no answer arrives in time.
 */
export function sendControlRequest(
  pipePath: string,
  req: ControlRequest,
  timeoutMs = 3000
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath)
    socket.setEncoding('utf8')
    let buffer = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.on('error', () => {})
      socket.destroy()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error(`no answer from ${pipePath}`))), timeoutMs)
    socket.once('connect', () => socket.write(JSON.stringify(req) + '\n'))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      const line = buffer.slice(0, nl)
      finish(() => {
        try {
          resolve(JSON.parse(line) as ControlResponse)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
    socket.once('error', (err) => finish(() => reject(err)))
    socket.once('close', () => finish(() => reject(new Error('connection closed before a response'))))
  })
}

/** The candidates with a live instance, probed in parallel, order kept. */
export async function findLivePeers(
  candidates: PeerCandidate[],
  probe: (pipePath: string) => Promise<boolean> = probeControlPipe
): Promise<PeerCandidate[]> {
  const alive = await Promise.all(candidates.map((c) => probe(c.pipePath)))
  return candidates.filter((_, i) => alive[i])
}

/** Whether a process id is still running (signal 0 only checks existence). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, we just may not signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface QuitPeersOptions {
  /** Total budget for every peer to exit (ms). */
  timeoutMs?: number
  pollMs?: number
  send?: typeof sendControlRequest
  probe?: (pipePath: string) => Promise<boolean>
  isPidAlive?: (pid: number) => boolean
}

/**
 * Ask each peer to quit (the `quit-for-update` control command) and wait for
 * them to go away. A peer that reported its pid is waited on until the process
 * itself exits — that is when its file locks on the install dir drop; one that
 * didn't (or an older build that doesn't know the command) is waited on until
 * its pipe closes. Resolves with the peers still running when the budget ran
 * out, so the caller can log them; the installer closes stragglers itself.
 */
export async function quitPeers(peers: PeerCandidate[], opts: QuitPeersOptions = {}): Promise<PeerCandidate[]> {
  const {
    timeoutMs = 15_000,
    pollMs = 250,
    send = sendControlRequest,
    probe = probeControlPipe,
    isPidAlive = pidAlive
  } = opts

  const pids = await Promise.all(
    peers.map(async (p) => {
      try {
        const res = await send(p.pipePath, { cmd: 'quit-for-update', args: {} })
        const pid = res.ok ? (res.data as { pid?: unknown } | undefined)?.pid : undefined
        return typeof pid === 'number' && pid > 0 ? pid : null
      } catch {
        return null
      }
    })
  )

  const stillRunning = async (): Promise<PeerCandidate[]> => {
    const alive = await Promise.all(
      peers.map((p, i) => {
        const pid = pids[i]
        return pid !== null ? Promise.resolve(isPidAlive(pid)) : probe(p.pipePath)
      })
    )
    return peers.filter((_, i) => alive[i])
  }

  const deadline = Date.now() + timeoutMs
  let remaining = await stillRunning()
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    remaining = await stillRunning()
  }
  return remaining
}

/** The confirmation text shown before an update closes other open workspaces. */
export function peerUpdatePrompt(version: string | undefined, peerNames: string[]): { message: string; detail: string } {
  const n = peerNames.length
  const target = version ? `Orbital ${version}` : 'the update'
  const count = n === 1 ? '1 other Orbital window is open' : `${n} other Orbital windows are open`
  return {
    message: `Close all Orbital windows and install ${target}?`,
    detail:
      `${count}: ${peerNames.join(', ')}.\n\n` +
      `${n === 1 ? 'It' : 'They'} will be closed too, stopping the agents and terminals running there. ` +
      'Orbital reopens this workspace on the new version; reopen the others from the workspace picker.'
  }
}
