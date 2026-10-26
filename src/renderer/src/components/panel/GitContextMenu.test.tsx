import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GitFileStatus } from '@shared/types'

import GitContextMenu, { appendIgnore, ignoreLine, type GitMenuActions, type GitMenuTarget } from './GitContextMenu'

let bridge: Record<string, ReturnType<typeof vi.fn>>
let actions: { [K in keyof GitMenuActions]: ReturnType<typeof vi.fn> }
let closed: number

beforeEach(() => {
  closed = 0
  bridge = {
    openInEditor: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    revealPath: vi.fn(async () => undefined),
    resolvePath: vi.fn(async () => 'C:\\repo\\src\\a.ts'),
    writeClipboard: vi.fn(),
    readFile: vi.fn(async () => 'node_modules\n'),
    writeFile: vi.fn(async () => undefined)
  }
  vi.stubGlobal('orbital', bridge)
  actions = { openDiff: vi.fn(), openFile: vi.fn(), stage: vi.fn(), unstage: vi.fn(), discard: vi.fn() }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const file = (path: string, state: GitFileStatus['state'], staged = false): GitFileStatus =>
  ({ path, state, staged }) as GitFileStatus

function show(target: GitMenuTarget, busy = false): void {
  render(
    <GitContextMenu
      worktreeId="w1"
      target={target}
      pos={{ x: 10, y: 10 }}
      busy={busy}
      actions={actions}
      onClose={() => {
        closed++
      }}
    />
  )
}

const labels = (): string[] => screen.getAllByRole('menuitem').map((b) => b.textContent ?? '')
const item = (name: string): HTMLButtonElement => screen.getByRole('menuitem', { name }) as HTMLButtonElement

describe('items per row', () => {
  it('offers the open, hand-off, stage/discard and copy actions on an unstaged file', () => {
    show({ kind: 'file', section: 'u', file: file('src/a.ts', 'modified') })
    expect(labels()).toEqual([
      'Open Diff',
      'Open File',
      'Open in External Editor',
      'Open with Default App',
      expect.stringMatching(/^Reveal in /),
      'Stage',
      'Discard Changes…',
      'Copy Path',
      'Copy Relative Path'
    ])
  })

  it('offers Unstage, and no discard, on a staged file', () => {
    show({ kind: 'file', section: 's', file: file('src/a.ts', 'modified', true) })
    expect(labels()).toContain('Unstage')
    expect(labels()).not.toContain('Stage')
    expect(labels()).not.toContain('Discard Changes…')
  })

  it('offers Delete File and Add to .gitignore on an untracked file', () => {
    show({ kind: 'file', section: 'u', file: file('notes.txt', 'untracked') })
    expect(labels()).toContain('Delete File…')
    expect(labels()).toContain('Add to .gitignore')
  })

  it('disables opening a deleted file, which has nothing on disk', () => {
    show({ kind: 'file', section: 'u', file: file('gone.ts', 'deleted') })
    expect(item('Open File').disabled).toBe(true)
    expect(item('Open in External Editor').disabled).toBe(true)
    expect(item('Open Diff').disabled).toBe(false)
  })

  it('offers folder-wide git actions and a terminal on a folder', () => {
    show({ kind: 'dir', section: 'u', path: 'src', files: [file('src/a.ts', 'modified'), file('src/b.ts', 'added')] })
    expect(labels()).toContain('Stage Folder')
    expect(labels()).toContain('Open in Terminal')
    expect(labels()).not.toContain('Open Diff')
    expect(labels()).not.toContain('Add to .gitignore')
  })

  it('disables the git actions while the panel has an operation in flight', () => {
    show({ kind: 'file', section: 'u', file: file('src/a.ts', 'modified') }, true)
    expect(item('Stage').disabled).toBe(true)
    expect(item('Open File').disabled).toBe(false)
  })
})

describe('actions', () => {
  it('hands stage of every file in a folder to the panel and closes', () => {
    show({ kind: 'dir', section: 'u', path: 'src', files: [file('src/a.ts', 'modified'), file('src/b.ts', 'added')] })
    fireEvent.click(item('Stage Folder'))
    expect(actions.stage).toHaveBeenCalledWith(['src/a.ts', 'src/b.ts'])
    expect(closed).toBe(1)
  })

  it('confirms before discarding', () => {
    show({ kind: 'file', section: 'u', file: file('src/a.ts', 'modified') })
    fireEvent.click(item('Discard Changes…'))
    expect(actions.discard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(actions.discard).toHaveBeenCalledWith(['src/a.ts'])
  })

  it('opens the file in the external editor through main', async () => {
    show({ kind: 'file', section: 'u', file: file('src/a.ts', 'modified') })
    fireEvent.click(item('Open in External Editor'))
    await waitFor(() => expect(closed).toBe(1))
    expect(bridge.openInEditor).toHaveBeenCalledWith('w1', 'src/a.ts')
  })

  it('keeps the menu open with the reason when the editor cannot be launched', async () => {
    bridge.openInEditor.mockRejectedValueOnce(new Error("'code' was not found on your PATH. Set the external editor in Settings."))
    show({ kind: 'file', section: 'u', file: file('src/a.ts', 'modified') })
    fireEvent.click(item('Open in External Editor'))
    expect(await screen.findByText(/was not found on your PATH/)).toBeTruthy()
    expect(closed).toBe(0)
  })

  it('appends an anchored entry to .gitignore', async () => {
    show({ kind: 'file', section: 'u', file: file('notes.txt', 'untracked') })
    fireEvent.click(item('Add to .gitignore'))
    await waitFor(() => expect(bridge.writeFile).toHaveBeenCalledWith('w1', '.gitignore', 'node_modules\n/notes.txt\n'))
  })
})

describe('ignore lines', () => {
  it('anchors files and marks folders', () => {
    expect(ignoreLine({ kind: 'file', section: 'u', file: file('a/b.txt', 'untracked') })).toBe('/a/b.txt')
    expect(ignoreLine({ kind: 'dir', section: 'u', path: 'tmp', files: [] })).toBe('/tmp/')
  })

  it('adds a line break when the file lacks one, keeps CRLF, and skips duplicates', () => {
    expect(appendIgnore('', '/x')).toBe('/x\n')
    expect(appendIgnore('a', '/x')).toBe('a\n/x\n')
    expect(appendIgnore('a\r\n', '/x')).toBe('a\r\n/x\r\n')
    expect(appendIgnore('/x\n', '/x')).toBe('/x\n')
  })
})
