import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Worktree } from '@shared/types'

vi.mock('./executable', () => ({
  resolveExecutable: async () => ({ file: 'cmd.exe', prefixArgs: ['/c', 'cursor-agent.cmd'] })
}))

import { cursorChatDir, cursorChatIdFromOutput, cursorProvider } from './cursor'

const project = { id: 'p1', name: 'orbital', repoPath: 'C:\\Projects\\orbital' } as Project
const worktree = { id: 'w1', projectId: 'p1', path: 'C:\\Projects\\orbital', branch: 'main' } as Worktree
const ID = 'a486e926-54e5-4adb-b6da-e50f636aac7d'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orbital-cursor-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('cursorProvider.resolveCommand', () => {
  it('opens a minted or stored chat with --resume=<id>', async () => {
    for (const resume of [false, true]) {
      const cmd = await cursorProvider.resolveCommand({ project, worktree, briefingPath: null, session: { id: ID, resume } })
      expect(cmd.args).toEqual(['/c', 'cursor-agent.cmd', `--resume=${ID}`])
    }
  })

  it('launches plain cursor-agent without a session', async () => {
    const cmd = await cursorProvider.resolveCommand({ project, worktree, briefingPath: null })
    expect(cmd.args).toEqual(['/c', 'cursor-agent.cmd'])
  })
})

describe('cursorChatIdFromOutput', () => {
  it('picks the UUID out of create-chat output, whatever surrounds it', () => {
    expect(cursorChatIdFromOutput(`${ID}\n`)).toBe(ID)
    expect(cursorChatIdFromOutput(`Created chat ${ID.toUpperCase()}\r\n`)).toBe(ID)
    expect(cursorChatIdFromOutput('Checking for updates...\n')).toBeNull()
    expect(cursorChatIdFromOutput('')).toBeNull()
  })
})

describe('cursorChatDir', () => {
  it('finds a chat under whichever workspace hash holds it', async () => {
    const dir = join(home, 'chats', '3f2a9c1e0b7d4a6e', ID)
    mkdirSync(join(home, 'chats', 'deadbeefdeadbeef'), { recursive: true })
    mkdirSync(dir, { recursive: true })
    expect(cursorChatDir(home, ID)).toBe(dir)
    expect(await cursorProvider.sessions!.find({ profileDir: home, cwd: 'C:\\x' }, ID)).toBe(dir)
  })

  it('is null when the chat is gone or there are no chats at all', () => {
    expect(cursorChatDir(home, ID)).toBeNull()
    mkdirSync(join(home, 'chats', '3f2a9c1e0b7d4a6e'), { recursive: true })
    expect(cursorChatDir(home, ID)).toBeNull()
  })
})
