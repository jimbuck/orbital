import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Project, Worktree } from '@shared/types'

vi.mock('./executable', () => ({
  resolveExecutable: async () => ({ file: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'] })
}))

import { claudeProjectDirName, claudeProvider, claudeTranscriptPath } from './claude'

const project = { id: 'p1', name: 'orbital', repoPath: 'C:\\Projects\\orbital' } as Project
const worktree = { id: 'w1', projectId: 'p1', path: 'C:\\Projects\\orbital', branch: 'main' } as Worktree

describe('claudeProvider.resolveCommand', () => {
  it('starts a fresh session under the id Orbital minted', async () => {
    const cmd = await claudeProvider.resolveCommand({
      project,
      worktree,
      briefingPath: null,
      session: { id: 'aaaaaaaa-0000-4000-8000-000000000001', resume: false }
    })
    expect(cmd.file).toBe('cmd.exe')
    expect(cmd.args).toEqual(['/c', 'claude.cmd', '--session-id', 'aaaaaaaa-0000-4000-8000-000000000001'])
  })

  it('resumes a stored session by id, keeping the briefing', async () => {
    const cmd = await claudeProvider.resolveCommand({
      project,
      worktree,
      briefingPath: 'C:\\app\\brief.txt',
      session: { id: 'aaaaaaaa-0000-4000-8000-000000000001', resume: true }
    })
    expect(cmd.args).toEqual([
      '/c',
      'claude.cmd',
      '--resume',
      'aaaaaaaa-0000-4000-8000-000000000001',
      '--append-system-prompt-file',
      'C:\\app\\brief.txt'
    ])
  })

  it('passes no session flag when none is given', async () => {
    const cmd = await claudeProvider.resolveCommand({ project, worktree, briefingPath: null })
    expect(cmd.args).toEqual(['/c', 'claude.cmd'])
  })

  it('mints a UUID up front and finds a session by its transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orbital-claude-'))
    try {
      const lookup = { profileDir: root, cwd: 'C:\\Projects\\orbital' }
      const id = await claudeProvider.sessions!.mint(lookup)
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      expect(await claudeProvider.sessions!.find(lookup, id!)).toBeNull()
      const transcript = claudeTranscriptPath(root, lookup.cwd, id!)
      mkdirSync(dirname(transcript), { recursive: true })
      writeFileSync(transcript, '{}\n')
      expect(await claudeProvider.sessions!.find(lookup, id!)).toBe(transcript)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('claude transcript location', () => {
  it('encodes the working directory the way Claude Code names its project folders', () => {
    expect(claudeProjectDirName('C:\\Projects\\orbital')).toBe('C--Projects-orbital')
    expect(claudeProjectDirName('C:\\Projects\\.orbital-worktrees\\orbital\\feature-x')).toBe(
      'C--Projects--orbital-worktrees-orbital-feature-x'
    )
    expect(claudeProjectDirName('/home/james/orbital')).toBe('-home-james-orbital')
    expect(claudeProjectDirName('\\\\192.168.1.11\\home\\Notes')).toBe('--192-168-1-11-home-Notes')
  })

  it('points at <profile>/projects/<dir>/<session>.jsonl', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    expect(claudeTranscriptPath('C:\\Users\\james\\.claude', 'C:\\Projects\\orbital', id)).toBe(
      join('C:\\Users\\james\\.claude', 'projects', 'C--Projects-orbital', `${id}.jsonl`)
    )
  })
})
