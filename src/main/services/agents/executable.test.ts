import { describe, expect, it } from 'vitest'
import { shimSafeArg } from './executable'

describe('shimSafeArg', () => {
  it('leaves text alone for a directly spawned executable', () => {
    expect(shimSafeArg('say "hi"\nthen go', [])).toBe('say "hi"\nthen go')
  })

  it('flattens newlines and swaps double quotes when a shell shim re-parses the line', () => {
    expect(shimSafeArg('say "hi"\r\nthen & go', ['/c', 'claude.cmd'])).toBe("say 'hi' then & go")
  })

  it('gives a one-word prompt whitespace, so node-pty quotes it and cmd.exe never sees a bare &', () => {
    expect(shimSafeArg('lint&&test', ['/c', 'claude.cmd'])).toBe('lint&&test ')
  })
})
