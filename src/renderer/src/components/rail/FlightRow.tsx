import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Pencil, CircleOff, FolderOpen, Terminal, FolderX, Trash2 } from 'lucide-react'
import type { Flight } from '@shared/types'
import { useStore } from '@renderer/store'
import { StatusDot, flightStatusLabel, flightStatusTextClass } from '@renderer/lib/status'
import { ContextMenu, MenuItem, MenuConfirm, clampMenuPos, type MenuPos } from './menu'

type DeleteMode = 'none' | 'confirm' | 'force'

/**
 * A single worktree Flight entry inside an expanded workspace (the root Flight
 * is the workspace header itself). Click selects it; the leading dot + optional
 * "needs you" label carry its status. Right-click opens a context menu (rename
 * inline, force-clear a stuck status, close keeping the worktree, or delete the
 * worktree).
 */
export default function FlightRow({ flight }: { flight: Flight }): JSX.Element {
  const setActiveFlight = useStore((s) => s.setActiveFlight)
  const isActive = useStore((s) => s.activeFlightId === flight.id)
  const settingUp = useStore((s) => s.settingUpFlights.includes(flight.id))
  const isDone = flight.status === 'done'

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(flight.name)
  const [del, setDel] = useState<DeleteMode>('none')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const closeMenu = (): void => {
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
    setDraft(flight.name)
    setRenaming(true)
    closeMenu()
  }
  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (name && name !== flight.name) void window.orbital.renameFlight(flight.id, name)
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
    void window.orbital.clearFlightStatus(flight.id)
    closeMenu()
  }

  const remove = async (removeWorktree: boolean, force = false): Promise<void> => {
    try {
      await window.orbital.removeFlight(flight.id, { removeWorktree, force })
      closeMenu()
    } catch (e) {
      // git refuses a dirty worktree without --force; offer a force step.
      setError(e instanceof Error ? e.message : 'Failed to remove the Flight.')
      setDel('force')
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => !renaming && setActiveFlight(flight.id)}
        onKeyDown={(e) => {
          if (!renaming && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            setActiveFlight(flight.id)
          }
        }}
        onContextMenu={openMenu}
        className={`flex w-full cursor-pointer items-center gap-[9px] rounded-[7px] px-[9px] py-[7px] text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          isActive ? 'bg-panel-2' : 'hover:bg-hover'
        } ${isDone ? 'opacity-60' : ''}`}
      >
        <span className="flex w-[11px] flex-none items-center justify-center">
          {settingUp ? (
            <span className="inline-block size-[11px] rounded-full border-[1.6px] border-accent border-t-transparent animate-spin" />
          ) : (
            <StatusDot status={flight.status} />
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
                {flight.name}
              </span>
              <span className="mt-[2px] block truncate font-mono text-[10px] text-faint">{flight.branch}</span>
            </>
          )}
        </span>

        {!renaming && settingUp ? (
          <span
            className="flex-none whitespace-nowrap text-[9.5px] font-semibold text-blue"
            title="Copying dependencies (node_modules) into the new worktree…"
          >
            setting up…
          </span>
        ) : (
          !renaming &&
          flight.status === 'needs_attention' && (
            <span
              className={`flex-none whitespace-nowrap text-[9.5px] font-bold ${flightStatusTextClass(flight.status)}`}
            >
              {flightStatusLabel(flight.status)}
            </span>
          )
        )}
      </div>

      {menu && (
        <ContextMenu pos={menu} width={200} onClose={closeMenu}>
          {del === 'none' && (
            <>
              <MenuItem icon={<Pencil size={13} strokeWidth={1.5} />} label="Rename" onClick={startRename} />
              <MenuItem
                icon={<CircleOff size={13} strokeWidth={1.5} />}
                label="Clear Status"
                onClick={clearStatus}
              />
              <MenuItem
                icon={<FolderOpen size={13} strokeWidth={1.5} />}
                label="Open in Explorer"
                onClick={() => {
                  void window.orbital.openPath(flight.worktreePath)
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<Terminal size={13} strokeWidth={1.5} />}
                label="Open in External Terminal"
                onClick={() => {
                  void window.orbital.openInTerminal(flight.worktreePath)
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<FolderX size={13} strokeWidth={1.5} />}
                label="Close Flight"
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
              message="Remove this Flight and delete its worktree?"
              confirmLabel="Delete"
              danger={false}
              onConfirm={() => void remove(true)}
              onCancel={closeMenu}
            />
          )}

          {del === 'force' && (
            <MenuConfirm
              message={error || 'The worktree has uncommitted changes.'}
              hint="Force-removing discards them."
              confirmLabel="Force remove"
              onConfirm={() => void remove(true, true)}
              onCancel={closeMenu}
            />
          )}
        </ContextMenu>
      )}
    </>
  )
}
