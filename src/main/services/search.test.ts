import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchQuery } from '@shared/types'

/**
 * The content-search service, against a stand-in for the processes it spawns.
 *
 * The real thing shells out per checkout, so the fake below is keyed by repo
 * path and hands back canned output. That is enough to pin the parts that
 * actually bite: both backends' record formats, which checkouts a scope
 * selects, that a failing checkout does not take the others down with it, and
 * that a superseded search returns nothing rather than overwriting the results
 * its replacement is about to produce.
 *
 * Which backend runs is pinned per test with `__setRgPath`. Left to itself the
 * service would find this repo's real ripgrep and try to run it against the
 * imaginary checkouts below.
 */

interface FakeResult {
  stdout?: string
  stderr?: string
  code?: number
}

/** Canned git output per checkout path. */
let responses: Map<string, FakeResult>
/** Every spawn the service made, in order. */
let spawned: { command: string; cwd: string; args: string[] }[]
/** When true, runs do not settle until `settleAll()` is called. */
let hold: boolean
let pending: (() => void)[]
/** Worktree rows the repository layer reports. */
let worktreeRows: { id: string; path: string; projectId: string }[]

/** One fake process, shared by both backends — they differ only in argv. */
function fakeRun(command: string, cwd: string, args: string[]) {
  spawned.push({ command, cwd, args })
  let cancelled = false
  let settle: ((v: unknown) => void) | null = null
  const result = new Promise((resolve) => {
    settle = resolve
    const finish = (): void => {
      const r = responses.get(cwd) ?? { stdout: '', code: 1 }
      resolve(
        cancelled
          ? { stdout: '', stderr: '', code: 0, cancelled: true }
          : { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 }
      )
    }
    if (hold) pending.push(finish)
    else queueMicrotask(finish)
  })
  return {
    result,
    cancel: () => {
      cancelled = true
      // A killed process still calls back; the service must see it settle.
      settle?.({ stdout: '', stderr: '', code: 0, cancelled: true })
    }
  }
}

vi.mock('./git', () => ({
  git: { captureCancellable: (cwd: string, args: string[]) => fakeRun('git', cwd, args) }
}))

vi.mock('./spawn', () => ({
  captureCancellable: (command: string, cwd: string, args: string[]) => fakeRun(command, cwd, args)
}))

vi.mock('../db/repositories', () => ({
  worktrees: { listPaths: () => worktreeRows }
}))

const { searchContent, cancelSearch, grepArgs } = await import('./search')
const { __setRgPath } = await import('./ripgrep')

/** A `rg --json` match event. */
const rgRec = (path: string, line: number, text: string): string =>
  JSON.stringify({
    type: 'match',
    data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line }
  })

/** A `git grep -z -n` record: path, line and text, NUL-separated. */
const rec = (path: string, line: number, text: string): string => `${path}\0${line}\0${text}`

beforeEach(() => {
  responses = new Map()
  spawned = []
  pending = []
  hold = false
  // The git backend unless a test says otherwise — these cases predate ripgrep
  // and pin the fallback, which still has to work.
  __setRgPath(null)
  worktreeRows = [
    { id: 'w1', path: 'C:/repo/one', projectId: 'p1' },
    { id: 'w2', path: 'C:/repo/two', projectId: 'p1' },
    { id: 'w3', path: 'C:/repo/other', projectId: 'p2' }
  ]
})

function settleAll(): void {
  const queued = pending
  pending = []
  for (const f of queued) f()
}

const base: SearchQuery = { query: 'useStore', scope: 'worktree', worktreeId: 'w1' }

describe('grepArgs', () => {
  it('asks for the file set the file-name index uses, skipping binaries', () => {
    const args = grepArgs({ query: 'x' })
    expect(args).toContain('--untracked')
    expect(args).toContain('-I')
    expect(args).toContain('-z')
    expect(args).toContain('-n')
  })

  it('is case-insensitive and literal by default', () => {
    const args = grepArgs({ query: 'a(b' })
    expect(args).toContain('-i')
    expect(args).toContain('-F')
    expect(args).not.toContain('-P')
  })

  it('switches to PCRE for a regex query, and drops -i when case matters', () => {
    const args = grepArgs({ query: 'a(b)', regex: true, caseSensitive: true })
    expect(args).toContain('-P')
    expect(args).not.toContain('-F')
    expect(args).not.toContain('-i')
  })

  it('passes whole-word through to git rather than faking it in the pattern', () => {
    expect(grepArgs({ query: 'use', wholeWord: true })).toContain('-w')
    const plain = grepArgs({ query: 'use' })
    expect(plain).not.toContain('-w')
    // The pattern itself is untouched either way.
    expect(plain[plain.indexOf('-e') + 1]).toBe('use')
  })

  it('turns include globs into root-anchored pathspecs', () => {
    const args = grepArgs({ query: 'x', include: 'src/**, *.ts' })
    expect(args).toContain(':(top,glob)src/**')
    expect(args).toContain(':(top,glob)*.ts')
    expect(args).not.toContain('.')
  })

  it('searches everything when no glob is given', () => {
    expect(grepArgs({ query: 'x' }).at(-1)).toBe('.')
  })
})

