import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Worktree } from '@shared/types'

vi.mock('./executable', () => ({
  resolveExecutable: async () => ({ file: 'cmd.exe', prefixArgs: ['/c', 'codex.cmd'] })
}))

import { codexDiscoverThread, codexProvider, codexRolloutCwd, codexRolloutPath, codexThreadIdFromFilename } from './codex'

const project = { id: 'p1', name: 'orbital', repoPath: 'C:\\Projects\\orbital' } as Project
const worktree = { id: 'w1', projectId: 'p1', path: 'C:\\Projects\\orbital', branch: 'main' } as Worktree

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ID_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const ID_C = 'cccccccc-0000-4000-8000-000000000003'

/** A CODEX_HOME for the test, with sessions written under it. */
let home = ''

/** Write a rollout for `id` in `cwd` under sessions/<date>, stamped at `at` (ms). */
function rollout(date: string, id: string, cwd: string, at: number, opts: { legacy?: boolean; suffix?: string } = {}): string {
  const [y, m, d] = date.split('-')
  const dir = join(home, 'sessions', y, m, d)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-${date}T10-00-00-${id}${opts.suffix ?? ''}.jsonl`)
  const meta = opts.legacy
    ? `{"id":"${id}","timestamp":"${date}T10:00:00.000Z","instructions":null}\n` +
      `{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\\n  <cwd>${cwd.replace(/\\/g, '\\\\')}</cwd>\\n</environment_context>"}]}\n`
    : `{"timestamp":"${date}T10:00:00.000Z","type":"session_meta","payload":{"id":"${id}","timestamp":"${date}T10:00:00.000Z","cwd":${JSON.stringify(cwd)},"originator":"codex_cli_rs","cli_version":"0.99.0"}}\n` +
      `{"timestamp":"${date}T10:00:01.000Z","type":"turn_context","payload":{"cwd":"elsewhere"}}\n`
  writeFileSync(file, meta)
  utimesSync(file, at / 1000, at / 1000)
  return file
}

/** Today's local date as YYYY-MM-DD. */
function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orbital-codex-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('codexProvider.resolveCommand', () => {
  it('runs `codex resume <id>` for a stored session', async () => {
    const cmd = await codexProvider.resolveCommand({
      project,
      worktree,
      briefingPath: null,
      session: { id: ID_A, resume: true }
    })
    expect(cmd.args).toEqual(['/c', 'codex.cmd', 'resume', ID_A])
  })

  it('launches plain `codex` when there is nothing to resume', async () => {
    const cmd = await codexProvider.resolveCommand({ project, worktree, briefingPath: null })
    expect(cmd.args).toEqual(['/c', 'codex.cmd'])
  })

  it('cannot choose an id before launch', async () => {
    expect(await codexProvider.sessions!.mint({ profileDir: home, cwd: 'C:\\x' })).toBeNull()
  })
})

describe('rollout filenames', () => {
  it('extracts the thread id, with or without a revert suffix or compression', () => {
    expect(codexThreadIdFromFilename(`rollout-2026-03-21T22-54-32-${ID_A}.jsonl`)).toBe(ID_A)
    expect(codexThreadIdFromFilename(`rollout-2026-03-21T22-54-32-${ID_A}_${ID_B}.jsonl`)).toBe(ID_A)
    expect(codexThreadIdFromFilename(`rollout-2026-03-21T22-54-32-${ID_A}.jsonl.zst`)).toBe(ID_A)
    expect(codexThreadIdFromFilename('rollout-compression.lock')).toBeNull()
    expect(codexThreadIdFromFilename('notes.txt')).toBeNull()
  })
})

describe('codexRolloutCwd', () => {
  it('reads the cwd from a session_meta first line', () => {
    const file = rollout('2026-01-05', ID_A, 'C:\\Projects\\orbital', Date.now())
    expect(codexRolloutCwd(file)).toBe('C:\\Projects\\orbital')
  })

  it('falls back to the environment_context of a 2025-format rollout', () => {
    const file = rollout('2025-09-05', ID_A, 'C:\\Work\\thing', Date.now(), { legacy: true })
    expect(codexRolloutCwd(file)).toBe('C:\\Work\\thing')
  })

  it('is null for a missing or compressed file', () => {
    expect(codexRolloutCwd(join(home, 'nope.jsonl'))).toBeNull()
    expect(codexRolloutCwd(join(home, 'x.jsonl.zst'))).toBeNull()
  })
})

describe('codexRolloutPath', () => {
  it('finds a session by id across date directories', () => {
    const file = rollout('2026-02-10', ID_A, 'C:\\a', Date.now())
    rollout('2026-03-01', ID_B, 'C:\\a', Date.now())
    expect(codexRolloutPath(home, ID_A)).toBe(file)
    expect(codexRolloutPath(home, ID_A.toUpperCase())).toBe(file)
    expect(codexRolloutPath(home, ID_C)).toBeNull()
  })

  it('prefers the newest rollout of a reverted thread', () => {
    rollout('2026-02-10', ID_A, 'C:\\a', Date.now())
    const reverted = rollout('2026-02-12', ID_A, 'C:\\a', Date.now(), { suffix: `_${ID_B}` })
    expect(codexRolloutPath(home, ID_A)).toBe(reverted)
  })

  it('is null without a sessions directory', () => {
    expect(codexRolloutPath(home, ID_A)).toBeNull()
  })
})

describe('codexDiscoverThread', () => {
  it('returns the thread started in the worktree after launch', () => {
    const launchedAt = Date.now() - 10_000
    rollout(today(), ID_A, 'c:/projects/orbital/', launchedAt + 1_000)
    expect(codexDiscoverThread(home, 'C:\\Projects\\orbital', launchedAt, new Set())).toBe(ID_A)
  })

  it('ignores sessions from before launch, other directories, and taken ids', () => {
    const launchedAt = Date.now() - 10_000
    rollout(today(), ID_A, 'C:\\Projects\\orbital', launchedAt - 60_000) // too old
    rollout(today(), ID_B, 'C:\\Projects\\other', launchedAt + 1_000) // elsewhere
    rollout(today(), ID_C, 'C:\\Projects\\orbital', launchedAt + 2_000) // owned by another tab
    expect(codexDiscoverThread(home, 'C:\\Projects\\orbital', launchedAt, new Set([ID_C]))).toBeNull()
  })

  it('hands the oldest of several new sessions to the first asker', () => {
    const launchedAt = Date.now() - 10_000
    rollout(today(), ID_B, 'C:\\Projects\\orbital', launchedAt + 3_000)
    rollout(today(), ID_A, 'C:\\Projects\\orbital', launchedAt + 1_000)
    expect(codexDiscoverThread(home, 'C:\\Projects\\orbital', launchedAt, new Set())).toBe(ID_A)
    expect(codexDiscoverThread(home, 'C:\\Projects\\orbital', launchedAt, new Set([ID_A]))).toBe(ID_B)
  })

  it('goes through the provider seam', async () => {
    const launchedAt = Date.now() - 10_000
    rollout(today(), ID_A, 'C:\\Projects\\orbital', launchedAt + 1_000)
    const lookup = { profileDir: home, cwd: 'C:\\Projects\\orbital' }
    expect(await codexProvider.sessions!.discover!(lookup, launchedAt, new Set())).toBe(ID_A)
    expect(await codexProvider.sessions!.find(lookup, ID_A)).toContain(ID_A)
  })
})
