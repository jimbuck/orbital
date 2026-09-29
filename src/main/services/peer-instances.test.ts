// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { controlPipePath, type ControlRequest, type ControlResponse } from '@shared/types'
import { ControlChannel } from './control-channel'
import {
  findLivePeers,
  peerUpdatePrompt,
  probeControlPipe,
  quitPeers,
  sendControlRequest,
  type PeerCandidate
} from './peer-instances'

/** A pipe name no real Orbital instance (or other test) can be using. */
function uniquePipe(): string {
  return controlPipePath(`t${randomUUID()}`)
}

const channels: ControlChannel[] = []
afterEach(() => {
  for (const c of channels.splice(0)) c.stop()
})

async function listen(handler: (req: ControlRequest) => Promise<ControlResponse>): Promise<string> {
  const channel = new ControlChannel()
  channels.push(channel)
  const path = uniquePipe()
  await channel.start(handler, path)
  return path
}

function peer(name: string, pipePath = `pipe-${name}`): PeerCandidate {
  return { id: name, name, pipePath }
}

describe('probeControlPipe / sendControlRequest', () => {
  it('sees a listening pipe as alive and a missing one as closed', async () => {
    const live = await listen(async () => ({ ok: true }))
    expect(await probeControlPipe(live)).toBe(true)
    expect(await probeControlPipe(uniquePipe())).toBe(false)
  })

  it('round-trips a request over the control protocol', async () => {
    const path = await listen(async (req) => ({ ok: true, data: { cmd: req.cmd } }))
    const res = await sendControlRequest(path, { cmd: 'quit-for-update', args: {} })
    expect(res).toEqual({ ok: true, data: { cmd: 'quit-for-update' } })
  })

  it('rejects when nothing is listening', async () => {
    await expect(sendControlRequest(uniquePipe(), { cmd: 'quit-for-update', args: {} })).rejects.toThrow()
  })
})

describe('findLivePeers', () => {
  it('keeps only candidates whose pipe answers, in order', async () => {
    const alive = new Set(['pipe-b', 'pipe-c'])
    const found = await findLivePeers([peer('a'), peer('b'), peer('c')], async (p) => alive.has(p))
    expect(found.map((p) => p.name)).toEqual(['b', 'c'])
  })
})

describe('quitPeers', () => {
  it('waits on the reported pid until the process exits', async () => {
    let checks = 0
    const left = await quitPeers([peer('a')], {
      pollMs: 1,
      send: async () => ({ ok: true, data: { pid: 4242 } }),
      probe: async () => {
        throw new Error('pid peers are not probed')
      },
      isPidAlive: (pid) => {
        expect(pid).toBe(4242)
        return ++checks < 3
      }
    })
    expect(left).toEqual([])
    expect(checks).toBe(3)
  })

  it('falls back to the pipe for a peer that does not know the command', async () => {
    let probes = 0
    const left = await quitPeers([peer('old')], {
      pollMs: 1,
      send: async () => ({ ok: false, error: "unknown command 'quit-for-update'" }),
      probe: async () => ++probes < 2
    })
    expect(left).toEqual([])
  })

  it('returns the peers still running when the budget runs out', async () => {
    const left = await quitPeers([peer('a'), peer('b')], {
      timeoutMs: 20,
      pollMs: 5,
      send: async (path) => {
        if (path === 'pipe-a') throw new Error('hung up')
        return { ok: true, data: { pid: 7 } }
      },
      probe: async () => true,
      isPidAlive: () => false
    })
    expect(left.map((p) => p.name)).toEqual(['a'])
  })
})

describe('peerUpdatePrompt', () => {
  it('names the single other window', () => {
    const { message, detail } = peerUpdatePrompt('1.38.0', ['Work'])
    expect(message).toBe('Close all Orbital windows and install Orbital 1.38.0?')
    expect(detail).toContain('1 other Orbital window is open: Work.')
    expect(detail).toContain('It will be closed too')
  })

  it('counts and lists several', () => {
    const { detail } = peerUpdatePrompt(undefined, ['Work', 'Personal'])
    expect(detail).toContain('2 other Orbital windows are open: Work, Personal.')
    expect(detail).toContain('They will be closed too')
  })
})
