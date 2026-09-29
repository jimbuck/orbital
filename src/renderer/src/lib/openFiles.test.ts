import { describe, expect, it } from 'vitest'
import { promoteFile, showFile, type PreviewableFile } from './openFiles'

const f = (path: string, preview = false): PreviewableFile => ({ path, preview })
const make = (): PreviewableFile => ({ path: '', preview: false })
const view = (files: PreviewableFile[]): string[] => files.map((x) => (x.preview ? `~${x.path}` : x.path))

describe('showFile', () => {
  it('opens a preview on the end when there is none', () => {
    const r = showFile([f('a')], 'b', make, true)
    expect(view(r.files)).toEqual(['a', '~b'])
    expect(r.replaced).toBeNull()
  })

  it('replaces the existing preview in its own slot', () => {
    const r = showFile([f('a'), f('b', true), f('c')], 'd', make, true)
    expect(view(r.files)).toEqual(['a', '~d', 'c'])
    expect(r.replaced).toBe('b')
  })

  it('never holds more than one preview', () => {
    let files: PreviewableFile[] = []
    for (const p of ['a', 'b', 'c']) files = showFile(files, p, make, true).files
    expect(view(files)).toEqual(['~c'])
  })

  it('opens a permanent file on the end and keeps the preview', () => {
    const r = showFile([f('a', true)], 'b', make, false)
    expect(view(r.files)).toEqual(['~a', 'b'])
    expect(r.replaced).toBeNull()
  })

  it('a preview ask for an already-open file changes nothing', () => {
    const files = [f('a'), f('b', true)]
    expect(showFile(files, 'a', make, true).files).toBe(files)
    expect(showFile(files, 'b', make, true).files).toBe(files)
  })

  it('a permanent ask for the preview promotes it in place', () => {
    const r = showFile([f('a', true), f('b')], 'a', make, false)
    expect(view(r.files)).toEqual(['a', 'b'])
  })

  it('uses the buffer `make` builds, with the path and preview flag set', () => {
    const r = showFile<PreviewableFile & { extra: number }>([], 'x', () => ({ path: '', preview: false, extra: 7 }), true)
    expect(r.files).toEqual([{ path: 'x', preview: true, extra: 7 }])
  })
})

describe('promoteFile', () => {
  it('turns the preview into a permanent file', () => {
    expect(view(promoteFile([f('a', true)], 'a'))).toEqual(['a'])
  })

  it('returns the same array when there is nothing to promote', () => {
    const files = [f('a'), f('b', true)]
    expect(promoteFile(files, 'a')).toBe(files)
    expect(promoteFile(files, 'zzz')).toBe(files)
  })

  it('a promoted file is no longer replaced by the next preview', () => {
    const files = promoteFile(showFile([], 'a', make, true).files, 'a')
    expect(view(showFile(files, 'b', make, true).files)).toEqual(['a', '~b'])
  })
})
