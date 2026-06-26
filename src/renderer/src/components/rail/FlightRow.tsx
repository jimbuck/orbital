import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { Pencil, FolderX, Trash2 } from 'lucide-react'
import type { Flight } from '@shared/types'
import { useStore } from '@renderer/store'
import { StatusDot, flightStatusLabel, flightStatusTextClass } from '@renderer/lib/status'

type MenuPos = { x: number; y: number } | null
type DeleteMode = 'none' | 'confirm' | 'force'

/**
 * A single Flight entry inside an expanded workspace. Click selects it; the
 * leading dot + optional "needs you" label carry its status. Right-click opens a
 * context menu (rename inline, close keeping the worktree, or delete the worktree).
 */
export default function FlightRow({ flight }: { flight: Flight }): JSX.Element {
  const setActiveFlight = useStore((s) => s.setActiveFlight)
  const isActive = useStore((s) => s.activeFlightId === flight.id)
  const isDone = flight.status === 'done'
  const isWorktree = flight.kind === 'worktree'

  const [menu, setMenu] = useState<MenuPos>(null)
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
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 212), y: Math.min(e.clientY, window.innerHeight - 170) })
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
          <StatusDot status={flight.status} />
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
              <span className="flex items-center gap-[6px]">
                <span
                  className={`truncate text-[12.5px] ${isActive ? 'font-bold' : 'font-semibold'} ${
                    isActive ? 'text-text' : isDone ? 'text-text-3' : 'text-text-2'
                  }`}
                >
                  {flight.name}
                </span>
                {flight.kind === 'root' && (
                  <span className="flex-none rounded-[4px] border border-line-2 px-1 text-[9px] leading-[13px] text-faint">
                    root
                  </span>
                )}
              </span>
              <span className="mt-[2px] block truncate font-mono text-[10px] text-faint">{flight.branch}</span>
            </>
          )}
        </span>

        {!renaming && flight.status === 'needs_attention' && (
          <span
            className={`flex-none whitespace-nowrap text-[9.5px] font-bold ${flightStatusTextClass(flight.status)}`}
          >
            {flightStatusLabel(flight.status)}
          </span>
        )}
      </div>

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault()
              closeMenu()
            }}
          />
          <div
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            className="fixed z-50 w-[200px] rounded-[9px] border border-line-strong bg-elev p-1 shadow-[0_14px_36px_rgba(0,0,0,0.55)]"
          >
            {del === 'none' && (
              <>
                <MenuItem icon={<Pencil size={13} strokeWidth={1.5} />} label="Rename" onClick={startRename} />
                {isWorktree ? (
                  <>
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
                ) : (
                  <div className="px-2 py-1.5 text-[11px] leading-snug text-faint">
                    The root Flight can&apos;t be removed.
                  </div>
                )}
              </>
            )}

            {del === 'confirm' && (
              <div className="p-1">
                <div className="px-1 py-1 text-[11.5px] leading-snug text-text-3">
                  Remove this Flight and delete its worktree?
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void remove(true)}
                    className="flex-1 rounded-md bg-red/15 px-2 py-1.5 text-[11.5px] font-semibold text-red-2 outline-none hover:bg-red/25 focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={closeMenu}
                    className="flex-1 rounded-md bg-hover px-2 py-1.5 text-[11.5px] font-semibold text-text-2 outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {del === 'force' && (
              <div className="p-1">
                <div className="px-1 py-1 text-[11.5px] leading-snug text-red-2">
                  {error || 'The worktree has uncommitted changes.'}
                </div>
                <div className="px-1 pb-1 text-[11px] text-dim">Force-removing discards them.</div>
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void remove(true, true)}
                    className="flex-1 rounded-md bg-red/15 px-2 py-1.5 text-[11.5px] font-semibold text-red-2 outline-none hover:bg-red/25 focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    Force remove
                  </button>
                  <button
                    type="button"
                    onClick={closeMenu}
                    className="flex-1 rounded-md bg-hover px-2 py-1.5 text-[11.5px] font-semibold text-text-2 outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}

function MenuItem({
  icon,
  label,
  hint,
  danger,
  onClick
}: {
  icon: ReactNode
  label: string
  hint?: string
  danger?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] font-semibold outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60 ${
        danger ? 'text-red-2' : 'text-text-2'
      }`}
    >
      <span className={`flex-none ${danger ? 'text-red-2' : 'text-muted'}`}>{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[10px] font-normal text-faint">{hint}</span>}
    </button>
  )
}
