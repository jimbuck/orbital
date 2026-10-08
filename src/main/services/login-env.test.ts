import { describe, expect, it } from 'vitest'
import { parseMarkedPath } from './login-env'

describe('parseMarkedPath', () => {
  const m = '__M__'

  it('takes the value between the markers, ignoring profile noise around it', () => {
    expect(parseMarkedPath(`welcome!\n${m}/opt/homebrew/bin:/usr/bin${m}\nbye`, m)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('is null without a closing marker or with an empty value', () => {
    expect(parseMarkedPath(`${m}/usr/bin`, m)).toBeNull()
    expect(parseMarkedPath(`${m}${m}`, m)).toBeNull()
    expect(parseMarkedPath('nothing here', m)).toBeNull()
  })
})
