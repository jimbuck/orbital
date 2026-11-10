import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aggregateStatus, isPtyTabType, type TabType, type TerminalStatus } from '@shared/types'

/**
 * The status module through its interface: events in, a tab status and a
 * Worktree roll-up out. The repositories are stood in for by a few maps (the
 * roll-up uses the app's real aggregation rule); the pushes are spies.
 */
interface FakeTab {
  id: string
  worktreeId: string
  type: TabType
  status: TerminalStatus
}

const store = vi.hoisted(() => ({
  tabs: new Map<string, FakeTab>(),
  rollUps: new Map<string, TerminalStatus>(),
  state: vi.fn(),
  alert: vi.fn()
}))

vi.mock('./runtime', () => ({
  runtime: { broadcastState: store.state, broadcastAlert: store.alert },
  repo: {
    tabs: {
      get: (id: string) => store.tabs.get(id),
      updateStatus: (id: string, status: TerminalStatus) => {
        const tab = store.tabs.get(id)
        if (tab) tab.status = status
      }
    },
    worktrees: {
      get: (wid: string) => {
        const tabs = [...store.tabs.values()].filter((t) => t.worktreeId === wid)
        return tabs.length ? { id: wid, panes: [{ tabs }] } : undefined
      },
      recomputeStatus: (wid: string) => {
        const statuses = [...store.tabs.values()]
          .filter((t) => t.worktreeId === wid && isPtyTabType(t.type))
          .map((t) => t.status)
        const agg = aggregateStatus(statuses)
        store.rollUps.set(wid, agg)
        return agg
      }
    }
  }
}))

const { hookFired, statusReported, humanTyped, resetWorktree, ptyExited, launchFailed, tabsClosed, forgetTabs } =
  await import('./status')

const WT = 'wt'
let n = 0
/** A fresh tab per test, so one test's bookkeeping never reaches the next. */
const addTab = (type: TabType = 'agent', status: TerminalStatus = 'idle', worktreeId = WT): string => {
  const id = `tab-${++n}`
  store.tabs.set(id, { id, worktreeId, type, status })
  return id
}
const statusOf = (id: string): TerminalStatus | undefined => store.tabs.get(id)?.status
const notify = (kind: string): Record<string, unknown> => ({ notification_type: kind })

beforeEach(() => {
  forgetTabs([...store.tabs.keys()])
  store.tabs.clear()
  store.rollUps.clear()
  store.state.mockClear()
  store.alert.mockClear()
})

describe('a Claude hook firing', () => {
  it.each([
    ['UserPromptSubmit', {}, 'working'],
    ['PreToolUse', {}, 'working'],
    ['PostToolUse', {}, 'working'],
    ['Stop', {}, 'idle'],
    ['StopFailure', {}, 'error'],
    ['SessionEnd', {}, 'done'],
    ['Notification', notify('permission_prompt'), 'needs_attention'],
    ['Notification', notify('elicitation_dialog'), 'needs_attention'],
    ['Notification', notify('agent_needs_input'), 'needs_attention'],
    ['Notification', notify('elicitation_complete'), 'working']
  ] as const)('%s %j puts the tab in %s', (event, payload, expected) => {
    const tab = addTab('agent', 'done')
    expect(hookFired(tab, event, payload, 100)).toBe(expected)
    expect(statusOf(tab)).toBe(expected)
  })

  it('ignores events that say nothing about status, and pushes nothing', () => {
    const tab = addTab('agent', 'working')
    expect(hookFired(tab, 'Notification', notify('auth_success'), 100)).toBeNull()
    expect(hookFired(tab, 'SubagentStop', {}, 101)).toBeNull()
    expect(statusOf(tab)).toBe('working')
    expect(store.state).not.toHaveBeenCalled()
    expect(store.alert).not.toHaveBeenCalled()
  })

  it('pushes the state and the alert when it changes a status', () => {
    const tab = addTab()
    hookFired(tab, 'PreToolUse', {}, 100)
    expect(store.state).toHaveBeenCalledTimes(1)
    expect(store.alert).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for a tab that no longer exists', () => {
    expect(hookFired('gone', 'PreToolUse', {}, 100)).toBeNull()
    expect(store.state).not.toHaveBeenCalled()
  })

  it('drops an event that a later-fired one already beat here', () => {
    // The PostToolUse of a turn's last tool call regularly lands after the Stop.
    const tab = addTab()
    expect(hookFired(tab, 'Stop', {}, 200)).toBe('idle')
    expect(hookFired(tab, 'PostToolUse', {}, 100)).toBeNull()
    expect(statusOf(tab)).toBe('idle')
  })

  it('treats a missing fire time as "now"', () => {
    const tab = addTab()
    hookFired(tab, 'Stop', {}, Date.now() - 60_000)
    expect(hookFired(tab, 'PreToolUse', {}, undefined)).toBe('working')
  })
})

