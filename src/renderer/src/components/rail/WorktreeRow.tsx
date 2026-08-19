import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Pencil, CircleOff, FolderOpen, Terminal, FolderX, Trash2 } from 'lucide-react'
import type { Worktree } from '@shared/types'
import { useStore } from '@renderer/store'
import { StatusDot, worktreeStatusLabel, worktreeStatusTextClass } from '@renderer/lib/status'
import { ContextMenu, MenuItem, MenuConfirm, clampMenuPos, type MenuPos } from './menu'

type DeleteMode = 'none' | 'confirm' | 'force'

/**
 * A single linked Worktree entry inside an expanded project (the root Worktree
 * is the project header itself). Click selects it; the leading dot + optional
 * "needs you" label carry its status. Right-click opens a context menu (rename
 * inline, force-clear a stuck status, close keeping the worktree, or delete the
 * worktree).
 */
export default function WorktreeRow({ worktree }: { worktree: Worktree }): JSX.Element {
  const setActiveWorktree = useStore((s) => s.setActiveWorktree)
  const isActive = useStore((s) => s.activeWorktreeId === worktree.id)
  const settingUp = useStore((s) => s.settingUpWorktrees.includes(worktree.id))
  const isDone = worktree.status === 'done'

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(worktree.name)
  const [del, setDel] = useState<DeleteMode>('none')
  const [error, setError] = useState<string | null>(null)
  // Set while a remove is in flight — `git worktree remove` takes a few seconds,
  // so the row shows a spinner and the confirm button locks.
  const [removing, setRemoving] = useState<'closing' | 'deleting' | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const closeMenu = (): void => {
    // Keep the menu up while a remove runs, so its result (or the force step) lands somewhere.
    if (removing) return
    setMenu(null)
    setDel('none')
    setError(null)
  }

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDel('none')
    setError(null)
    setMenu(clampMenuPos(e, 200, 200))
  }

  const startRename = (): void => {
    setDraft(worktree.name)
    setRenaming(true)
    closeMenu()
  }
  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (name && name !== worktree.name) void window.orbital.renameWorktree(worktree.id, name)
  }
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setRenaming(false)
    }
  }

  // Force-reset an out-of-sync status (e.g. a spinner wedged by a lost hook event).
  const clearStatus = (): void => {
    void window.orbital.clearWorktreeStatus(worktree.id)
    closeMenu()
  }

  const remove = async (removeWorktree: boolean, force = false): Promise<void> => {
    if (removing) return
    setRemoving(removeWorktree ? 'deleting' : 'closing')
    try {
      await window.orbital.removeWorktree(worktree.id, { removeWorktree, force })
      setRemoving(null)
      setMenu(null)
      setDel('none')
      setError(null)
    } catch (e) {
      // git refuses a dirty worktree without --force; offer a force step.
      setRemoving(null)
      setError(e instanceof Error ? e.message : 'Failed to remove the Worktree.')
      setDel('force')
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => !renaming && setActiveWorktree(worktree.id)}
        onKeyDown={(e) => {
          if (!renaming && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            setActiveWorktree(worktree.id)
          }
        }}
        onContextMenu={openMenu}
        className={`flex w-full cursor-pointer items-center gap-[9px] rounded-[7px] px-[9px] py-[7px] text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          isActive ? 'bg-panel-2' : 'hover:bg-hover'
        } ${isDone ? 'opacity-60' : ''}`}
      >
        <span className="flex w-[11px] flex-none items-center justify-center">
          {settingUp || removing ? (
            <span className="inline-block size-[11px] rounded-full border-[1.6px] border-accent border-t-transparent animate-spin" />
          ) : (
            <StatusDot status={worktree.status} />
          )}
        </span>

        <span className="min-w-0 flex-1">
          {renaming ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              className="allow-select w-full rounded border border-accent/60 bg-bg px-1 py-0.5 text-[12.5px] font-semibold text-text outline-none"
            />
          ) : (
            <>
              <span
                className={`block truncate text-[12.5px] ${isActive ? 'font-bold' : 'font-semibold'} ${
                  isActive ? 'text-text' : isDone ? 'text-text-3' : 'text-text-2'
                }`}
              >
                {worktree.name}
              </span>
              <span className="mt-[2px] block truncate font-mono text-[10px] text-faint">{worktree.branch}</span>
            </>
          )}
        </span>

        {!renaming && removing ? (
          <span
            className="flex-none whitespace-nowrap text-[9.5px] font-semibold text-red-2"
            title={removing === 'deleting' ? 'Removing the worktree from disk…' : 'Closing the worktree…'}
          >
            {removing === 'deleting' ? 'deleting…' : 'closing…'}
          </span>
        ) : !renaming && settingUp ? (
          <span
            className="flex-none whitespace-nowrap text-[9.5px] font-semibold text-blue"
            title="Copying dependencies (node_modules) into the new worktree…"
          >
            setting up…
          </span>
        ) : (
          !renaming &&
          worktree.status === 'needs_attention' && (
            <span
              className={`flex-none whitespace-nowrap text-[9.5px] font-bold ${worktreeStatusTextClass(worktree.status)}`}
            >
              {worktreeStatusLabel(worktree.status)}
            </span>
          )
        )}
      </div>

      {menu && (
        <ContextMenu pos={menu} width={200} onClose={closeMenu}>
          {/* The Close path runs without a confirm step, so it gets its own busy line. */}
          {del === 'none' && removing && (
            <div className="flex items-center gap-2 px-2 py-2 text-[11.5px] font-semibold text-text-3">
              <span className="inline-block size-[11px] flex-none animate-spin rounded-full border-[1.6px] border-accent border-t-transparent" />
              Closing worktree…
            </div>
          )}

          {del === 'none' && !removing && (
            <>
              <MenuItem icon={<Pencil size={13} strokeWidth={1.5} />} label="Rename" onClick={startRename} />
              <MenuItem
                icon={<CircleOff size={13} strokeWidth={1.5} />}
                label="Clear Status"
                onClick={clearStatus}
              />
              {/* `''` is the Worktree root: main turns the id into the checkout
                  path itself, so the renderer never names a path to the OS. */}
              <MenuItem
                icon={<FolderOpen size={13} strokeWidth={1.5} />}
                label="Open in Explorer"
                onClick={() => {
                  void window.orbital.openPath(worktree.id, '')
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<Terminal size={13} strokeWidth={1.5} />}
                label="Open in External Terminal"
                onClick={() => {
                  void window.orbital.openInTerminal(worktree.id, '')
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<FolderX size={13} strokeWidth={1.5} />}
                label="Close Worktree"
                hint="keep worktree"
                onClick={() => void remove(false)}
              />
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<Trash2 size={13} strokeWidth={1.5} />}
                label="Delete worktree"
                danger
                onClick={() => setDel('confirm')}
              />
            </>
          )}

          {del === 'confirm' && (
            <MenuConfirm
              message="Remove this Worktree and delete it?"
              confirmLabel="Delete"
              danger={false}
              busy={removing !== null}
              busyLabel="Deleting…"
              onConfirm={() => void remove(true)}
              onCancel={closeMenu}
            />
          )}

          {del === 'force' && (
            <MenuConfirm
              message={error || 'The worktree has uncommitted changes.'}
              hint="Force-removing discards them."
              confirmLabel="Force remove"
              busy={removing !== null}
              busyLabel="Removing…"
              onConfirm={() => void remove(true, true)}
              onCancel={closeMenu}
            />
          )}
        </ContextMenu>
      )}
    </>
  )
}
