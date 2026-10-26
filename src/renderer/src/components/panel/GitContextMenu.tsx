import { useState, type JSX } from 'react'
import {
  Clipboard,
  Code2,
  Copy,
  ExternalLink,
  EyeOff,
  FileDiff,
  FileText,
  FolderOpen,
  Minus,
  Plus,
  Terminal,
  Undo2
} from 'lucide-react'
import type { GitFileStatus } from '@shared/types'
import { ContextMenu, MenuConfirm, MenuItem, type MenuPos } from '../rail/menu'
import { cleanError } from '../body/FileContextMenu'
import { fileManagerName } from '@renderer/lib/platform'

export const GIT_MENU_WIDTH = 224

/**
 * What was right-clicked: one changed file, or a folder of them. `section` is
 * the list the row sits in — staged rows unstage, unstaged rows stage and
 * discard — and a folder carries every changed file under it in that list.
 */
export type GitMenuTarget =
  | { kind: 'file'; section: 's' | 'u'; file: GitFileStatus }
  | { kind: 'dir'; section: 's' | 'u'; path: string; files: GitFileStatus[] }

/** The git operations the panel runs itself, so its busy spinner and error banner cover them. */
export interface GitMenuActions {
  openDiff: (file: GitFileStatus) => void
  openFile: (path: string) => void
  stage: (paths: string[]) => void
  unstage: (paths: string[]) => void
  discard: (paths: string[]) => void
}

/** The `.gitignore` line that ignores exactly this entry: anchored at the root, `/` on a folder. */
export function ignoreLine(target: GitMenuTarget): string {
  return target.kind === 'file' ? `/${target.file.path}` : `/${target.path}/`
}

/** `content` with `line` appended on a line of its own (no-op when it is already there). */
export function appendIgnore(content: string, line: string): string {
  if (content.split(/\r?\n/).some((l) => l.trim() === line)) return content
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const sep = content === '' || content.endsWith('\n') ? '' : eol
  return `${content}${sep}${line}${eol}`
}

/**
 * Right-click menu for a row in the git panel's changed-file trees: open the
 * diff or the file, hand it to an external editor or the OS, the row's git
 * actions (the same ones its hover buttons offer, folder-wide on a folder),
 * ignoring an untracked entry, and copying its path.
 *
 * Git actions go back through the panel (see {@link GitMenuActions}) and close
 * the menu straight away — their progress and failures belong to the panel's
 * spinner and banner, like the hover buttons'. The OS hand-offs run here and
 * keep the menu open on failure with the reason, as the editor tree's menu does
 * ("'code' was not found on your PATH" is fixable, but only if it is seen).
 */
