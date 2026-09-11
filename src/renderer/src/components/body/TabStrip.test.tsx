import { describe, expect, it, vi } from 'vitest'
import type { Tab, TabConfig, TabType } from '@shared/types'

// TabStrip pulls in PaneGroup for the drag type, and PaneGroup pulls in the
// terminal (xterm, which wants a canvas). Only the title helper is under test.
vi.mock('./PaneGroup', () => ({ TAB_DND: 'application/x-orbital-tab' }))
import { tabTitle } from './TabStrip'

function tab(type: TabType, config: TabConfig = {}): Tab {
  return { id: 't1', worktreeId: 'w1', paneId: 'p1', type, status: null, position: 0, config }
}

describe('tabTitle', () => {
  it('names an editor "Editor" whatever file it was opened with', () => {
    // The editor holds many files; the one in its config is only the first.
    expect(tabTitle(tab('editor'))).toBe('Editor')
    expect(tabTitle(tab('editor', { filePath: 'src/map.ts' }))).toBe('Editor')
  })

  it('names a browser "Browser" until it has loaded a page, then by its host', () => {
    expect(tabTitle(tab('browser'))).toBe('Browser')
    expect(tabTitle(tab('browser', { url: 'https://example.com/docs' }))).toBe('example.com')
  })

  it('names a terminal "Terminal"', () => {
    expect(tabTitle(tab('terminal'))).toBe('Terminal')
  })

  it('lets an explicit title win', () => {
    expect(tabTitle(tab('editor', { filePath: 'src/map.ts', title: 'notes' }))).toBe('notes')
  })
})