describe('searchContent — parsing', () => {
  it('groups matches by file and records their line numbers', async () => {
    responses.set('C:/repo/one', {
      stdout: [rec('src/a.ts', 12, 'const useStore = 1'), rec('src/a.ts', 20, '  useStore()'), rec('src/b.ts', 5, 'useStore')].join('\n') + '\n',
      code: 0
    })
    const res = await searchContent(base, 's1')
    expect(res.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(res.files[0].matches.map((m) => m.line)).toEqual([12, 20])
    expect(res.totalMatches).toBe(3)
  })

  it('strips the carriage return a CRLF checkout leaves on every line', async () => {
    responses.set('C:/repo/one', { stdout: `${rec('a.ts', 1, 'useStore()\r')}\n`, code: 0 })
    const res = await searchContent(base, 's1')
    expect(res.files[0].matches[0].text).toBe('useStore()')
  })

  it('marks where the match is, for highlighting', async () => {
    responses.set('C:/repo/one', { stdout: `${rec('a.ts', 1, 'const useStore = useStore')}\n`, code: 0 })
    const res = await searchContent(base, 's1')
    const m = res.files[0].matches[0]
    expect(m.ranges).toEqual([
      [6, 14],
      [17, 25]
    ])
    expect(m.text.slice(...m.ranges[0])).toBe('useStore')
  })

  it('keeps a path containing a colon intact', async () => {
    // The reason the format is NUL-separated rather than colon-separated.
    responses.set('C:/repo/one', { stdout: `${rec('weird:name.ts', 3, 'useStore')}\n`, code: 0 })
    const res = await searchContent(base, 's1')
    expect(res.files[0].path).toBe('weird:name.ts')
    expect(res.files[0].matches[0].line).toBe(3)
  })

  it('clips a very long line around its match instead of shipping the whole thing', async () => {
    const long = `${'x'.repeat(2000)}useStore${'y'.repeat(2000)}`
    responses.set('C:/repo/one', { stdout: `${rec('bundle.js', 1, long)}\n`, code: 0 })
    const res = await searchContent(base, 's1')
    const m = res.files[0].matches[0]
    expect(m.text.length).toBeLessThan(long.length)
    expect(m.clippedStart).toBeGreaterThan(0)
    // The ranges still point at the match inside the clipped text.
    expect(m.text.slice(...m.ranges[0])).toBe('useStore')
  })

  it('ignores a malformed record rather than failing the search', async () => {
    responses.set('C:/repo/one', { stdout: `garbage-with-no-nul\n${rec('a.ts', 1, 'useStore')}\n`, code: 0 })
    const res = await searchContent(base, 's1')
    expect(res.files).toHaveLength(1)
    expect(res.files[0].path).toBe('a.ts')
  })
})

describe('searchContent — scope', () => {
  it('searches only the named checkout for worktree scope', async () => {
    await searchContent({ query: 'xx', scope: 'worktree', worktreeId: 'w2' }, 's1')
    expect(spawned.map((s) => s.cwd)).toEqual(['C:/repo/two'])
  })

  it('searches every checkout of the same project for project scope', async () => {
    await searchContent({ query: 'xx', scope: 'project', worktreeId: 'w1' }, 's1')
    expect(spawned.map((s) => s.cwd).sort()).toEqual(['C:/repo/one', 'C:/repo/two'])
  })

  it('searches the whole workspace for workspace scope', async () => {
    await searchContent({ query: 'xx', scope: 'workspace', worktreeId: 'w1' }, 's1')
    expect(spawned).toHaveLength(3)
  })

  it('falls back to the whole workspace when no anchor is given', async () => {
    await searchContent({ query: 'xx' }, 's1')
    expect(spawned).toHaveLength(3)
  })

  it('tags each hit with the checkout it came from', async () => {
    responses.set('C:/repo/two', { stdout: `${rec('a.ts', 1, 'xx')}\n`, code: 0 })
    const res = await searchContent({ query: 'xx', scope: 'workspace' }, 's1')
    expect(res.files[0].worktreeId).toBe('w2')
  })
})

describe('searchContent — failure and limits', () => {
  it('does not spawn anything for a one-character query', async () => {
    const res = await searchContent({ query: 'u', worktreeId: 'w1' }, 's1')
    expect(spawned).toHaveLength(0)
    expect(res.totalMatches).toBe(0)
  })

  it('treats "no matches" as a result, not a failure', async () => {
    responses.set('C:/repo/one', { stdout: '', code: 1 })
    const res = await searchContent(base, 's1')
    expect(res.errors).toEqual([])
    expect(res.files).toEqual([])
  })

  it('surfaces a checkout that failed without losing the ones that worked', async () => {
    responses.set('C:/repo/one', { stderr: "fatal: -e option, 'foo(': missing closing parenthesis", code: 128 })
    responses.set('C:/repo/two', { stdout: `${rec('a.ts', 1, 'foo')}\n`, code: 0 })
    const res = await searchContent({ query: 'foo(', regex: true, scope: 'project', worktreeId: 'w1' }, 's1')
    expect(res.errors).toEqual([
      { worktreeId: 'w1', message: "-e option, 'foo(': missing closing parenthesis" }
    ])
    expect(res.files).toHaveLength(1)
  })

  it('caps the total and says so', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => rec('a.ts', i + 1, 'hit')).join('\n')
    responses.set('C:/repo/one', { stdout: `${lines}\n`, code: 0 })
    const res = await searchContent({ ...base, query: 'hit', limit: 4 }, 's1')
    expect(res.totalMatches).toBe(4)
    expect(res.truncated).toBe(true)
    expect(res.files[0].truncated).toBe(true)
  })
})

