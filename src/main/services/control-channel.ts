import net from 'node:net'
import fs from 'node:fs'
import { ControlRequest, ControlResponse, controlPipePath } from '@shared/types'

/**
 * Handles one decoded {@link ControlRequest} from the `orbital` CLI and resolves
 * with the {@link ControlResponse} to write back. Throwing is tolerated by the
 * channel — the error is surfaced to the CLI as `{ ok: false, error }`.
 */
export type ControlHandler = (req: ControlRequest) => Promise<ControlResponse>

/**
 * Local IPC server backing the `orbital` CLI control protocol (PRD §9, types.ts).
 *
 * Listens on the stable, platform-specific pipe from {@link controlPipePath}
 * (a Windows named pipe, or a unix-domain socket file under TMPDIR). Each
 * connection speaks newline-delimited JSON: one {@link ControlRequest} per line,
 * answered with one {@link ControlResponse} line. Multiple requests may be
 * pipelined over a single connection, and lines may arrive split across chunks.
 */
export class ControlChannel {
  readonly pipePath: string = controlPipePath()

  private server: net.Server | null = null
  private readonly sockets = new Set<net.Socket>()

  /**
   * Bind the control server and route every decoded request through `handler`.
   * Resolves once the server is listening; rejects if binding fails.
   */
  async start(handler: ControlHandler): Promise<void> {
    if (this.server) return

    // A unix socket file left behind by a crash blocks rebind with EADDRINUSE.
    // Windows named pipes have no filesystem entry, so this only applies off-win32.
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.pipePath)
      } catch {
        // No stale socket to remove — fine.
      }
    }

    const server = net.createServer((socket) => {
      this.sockets.add(socket)
      socket.setEncoding('utf8')

      // Buffer raw bytes and dispatch on newline boundaries so a request split
      // across TCP/pipe chunks is reassembled before parsing.
      let buffer = ''

      const flush = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed) return

        let req: ControlRequest
        try {
          req = JSON.parse(trimmed) as ControlRequest
        } catch (err) {
          this.send(socket, { ok: false, error: `invalid request: ${String(err)}` })
          return
        }

        handler(req)
          .then((res) => this.send(socket, res))
          .catch((err) => this.send(socket, { ok: false, error: String(err) }))
      }

      socket.on('data', (chunk: string) => {
        buffer += chunk
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          flush(line)
          nl = buffer.indexOf('\n')
        }
      })

      const drop = (): void => {
        this.sockets.delete(socket)
      }
      socket.on('close', drop)
      socket.on('error', drop)
    })

    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server = null
        reject(err)
      }
      server.once('error', onError)
      server.listen(this.pipePath, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
  }

  /** Destroy all live connections and close the server, removing the socket file. */
  stop(): void {
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.sockets.clear()

    if (this.server) {
      this.server.close()
      this.server = null
    }

    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.pipePath)
      } catch {
        // Already gone — nothing to clean up.
      }
    }
  }

  /** Serialize a response as one NDJSON line; ignore writes to a dead socket. */
  private send(socket: net.Socket, res: ControlResponse): void {
    if (socket.destroyed) return
    try {
      socket.write(JSON.stringify(res) + '\n')
    } catch {
      // Peer vanished mid-write — drop silently.
    }
  }
}
