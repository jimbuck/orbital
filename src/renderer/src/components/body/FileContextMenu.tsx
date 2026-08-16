import { useState, type JSX } from 'react'
import {
  Clipboard,
  Copy,
  ExternalLink,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Minus,
  Pencil,
  Plus,
  Terminal,
  Trash2,
  Undo2
} from 'lucide-react'
import type { FileNode } from '@shared/types'
import { ContextMenu, MenuConfirm, MenuItem, MenuPrompt, type MenuPos } from '../rail/menu'

/**
 * What a completed operation did, handed back to the editor tab so it can
 * refresh the tree AND keep the open file honest — a renamed file has to be
 * followed to its new path, a deleted one has to stop being displayed as if it
 * were still there. The menu deliberately doesn't reach into the editor's
 * selection state itself; it reports, the owner reacts.
 */
export type FileMutation =
  | { kind: 'created'; path: string; type: 'file' | 'dir' }
  | { kind: 'renamed'; from: string; to: string }
  | { kind: 'deleted'; path: string }

/** Which in-menu step is showing; 'menu' is the item list. */
type Stage = 'menu' | 'newFile' | 'newFolder' | 'rename' | 'delete' | 'discard'

export const FILE_MENU_WIDTH = 216

/** Strip Electron's IPC-rejection wrapper so the menu shows the real message. */
function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim()
}

/** The directory a "New …" action creates into: the dir itself, or a file's parent. */
function parentDirOf(node: FileNode): string {
  if (node.type === 'dir') return node.path
  const slash = node.path.lastIndexOf('/')
  return slash === -1 ? '' : node.path.slice(0, slash)
}

/**
 * Right-click context menu for a row in the editor's file tree: the file
 * operations people expect from a tree (new file/folder, rename, delete to the
 * recycle bin, copy path, hand off to the OS) plus per-file git actions when
 * the row has changes.
 *
 * Everything happens inside the menu surface — names are typed into a
 * {@link MenuPrompt} and destructive actions confirm via {@link MenuConfirm} —
 * so a right-click never spawns a native dialog or a second modal to aim at.
 * Failures are shown in the menu instead of closing it: the common ones ("that
 * name is taken") are fixable right where they happened.
 *
 * The owning tree holds the open/position state and renders this when set.
 */