describe('an idle prompt from a session nobody has prompted', () => {
  const idle = notify('idle_prompt')

  it('is ignored after /clear (a SessionStart later than the last prompt)', () => {
    const tab = addTab()
    hookFired(tab, 'UserPromptSubmit', {}, 100)
    hookFired(tab, 'SessionStart', {}, 200)
    expect(hookFired(tab, 'Notification', idle, 300)).toBeNull()
    expect(statusOf(tab)).toBe('idle')
  })

  it('counts once the session has had a turn', () => {
    const tab = addTab()
    hookFired(tab, 'SessionStart', {}, 100)
    hookFired(tab, 'UserPromptSubmit', {}, 200)
    hookFired(tab, 'Stop', {}, 250)
    expect(hookFired(tab, 'Notification', idle, 300)).toBe('needs_attention')
  })

  it('tolerates the prompt being delivered before its SessionStart', () => {
    const tab = addTab()
    hookFired(tab, 'UserPromptSubmit', {}, 200)
    hookFired(tab, 'SessionStart', {}, 100) // fired first, delivered second: stale, but still tracked
    expect(hookFired(tab, 'Notification', idle, 300)).toBe('needs_attention')
  })

  it('counts when no SessionStart was seen (the app restarted mid-session)', () => {
    const tab = addTab()
    expect(hookFired(tab, 'Notification', idle, 300)).toBe('needs_attention')
  })

  it('never suppresses a permission prompt', () => {
    const tab = addTab()
    hookFired(tab, 'SessionStart', {}, 100)
    expect(hookFired(tab, 'Notification', notify('permission_prompt'), 300)).toBe('needs_attention')
  })
})

describe('the tab reporting its own status', () => {
  it('sets it', () => {
    const tab = addTab('terminal')
    statusReported(tab, 'needs_attention', 100)
    expect(statusOf(tab)).toBe('needs_attention')
  })

  it('obeys the same fire-time ordering as hooks', () => {
    const tab = addTab('terminal')
    hookFired(tab, 'Stop', {}, 200)
    statusReported(tab, 'working', 100)
    expect(statusOf(tab)).toBe('idle')
  })
})

describe('the human typing into a tab that needs attention', () => {
  const past = (): number => Date.now() - 5_000

  it('puts it back to work when Claude had asked something', () => {
    const tab = addTab()
    hookFired(tab, 'Notification', notify('permission_prompt'), past())
    humanTyped(tab, 'y')
    expect(statusOf(tab)).toBe('working')
  })

  it('leaves it idle at an idle prompt: typing there is only composing', () => {
    const tab = addTab()
    hookFired(tab, 'SessionStart', {}, past() - 20)
    hookFired(tab, 'UserPromptSubmit', {}, past() - 10)
    hookFired(tab, 'Notification', notify('idle_prompt'), past())
    expect(statusOf(tab)).toBe('needs_attention')
    humanTyped(tab, 'n')
    expect(statusOf(tab)).toBe('idle')
  })

  it('resets a CLI-reported needs-attention to idle, on a plain terminal too', () => {
    const tab = addTab('terminal')
    statusReported(tab, 'needs_attention', past())
    humanTyped(tab, '\r')
    expect(statusOf(tab)).toBe('idle')
  })

  it('forgets why the tab was blocked once it resolves', () => {
    const tab = addTab()
    hookFired(tab, 'Notification', notify('permission_prompt'), past())
    hookFired(tab, 'PreToolUse', {}, past() + 1) // approved elsewhere; kind is cleared
    statusReported(tab, 'needs_attention', past() + 2)
    humanTyped(tab, 'x')
    expect(statusOf(tab)).toBe('idle')
  })

  it('does not count focus and mouse reports as a response', () => {
    const tab = addTab()
    hookFired(tab, 'Notification', notify('permission_prompt'), past())
    humanTyped(tab, '\x1b[I')
    humanTyped(tab, '\x1b[O\x1b[<0;12;7M')
    expect(statusOf(tab)).toBe('needs_attention')
  })

  it('leaves a tab that is not waiting on anyone alone', () => {
    const tab = addTab('agent', 'working')
    humanTyped(tab, 'hello')
    expect(statusOf(tab)).toBe('working')
    expect(store.state).not.toHaveBeenCalled()
  })

  it('supersedes hook events fired before the keystroke', () => {
    const tab = addTab()
    const firedBefore = past()
    hookFired(tab, 'Notification', notify('permission_prompt'), firedBefore - 10)
    humanTyped(tab, 'y')
    // A Notification fired before the answer, delivered after it.
    expect(hookFired(tab, 'Notification', notify('permission_prompt'), firedBefore)).toBeNull()
    expect(statusOf(tab)).toBe('working')
  })
})