export default function GitContextMenu({
  worktreeId,
  target,
  pos,
  busy,
  actions,
  onClose
}: {
  worktreeId: string
  target: GitMenuTarget
  pos: MenuPos
  /** A git operation is in flight in the panel; its actions are disabled until it lands. */
  busy: boolean
  actions: GitMenuActions
  onClose: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isFile = target.kind === 'file'
  const path = isFile ? target.file.path : target.path
  const files = isFile ? [target.file] : target.files
  const paths = files.map((f) => f.path)
  const name = path.split('/').pop() || path
  const staged = target.section === 's'
  const allUntracked = files.every((f) => f.state === 'untracked')
  // A deleted file has nothing on disk to open or reveal.
  const gone = isFile && target.file.state === 'deleted'

  /** Run a hand-off; close on success, stay open with the reason on failure. */
  const run = async (op: () => Promise<unknown>): Promise<void> => {
    if (running) return
    setRunning(true)
    setError(null)
    try {
      await op()
      onClose()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setRunning(false)
    }
  }

  /** Close first, then hand the git op to the panel. */
  const git = (fn: (paths: string[]) => void) => (): void => {
    onClose()
    fn(paths)
  }

  const addToGitignore = (): Promise<void> =>
    run(async () => {
      const current = await window.orbital.readFile(worktreeId, '.gitignore').catch(() => '')
      const next = appendIgnore(current, ignoreLine(target))
      if (next !== current) await window.orbital.writeFile(worktreeId, '.gitignore', next)
    })

  if (confirming) {
    return (
      <ContextMenu pos={pos} width={GIT_MENU_WIDTH} onClose={onClose}>
        <MenuConfirm
          message={isFile ? `Discard changes to "${name}"?` : `Discard changes in "${name}"?`}
          hint={
            allUntracked
              ? `${isFile ? 'This file is' : 'These files are'} untracked, so discarding deletes ${isFile ? 'it' : 'them'} outright.`
              : isFile
                ? 'Unstaged changes are thrown away; anything already staged survives.'
                : `Unstaged changes to ${files.length} file${files.length === 1 ? '' : 's'} are thrown away, and untracked ones deleted.`
          }
          confirmLabel="Discard"
          onConfirm={git(actions.discard)}
          onCancel={() => setConfirming(false)}
        />
      </ContextMenu>
    )
  }

  return (
    <ContextMenu pos={pos} width={GIT_MENU_WIDTH} onClose={onClose}>
      {error && (
        <div className="allow-select mx-1 mb-1 rounded-md border border-red/25 bg-red/10 px-2 py-1.5 font-mono text-[10.5px] leading-snug break-words text-red-2">
          {error}
        </div>
      )}

      {isFile && (
        <>
          <MenuItem
            icon={<FileDiff size={13} strokeWidth={1.5} />}
            label="Open Diff"
            onClick={() => {
              onClose()
              actions.openDiff(target.file)
            }}
          />
          <MenuItem
            icon={<FileText size={13} strokeWidth={1.5} />}
            label="Open File"
            disabled={gone}
            onClick={() => {
              onClose()
              actions.openFile(path)
            }}
          />
        </>
      )}
      <MenuItem
        icon={<Code2 size={13} strokeWidth={1.5} />}
        label="Open in External Editor"
        disabled={gone}
        onClick={() => void run(() => window.orbital.openInEditor(worktreeId, path))}
      />
      {isFile ? (
        <MenuItem
          icon={<ExternalLink size={13} strokeWidth={1.5} />}
          label="Open with Default App"
          disabled={gone}
          onClick={() => void run(() => window.orbital.openPath(worktreeId, path))}
        />
      ) : (
        <MenuItem
          icon={<Terminal size={13} strokeWidth={1.5} />}
          label="Open in Terminal"
          onClick={() => void run(() => window.orbital.openInTerminal(worktreeId, path))}
        />
      )}
      <MenuItem
        icon={<FolderOpen size={13} strokeWidth={1.5} />}
        label={`Reveal in ${fileManagerName}`}
        disabled={gone}
        onClick={() => void run(() => window.orbital.revealPath(worktreeId, path))}
      />

      <div className="my-1 h-px bg-soft" />
      {staged ? (
        <MenuItem
          icon={<Minus size={13} strokeWidth={1.5} />}
          label={isFile ? 'Unstage' : 'Unstage Folder'}
          disabled={busy}
          onClick={git(actions.unstage)}
        />
      ) : (
        <>
          <MenuItem
            icon={<Plus size={13} strokeWidth={1.5} />}
            label={isFile ? 'Stage' : 'Stage Folder'}
            disabled={busy}
            onClick={git(actions.stage)}
          />
          <MenuItem
            icon={<Undo2 size={13} strokeWidth={1.5} />}
            label={allUntracked && isFile ? 'Delete File…' : 'Discard Changes…'}
            danger
            disabled={busy}
            onClick={() => setConfirming(true)}
          />
          {allUntracked && (
            <MenuItem
              icon={<EyeOff size={13} strokeWidth={1.5} />}
              label="Add to .gitignore"
              onClick={() => void addToGitignore()}
            />
          )}
        </>
      )}

      <div className="my-1 h-px bg-soft" />
      <MenuItem
        icon={<Copy size={13} strokeWidth={1.5} />}
        label="Copy Path"
        onClick={() =>
          void run(async () => window.orbital.writeClipboard(await window.orbital.resolvePath(worktreeId, path)))
        }
      />
      <MenuItem
        icon={<Clipboard size={13} strokeWidth={1.5} />}
        label="Copy Relative Path"
        onClick={() => void run(async () => window.orbital.writeClipboard(path))}
      />
    </ContextMenu>
  )
}
