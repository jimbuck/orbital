import { describe, expect, it, vi } from 'vitest'

vi.mock('./runtime', () => ({ runtime: {}, repo: {} }))

const { trackPromptLifecycle, isUnpromptedIdle, forgetTabStatus } = await import('./status')

const idle = { notification_type: 'idle_prompt' }

describe('isUnpromptedIdle', () => {
  it('ignores idle_prompt from a session with no prompt yet (after /clear)', () => {
    trackPromptLifecycle('t1', 'UserPromptSubmit', 100)
    trackPromptLifecycle('t1', 'SessionStart', 200) // /clear starts a new session
    expect(isUnpromptedIdle('t1', idle)).toBe(true)
    forgetTabStatus('t1')
  })

  it('keeps idle_prompt once the session has had a turn', () => {
    trackPromptLifecycle('t2', 'SessionStart', 100)
    trackPromptLifecycle('t2', 'UserPromptSubmit', 200)
    expect(isUnpromptedIdle('t2', idle)).toBe(false)
    forgetTabStatus('t2')
  })

  it('tolerates the prompt arriving before its SessionStart', () => {
    trackPromptLifecycle('t3', 'UserPromptSubmit', 200)
    trackPromptLifecycle('t3', 'SessionStart', 100)
    expect(isUnpromptedIdle('t3', idle)).toBe(false)
    forgetTabStatus('t3')
  })

  it('does not suppress when no SessionStart was seen (app restarted mid-session)', () => {
    expect(isUnpromptedIdle('t4', idle)).toBe(false)
  })

  it('never suppresses a permission prompt', () => {
    trackPromptLifecycle('t5', 'SessionStart', 100)
    expect(isUnpromptedIdle('t5', { notification_type: 'permission_prompt' })).toBe(false)
    forgetTabStatus('t5')
  })
})