describe('resetting a Worktree', () => {
  it('idles every PTY tab, leaves other tabs alone, and re-aggregates', () => {
    const agent = addTab('agent', 'needs_attention')
    const terminal = addTab('terminal', 'working')
    const editor = addTab('editor', 'done')
    resetWorktree(WT)
    expect(statusOf(agent)).toBe('idle')
    expect(statusOf(terminal)).toBe('idle')
    expect(statusOf(editor)).toBe('done')
    expect(store.rollUps.get(WT)).toBe('idle')
    expect(store.state).toHaveBeenCalledTimes(1)
    expect(store.alert).toHaveBeenCalledTimes(1)
  })

  it('supersedes hook events fired before it', () => {
    const tab = addTab('agent', 'needs_attention')
    const firedBefore = Date.now() - 5_000
    resetWorktree(WT)
    expect(hookFired(tab, 'Notification', notify('permission_prompt'), firedBefore)).toBeNull()
    expect(statusOf(tab)).toBe('idle')
    expect(hookFired(tab, 'PreToolUse', {}, Date.now() + 1_000)).toBe('working')
  })

  it('is a no-op for an unknown Worktree', () => {
    resetWorktree('nope')
    expect(store.state).not.toHaveBeenCalled()
  })
})

describe('PTY lifecycle', () => {
  it('idles a terminal whose process exited', () => {
    const tab = addTab('terminal', 'working')
    ptyExited(tab)
    expect(statusOf(tab)).toBe('idle')
    expect(store.rollUps.get(WT)).toBe('idle')
  })

  it('marks a tab whose agent could not launch as an error, even right after a reset', () => {
    const tab = addTab('agent')
    resetWorktree(WT)
    launchFailed(tab)
    expect(statusOf(tab)).toBe('error')
    expect(store.rollUps.get(WT)).toBe('error')
  })
})

describe('the Worktree roll-up', () => {
  it('surfaces the most attention-worthy tab', () => {
    const a = addTab()
    const b = addTab()
    hookFired(a, 'PreToolUse', {}, 100)
    expect(store.rollUps.get(WT)).toBe('working')
    hookFired(b, 'Notification', notify('permission_prompt'), 100)
    expect(store.rollUps.get(WT)).toBe('needs_attention')
  })

  it('only touches the Worktree the tab lives in', () => {
    const tab = addTab('agent', 'idle', 'other')
    hookFired(tab, 'PreToolUse', {}, 100)
    expect(store.rollUps.get('other')).toBe('working')
    expect(store.rollUps.has(WT)).toBe(false)
  })

  it('drops a closed tab from the aggregate and pushes', () => {
    const keep = addTab()
    const close = addTab()
    hookFired(keep, 'PreToolUse', {}, 100)
    hookFired(close, 'Notification', notify('permission_prompt'), 100)
    store.tabs.delete(close)
    store.state.mockClear()
    store.alert.mockClear()
    tabsClosed(WT, [close])
    expect(store.rollUps.get(WT)).toBe('working')
    expect(store.state).toHaveBeenCalledTimes(1)
    expect(store.alert).toHaveBeenCalledTimes(1)
  })
})

describe('forgetting tabs', () => {
  it('drops their bookkeeping, so nothing carries over to a tab reusing the id', () => {
    const tab = addTab()
    hookFired(tab, 'SessionStart', {}, 900)
    hookFired(tab, 'Stop', {}, 1_000)
    forgetTabs([tab])
    // Fired "before" the forgotten Stop, and with no SessionStart on record:
    // both the ordering guard and the unprompted-idle check start from scratch.
    expect(hookFired(tab, 'Notification', notify('idle_prompt'), 500)).toBe('needs_attention')
  })
})