describe('searchContent — cancellation', () => {
  it('kills the previous search in a slot and reports the old one as cancelled', async () => {
    hold = true
    responses.set('C:/repo/one', { stdout: `${rec('a.ts', 1, 'first')}\n`, code: 0 })
    const first = searchContent({ ...base, query: 'first' }, 'slot')

    // A second search in the same slot arrives while the first is still running.
    responses.set('C:/repo/one', { stdout: `${rec('b.ts', 2, 'second')}\n`, code: 0 })
    const second = searchContent({ ...base, query: 'second' }, 'slot')

    settleAll()
    const firstRes = await first
    const secondRes = await second

    expect(firstRes.cancelled).toBe(true)
    expect(firstRes.files).toEqual([])
    expect(secondRes.cancelled).toBe(false)
    expect(secondRes.files[0].path).toBe('b.ts')
  })

  it('leaves a search in another slot alone', async () => {
    hold = true
    responses.set('C:/repo/one', { stdout: `${rec('a.ts', 1, 'mine')}\n`, code: 0 })
    const mine = searchContent({ ...base, query: 'mine' }, 'tab-1')
    const theirs = searchContent({ ...base, query: 'mine' }, 'tab-2')
    settleAll()
    expect((await mine).cancelled).toBe(false)
    expect((await theirs).cancelled).toBe(false)
  })

  it('cancelSearch stops a search in flight', async () => {
    hold = true
    responses.set('C:/repo/one', { stdout: `${rec('a.ts', 1, 'x')}\n`, code: 0 })
    const running = searchContent(base, 'slot')
    cancelSearch('slot')
    settleAll()
    expect((await running).cancelled).toBe(true)
  })

  it('cancelling an unknown slot is a no-op', () => {
    expect(() => cancelSearch('never-used')).not.toThrow()
  })
})

describe('searchContent — ripgrep', () => {
  const RG = 'C:/bin/rg.exe'

  it('runs the ripgrep binary instead of git when it is there', async () => {
    __setRgPath(RG)
    responses.set('C:/repo/one', { stdout: rgRec('src/a.ts', 3, 'useStore()') })

    const res = await searchContent(base, 's1')

    expect(spawned.map((s) => s.command)).toEqual([RG])
    expect(res.files[0]).toMatchObject({ path: 'src/a.ts', worktreeId: 'w1' })
    expect(res.files[0].matches[0]).toMatchObject({ line: 3, text: 'useStore()' })
  })

  it('produces the same result shape as git grep for the same hits', async () => {
    // The whole point of the swap being invisible: neither the renderer nor the
    // user should be able to tell which one ran.
    __setRgPath(RG)
    responses.set('C:/repo/one', { stdout: `${rgRec('src/a.ts', 1, 'a useStore b')}\n` })
    const viaRg = await searchContent(base, 's1')

    __setRgPath(null)
    responses.set('C:/repo/one', { stdout: rec('src/a.ts', 1, 'a useStore b') })
    const viaGit = await searchContent(base, 's2')

    expect(viaRg.files).toEqual(viaGit.files)
    expect(viaRg.files[0].matches[0].ranges).toEqual([[2, 10]])
  })

  it('strips the line terminator ripgrep keeps, including a CRLF one', async () => {
    __setRgPath(RG)
    responses.set('C:/repo/one', {
      stdout: JSON.stringify({
        type: 'match',
        data: { path: { text: 'src\\a.ts' }, lines: { text: 'useStore()\r\n' }, line_number: 2 }
      })
    })

    const res = await searchContent(base, 's1')

    expect(res.files[0].matches[0].text).toBe('useStore()')
    // Windows separators too: everything downstream speaks POSIX paths.
    expect(res.files[0].path).toBe('src/a.ts')
  })

  it('ignores the events that are not matches', async () => {
    // rg --json also emits begin/end/summary, and a `context` event when asked.
    __setRgPath(RG)
    responses.set('C:/repo/one', {
      stdout: [
        JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
        rgRec('src/a.ts', 1, 'useStore'),
        JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
        'not json at all',
        ''
      ].join('\n')
    })

    const res = await searchContent(base, 's1')
    expect(res.totalMatches).toBe(1)
  })

  it('still reports a checkout that failed', async () => {
    __setRgPath(RG)
    responses.set('C:/repo/one', { code: 2, stderr: 'regex parse error' })

    const res = await searchContent(base, 's1')

    expect(res.errors).toEqual([{ worktreeId: 'w1', message: 'regex parse error' }])
  })
})