export default function FileContextMenu({
  worktreeId,
  node,
  pos,
  onClose,
  onMutated
}: {
  worktreeId: string
  node: FileNode
  pos: MenuPos
  onClose: () => void
  onMutated: (mutation: FileMutation) => void
}): JSX.Element {
  const [stage, setStage] = useState<Stage>('menu')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDir = node.type === 'dir'
  const parentDir = parentDirOf(node)
  const label = isDir ? 'folder' : 'file'

  /**
   * Run one bridge call with busy/error bookkeeping. On success the menu
   * closes; on failure it stays open with the message, so the user isn't left
   * guessing whether a silent no-op happened. Concurrent clicks are ignored
   * while one call is in flight.
   */
  const run = async (op: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await op()
      setBusy(false)
      onClose()
    } catch (err) {
      setBusy(false)
      setError(cleanError(err))
    }
  }

  /** Absolute path of this row — resolved in main, which also containment-checks it. */
  const absolute = (): Promise<string> => window.orbital.resolvePath(worktreeId, node.path)

  /** Leave a prompt/confirm step for the item list rather than closing outright. */
  const back = (): void => {
    if (busy) return
    setError(null)
    setStage('menu')
  }

  /** Enter a prompt/confirm step with any previous failure cleared. */
  const go = (next: Stage) => (): void => {
    setError(null)
    setStage(next)
  }

  const create = (type: 'file' | 'dir', name: string): void => {
    void run(async () => {
      const path =
        type === 'file'
          ? await window.orbital.createFile(worktreeId, parentDir, name)
          : await window.orbital.createDirectory(worktreeId, parentDir, name)
      onMutated({ kind: 'created', path, type })
    })
  }

  const rename = (name: string): void => {
    void run(async () => {
      const to = await window.orbital.renamePath(worktreeId, node.path, name)
      onMutated({ kind: 'renamed', from: node.path, to })
    })
  }

  const trash = (): void => {
    void run(async () => {
      await window.orbital.trashPath(worktreeId, node.path)
      onMutated({ kind: 'deleted', path: node.path })
    })
  }

  return (
    // Clicking away is ignored while an operation is in flight, so a slow
    // rename/delete can't be dismissed halfway and lose its error message.
    <ContextMenu
      pos={pos}
      width={FILE_MENU_WIDTH}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      {stage === 'newFile' || stage === 'newFolder' ? (
        <MenuPrompt
          label={stage === 'newFile' ? 'New file in ' + (parentDir || 'root') : 'New folder in ' + (parentDir || 'root')}
          placeholder={stage === 'newFile' ? 'name.ts' : 'folder'}
          confirmLabel="Create"
          busy={busy}
          error={error}
          onSubmit={(name) => create(stage === 'newFile' ? 'file' : 'dir', name)}
          onCancel={back}
        />
      ) : stage === 'rename' ? (
        <MenuPrompt
          label={`Rename ${label}`}
          initial={node.name}
          confirmLabel="Rename"
          busy={busy}
          error={error}
          onSubmit={rename}
          onCancel={back}
        />
      ) : stage === 'delete' ? (
        <MenuConfirm
          message={`Delete "${node.name}"?`}
          hint={`Moved to the recycle bin${isDir ? ', with everything inside it' : ''} — you can restore it from there.`}
          confirmLabel="Delete"
          busy={busy}
          busyLabel="Deleting…"
          onConfirm={trash}
          onCancel={back}
        />
      ) : stage === 'discard' ? (
        <MenuConfirm
          message={`Discard changes to "${node.name}"?`}
          hint={
            node.gitState === 'untracked'
              ? 'This file is untracked, so discarding deletes it outright.'
              : 'Unstaged changes are thrown away; anything already staged survives.'
          }
          confirmLabel="Discard"
          busy={busy}
          busyLabel="Discarding…"
          onConfirm={() => void run(() => window.orbital.gitDiscard(worktreeId, node.path))}
          onCancel={back}
        />
      ) : (
        <>
          {error && (
            <div className="allow-select mx-1 mb-1 rounded-md border border-red/25 bg-red/10 px-2 py-1.5 font-mono text-[10.5px] leading-snug break-words text-red-2">
              {error}
            </div>
          )}

          <MenuItem
            icon={<FilePlus size={13} strokeWidth={1.5} />}
            label="New File…"
            onClick={go('newFile')}
          />
          <MenuItem
            icon={<FolderPlus size={13} strokeWidth={1.5} />}
            label="New Folder…"
            onClick={go('newFolder')}
          />

          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={<Pencil size={13} strokeWidth={1.5} />}
            label="Rename…"
            onClick={go('rename')}
          />
          <MenuItem
            icon={<Copy size={13} strokeWidth={1.5} />}
            label="Copy Path"
            onClick={() => void run(async () => window.orbital.writeClipboard(await absolute()))}
          />
          <MenuItem
            icon={<Clipboard size={13} strokeWidth={1.5} />}
            label="Copy Relative Path"
            onClick={() => void run(async () => window.orbital.writeClipboard(node.path))}
          />

          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={<FolderOpen size={13} strokeWidth={1.5} />}
            label="Reveal in File Explorer"
            onClick={() => void run(async () => window.orbital.revealPath(await absolute()))}
          />
          <MenuItem
            icon={<ExternalLink size={13} strokeWidth={1.5} />}
            label={isDir ? 'Open Folder' : 'Open with Default App'}
            onClick={() => void run(async () => window.orbital.openPath(await absolute()))}
          />
          {isDir && (
            <MenuItem
              icon={<Terminal size={13} strokeWidth={1.5} />}
              label="Open in Terminal"
              onClick={() => void run(async () => window.orbital.openInTerminal(await absolute()))}
            />
          )}

          {/* Git actions only make sense for a row git has something to say about. */}
          {node.gitState && (
            <>
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<Plus size={13} strokeWidth={1.5} />}
                label="Stage"
                onClick={() => void run(() => window.orbital.gitStage(worktreeId, node.path))}
              />
              {/* The tree carries one state per file and prefers the working-tree
                  side, so it can't tell us whether this path is also staged —
                  both directions are offered rather than guessing wrong. */}
              {node.gitState !== 'untracked' && (
                <MenuItem
                  icon={<Minus size={13} strokeWidth={1.5} />}
                  label="Unstage"
                  onClick={() => void run(() => window.orbital.gitUnstage(worktreeId, node.path))}
                />
              )}
              <MenuItem
                icon={<Undo2 size={13} strokeWidth={1.5} />}
                label="Discard Changes…"
                danger
                onClick={go('discard')}
              />
            </>
          )}

          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={<Trash2 size={13} strokeWidth={1.5} />}
            label="Delete"
            hint="to recycle bin"
            danger
            onClick={go('delete')}
          />
        </>
      )}
    </ContextMenu>
  )
}
