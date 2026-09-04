import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FileNode } from '@shared/types'

import FileContextMenu, { cleanError, type FileMutation } from './FileContextMenu'

/**
 * The window.orbital bridge, restubbed per test so call assertions are clean.
 * Only the methods this menu reaches for are present — anything else it starts
 * calling should fail loudly rather than silently no-op.
 */
let bridge: Record<string, ReturnType<typeof vi.fn>>
let mutations: FileMutation[]
let closed: number

beforeEach(() => {
  mutations = []
  closed = 0
  bridge = {
    createFile: vi.fn(async (_w: string, parent: string, name: string) => `${parent}/${name}`),
    createDirectory: vi.fn(async (_w: string, parent: string, name: string) => `${parent}/${name}`),
    renamePath: vi.fn(async () => 'src/renamed.ts'),
    trashPath: vi.fn(async () => undefined),
    resolvePath: vi.fn(async () => 'C:\\repo\\src\\a.ts'),
    revealPath: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    writeClipboard: vi.fn(),
    gitStage: vi.fn(async () => undefined),
    gitUnstage: vi.fn(async () => undefined),
    gitDiscard: vi.fn(async () => undefined)
  }
  vi.stubGlobal('orbital', bridge)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function show(node: FileNode): void {
  render(
    <FileContextMenu
      worktreeId="w1"
      node={node}
      pos={{ x: 10, y: 10 }}
      onClose={() => {
        closed++
      }}
      onMutated={(m) => mutations.push(m)}
    />
  )
}

const file: FileNode = { name: 'a.ts', path: 'src/a.ts', type: 'file' }
const dir: FileNode = { name: 'src', path: 'src', type: 'dir' }
const changed: FileNode = { name: 'a.ts', path: 'src/a.ts', type: 'file', gitState: 'modified' }

describe('menu items per row kind', () => {
  it('offers the file operations for a plain file, and no terminal or git block', () => {
    show(file)
    for (const label of [
      'New File…',
      'New Folder…',
      'Rename…',
      'Copy Path',
      'Copy Relative Path',
      'Reveal in File Explorer',
      'Open with Default App',
      'Delete'
    ]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    // A terminal opens at a directory, and an unchanged file has nothing to stage.
    expect(screen.queryByText('Open in Terminal')).toBeNull()
    expect(screen.queryByText('Stage')).toBeNull()
    expect(screen.queryByText('Discard Changes…')).toBeNull()
  })

  it('offers Open in Terminal for a directory', () => {
    show(dir)
    expect(screen.getByText('Open in Terminal')).toBeTruthy()
    expect(screen.getByText('Open Folder')).toBeTruthy()
  })

  it('adds the git actions only when the row has changes', () => {
    show(changed)
    expect(screen.getByText('Stage')).toBeTruthy()
    expect(screen.getByText('Unstage')).toBeTruthy()
    expect(screen.getByText('Discard Changes…')).toBeTruthy()
  })

  it('hides Unstage for an untracked file, which was never in the index', () => {
    show({ ...file, gitState: 'untracked' })
    expect(screen.getByText('Stage')).toBeTruthy()
    expect(screen.queryByText('Unstage')).toBeNull()
  })
})

describe('delete', () => {
  it('requires a confirm step before anything is binned', () => {
    show(file)
    fireEvent.click(screen.getByText('Delete'))

    expect(bridge.trashPath).not.toHaveBeenCalled()
    expect(screen.getByText('Delete "a.ts"?')).toBeTruthy()
    // The copy has to say where the file goes — that's what makes it recoverable.
    expect(screen.getByText(/recycle bin/)).toBeTruthy()
  })

  it('bins the file through the bridge once confirmed, and reports the deletion', async () => {
    show(file)
    fireEvent.click(screen.getByText('Delete')) // menu item -> confirm step
    fireEvent.click(screen.getByText('Delete')) // confirm button

    await waitFor(() => expect(bridge.trashPath).toHaveBeenCalledWith('w1', 'src/a.ts'))
    await waitFor(() => expect(mutations).toEqual([{ kind: 'deleted', path: 'src/a.ts' }]))
    expect(closed).toBe(1)
  })

  it('keeps the confirm open and shows why when the bin fails', async () => {
    // The failure that must never be silent. `shell.trashItem` rejects for
    // entirely ordinary reasons on Windows — the file is locked by another
    // process, it was deleted externally since the menu opened, a directory
    // holds a locked child, permission is denied — and before this the panel
    // simply sat there unchanged, leaving "did that work?" unanswerable for the
    // app's only destructive file action.
    bridge.trashPath.mockRejectedValueOnce(
      new Error(`Error invoking remote method 'orbital:trashPath': Error: Failed to parse path`)
    )
    show(file)
    fireEvent.click(screen.getByText('Delete')) // menu item -> confirm step
    fireEvent.click(screen.getByText('Delete')) // confirm button

    await waitFor(() => expect(screen.getByText('Failed to parse path')).toBeTruthy())
    // Still on the confirm, still open, and nothing reported as deleted — the
    // file is genuinely still on disk.
    expect(screen.getByText('Delete "a.ts"?')).toBeTruthy()
    expect(mutations).toEqual([])
    expect(closed).toBe(0)
    // Both buttons are usable again, so the user can retry or back out.
    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('returns to the item list when the confirm is cancelled', () => {
    show(file)
    fireEvent.click(screen.getByText('Delete'))
    fireEvent.click(screen.getByText('Cancel'))

    expect(bridge.trashPath).not.toHaveBeenCalled()
    // Backing out of a confirm shouldn't cost the whole menu.
    expect(screen.getByText('New File…')).toBeTruthy()
    expect(closed).toBe(0)
  })
})

describe('new file prompt', () => {
  it('creates inside the right-clicked directory', async () => {
    show(dir)
    fireEvent.click(screen.getByText('New File…'))

    fireEvent.change(screen.getByLabelText('New file in src'), { target: { value: 'b.ts' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => expect(bridge.createFile).toHaveBeenCalledWith('w1', 'src', 'b.ts'))
    await waitFor(() => expect(mutations).toEqual([{ kind: 'created', path: 'src/b.ts', type: 'file' }]))
  })

  it("creates alongside a right-clicked file, in that file's directory", async () => {
    show(file)
    fireEvent.click(screen.getByText('New Folder…'))
    fireEvent.change(screen.getByLabelText('New folder in src'), { target: { value: 'sub' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => expect(bridge.createDirectory).toHaveBeenCalledWith('w1', 'src', 'sub'))
  })

  it('keeps the prompt open and shows why when the bridge rejects', async () => {
    bridge.createFile.mockRejectedValueOnce(
      new Error(`Error invoking remote method 'orbital:createFile': Error: "src/b.ts" already exists`)
    )
    show(dir)
    fireEvent.click(screen.getByText('New File…'))
    fireEvent.change(screen.getByLabelText('New file in src'), { target: { value: 'b.ts' } })
    fireEvent.click(screen.getByText('Create'))

    // The IPC wrapper is stripped, the field survives for a second attempt, and
    // the menu did not close out from under the error.
    await waitFor(() => expect(screen.getByText('"src/b.ts" already exists')).toBeTruthy())
    expect(screen.getByLabelText('New file in src')).toBeTruthy()
    expect(closed).toBe(0)
  })
})

describe('OS and git hand-offs', () => {
  it('copies the absolute path resolved by main', async () => {
    show(file)
    fireEvent.click(screen.getByText('Copy Path'))
    await waitFor(() => expect(bridge.writeClipboard).toHaveBeenCalledWith('C:\\repo\\src\\a.ts'))
    expect(bridge.resolvePath).toHaveBeenCalledWith('w1', 'src/a.ts')
  })

  it('copies the relative path without a round trip', async () => {
    show(file)
    fireEvent.click(screen.getByText('Copy Relative Path'))
    await waitFor(() => expect(bridge.writeClipboard).toHaveBeenCalledWith('src/a.ts'))
  })

  it('reveals via showItemInFolder, not openPath', async () => {
    show(file)
    fireEvent.click(screen.getByText('Reveal in File Explorer'))
    await waitFor(() => expect(bridge.revealPath).toHaveBeenCalledWith('w1', 'src/a.ts'))
    expect(bridge.openPath).not.toHaveBeenCalled()
  })

  /*
   * The OS hand-offs send the Worktree id and the RELATIVE path so main does
   * the resolving. Sending the absolute path `resolvePath` returns would mean
   * main accepting an absolute path from the renderer — which is exactly the
   * hole these three used to be.
   */
  it('hands the OS a worktree id and a relative path, never an absolute one', async () => {
    show(dir)
    fireEvent.click(screen.getByText('Open Folder'))
    await waitFor(() => expect(bridge.openPath).toHaveBeenCalledWith('w1', 'src'))
    cleanup()

    show(dir)
    fireEvent.click(screen.getByText('Open in Terminal'))
    await waitFor(() => expect(bridge.openInTerminal).toHaveBeenCalledWith('w1', 'src'))

    // Copy Path is the only item left that wants an absolute string, and it is
    // the only caller that still asks main to resolve one.
    expect(bridge.resolvePath).not.toHaveBeenCalled()
  })

  it('shows a rejected path in the menu instead of closing it', async () => {
    // Main rejects anything escaping the checkout; the message has to land
    // where the user can read it, not vanish with the menu.
    bridge.openPath = vi.fn(async () => {
      throw new Error(
        'Error invoking remote method \'orbital:openPath\': Error: "../x" escapes the Worktree'
      )
    })
    show(dir)
    fireEvent.click(screen.getByText('Open Folder'))
    await waitFor(() => expect(screen.getByText('"../x" escapes the Worktree')).toBeTruthy())
    expect(closed).toBe(0)
  })

  it('stages the file directly, with no confirm step', async () => {
    show(changed)
    fireEvent.click(screen.getByText('Stage'))
    await waitFor(() => expect(bridge.gitStage).toHaveBeenCalledWith('w1', 'src/a.ts'))
  })

  it('confirms before discarding changes', async () => {
    show(changed)
    fireEvent.click(screen.getByText('Discard Changes…'))
    expect(bridge.gitDiscard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Discard'))
    await waitFor(() => expect(bridge.gitDiscard).toHaveBeenCalledWith('w1', 'src/a.ts'))
  })

  it('shows why a discard failed rather than appearing to have worked', async () => {
    bridge.gitDiscard.mockRejectedValueOnce(new Error('index.lock exists'))
    show(changed)
    fireEvent.click(screen.getByText('Discard Changes…'))
    fireEvent.click(screen.getByText('Discard'))

    await waitFor(() => expect(screen.getByText('index.lock exists')).toBeTruthy())
    expect(closed).toBe(0)
  })
})

describe('rename prompt', () => {
  it('seeds the field with the row name so Rename is a type-over', () => {
    show(file)
    fireEvent.click(screen.getByText('Rename…'))
    const input = screen.getByRole('textbox', { name: 'Rename file' }) as HTMLInputElement
    expect(input.value).toBe('a.ts')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4])
  })

  it('renames through the bridge and reports where the file went', async () => {
    show(file)
    fireEvent.click(screen.getByText('Rename…'))
    const input = screen.getByRole('textbox', { name: 'Rename file' })
    fireEvent.change(input, { target: { value: 'renamed.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(closed).toBe(1))
    expect(bridge.renamePath).toHaveBeenCalledWith('w1', 'src/a.ts', 'renamed.ts')
    expect(mutations).toEqual([{ kind: 'renamed', from: 'src/a.ts', to: 'src/renamed.ts' }])
  })
})

describe('in-flight lock', () => {
  it('fires a slow delete once however many times the confirm is clicked', async () => {
    let finish: () => void = () => {}
    bridge.trashPath.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    show(file)
    fireEvent.click(screen.getByText('Delete'))
    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    // Locked while the bin call is in flight: the button is disabled and the
    // menu ignores its dismiss overlay too, so the error (if any) has somewhere
    // to land.
    expect(bridge.trashPath).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Deleting…' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(closed).toBe(0)

    finish()
    await waitFor(() => expect(closed).toBe(1))
    expect(mutations).toEqual([{ kind: 'deleted', path: 'src/a.ts' }])
  })
})

describe('delete confirm copy', () => {
  function showWithUnsaved(node: FileNode, unsavedPath: string): void {
    render(
      <FileContextMenu
        worktreeId="w1"
        node={node}
        pos={{ x: 10, y: 10 }}
        unsavedPath={unsavedPath}
        onClose={() => {}}
        onMutated={() => {}}
      />
    )
    fireEvent.click(screen.getByText('Delete'))
  }

  it('says nothing about edits when the open file is not involved', () => {
    showWithUnsaved(file, 'src/other.ts')
    expect(screen.queryByText(/unsaved edits/)).toBeNull()
  })

  it('warns that binning the open file loses its unsaved edits', () => {
    showWithUnsaved(file, 'src/a.ts')
    expect(screen.getByText(/Your unsaved edits will be lost/)).toBeTruthy()
  })

  it('names the unsaved file when a folder containing it is binned', () => {
    showWithUnsaved(dir, 'src/deep/a.ts')
    expect(screen.getByText(/unsaved edits to "a.ts" will be lost/)).toBeTruthy()
  })
})

describe('cleanError', () => {
  it('strips the Electron IPC wrapper', () => {
    expect(cleanError(new Error(`Error invoking remote method 'orbital:x': Error: "b.ts" already exists`))).toBe(
      '"b.ts" already exists'
    )
  })

  it('reduces a Node errno to its reason, dropping the code, syscall and paths', () => {
    // Raw fs errors carry one or two absolute paths, which is most of what a
    // 216px-wide menu would then be showing.
    expect(
      cleanError(
        new Error(
          `Error invoking remote method 'orbital:renamePath': Error: EPERM: operation not permitted, rename 'C:\\Users\\me\\repo\\src\\a.ts' -> 'C:\\Users\\me\\repo\\src\\b.ts'`
        )
      )
    ).toBe('Operation not permitted')
    expect(cleanError(new Error(`EBUSY: resource busy or locked, unlink 'C:\\repo\\a.ts'`))).toBe(
      'Resource busy or locked'
    )
    expect(cleanError(new Error('ENOENT: no such file or directory'))).toBe('No such file or directory')
  })

  it('leaves messages the app wrote itself alone', () => {
    expect(cleanError(new Error('"../x" escapes the Worktree'))).toBe('"../x" escapes the Worktree')
    expect(cleanError('plain string')).toBe('plain string')
  })
})
