import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, CircleOff, FolderOpen, Pencil, Plus, Terminal, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStatus, type Project as ProjectModel } from '@shared/types'
import { useStore } from '@renderer/store'
import { StatusDot } from '@renderer/lib/status'
import WorktreeRow from './WorktreeRow'
import { ContextMenu, MenuItem, MenuConfirm, clampMenuPos, type MenuPos } from './menu'
import { fireAndForget } from '@renderer/lib/bridge'

/**
 * A project (repo) header in the rail. The header row IS the root Worktree:
 * clicking it selects the project's root Worktree directly. Linked Worktrees
 * live in the collapsible list below — the chevron only renders when there
 * are any. Right-click opens a context menu to rename the project inline,
 * start a new Worktree, clear a stuck root status, open the repo in Explorer or
 * an external terminal, or remove the project.
 */
export default function Project({ project }: { project: ProjectModel }): JSX.Element {
  const worktrees = useStore(useShallow((s) => s.worktrees.filter((w) => w.projectId === project.id)))
  const expanded = useStore((s) => !!s.expanded[project.id])
  const isActive = useStore((s) => s.activeProjectId === project.id)
  const activeWorktreeId = useStore((s) => s.activeWorktreeId)
  const setActiveProject = useStore((s) => s.setActiveProject)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const openModal = useStore((s) => s.openModal)
  const root = worktrees.find((w) => w.kind === 'root')
  const linked = worktrees.filter((w) => w.kind !== 'root')
  const rootActive = !!root && activeWorktreeId === root.id
  const status = aggregateStatus(worktrees.map((w) => w.status))
  const needsAttention = worktrees.filter((w) => w.status === 'needs_attention').length

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const closeMenu = (): void => {
    setMenu(null)
    setConfirming(false)
  }

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setConfirming(false)
    setMenu(clampMenuPos(e, 210, 200))
  }

  const startRename = (): void => {
    setDraft(project.name)
    setRenaming(true)
    closeMenu()
  }
  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (name && name !== project.name) void window.orbital.renameProject(project.id, name)
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

  const activate = (): void => setActiveProject(project.id)
  const onHeaderKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (renaming) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate()
    }
  }

  return (
    <div className="mb-1">
      <div
        role="button"
        tabIndex={0}
        onClick={() => !renaming && activate()}
        onKeyDown={onHeaderKey}
        onContextMenu={openMenu}
        className={`group flex cursor-pointer items-center gap-2 rounded-[8px] px-[9px] py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          rootActive ? 'bg-panel-2' : isActive ? 'bg-hover' : 'hover:bg-hover'
        }`}
      >
        {linked.length > 0 ? (
          <button
            type="button"
            aria-label={expanded ? 'Collapse project' : 'Expand project'}
            onClick={(e) => {
              e.stopPropagation()
              toggleExpanded(project.id)
            }}
            className="flex flex-none items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {expanded ? (
              <ChevronDown size={14} strokeWidth={1.5} className="text-muted" />
            ) : (
              <ChevronRight size={14} strokeWidth={1.5} className="text-faint" />
            )}
          </button>
        ) : (
          <span className="w-[14px] flex-none" />
        )}

        <span className="flex w-[11px] flex-none items-center justify-center">
          <StatusDot status={status} />
        </span>

        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              className="allow-select w-full rounded border border-accent/60 bg-bg px-1 py-0.5 text-[13.5px] font-bold text-text outline-none"
            />
          ) : (
            <div className={`text-[13.5px] font-bold ${isActive ? 'text-text' : 'text-text-2'}`}>
              {project.name}
            </div>
          )}
          <div className="mt-px truncate font-mono text-[10.5px] text-faint">
            {root ? `${root.branch} · ` : ''}
            {project.repoPath}
          </div>
        </div>

        {!renaming && (
          <button
            type="button"
            aria-label="New Worktree"
            title="New Worktree"
            onClick={(e) => {
              e.stopPropagation()
              openModal('newWorktree', { project })
            }}
            className="flex size-5 flex-none items-center justify-center rounded-[6px] text-faint opacity-0 outline-none hover:bg-hover hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100"
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        )}

        {!renaming && needsAttention > 0 && (
          <span className="inline-flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-amber/15 px-[5px] font-mono text-[10px] font-bold text-amber-2">
            {needsAttention}
          </span>
        )}
      </div>

      {expanded && linked.length > 0 && (
        <div className="ml-3 mb-[6px] mt-[3px] flex flex-col gap-[2px] border-l border-line-2 pl-3">
          {linked.map((worktree) => (
            <WorktreeRow key={worktree.id} worktree={worktree} />
          ))}
          <button
            type="button"
            onClick={() => openModal('newWorktree', { project })}
            className="mt-px flex items-center gap-[7px] rounded px-[9px] py-[6px] text-left text-[11.5px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Plus size={13} strokeWidth={1.5} className="flex-none" />
            <span>New Worktree</span>
          </button>
        </div>
      )}

      {menu && (
        <ContextMenu pos={menu} width={210} onClose={closeMenu}>
          {!confirming ? (
            <>
              <MenuItem icon={<Pencil size={13} strokeWidth={1.5} />} label="Rename" onClick={startRename} />
              <MenuItem
                icon={<Plus size={13} strokeWidth={1.5} />}
                label="New Worktree"
                onClick={() => {
                  openModal('newWorktree', { project })
                  closeMenu()
                }}
              />
              {/* Clear Status acts on a Worktree row, so it can only appear when
                  there is one. */}
              {root && (
                <MenuItem
                  icon={<CircleOff size={13} strokeWidth={1.5} />}
                  label="Clear Status"
                  onClick={() => {
                    void window.orbital.clearWorktreeStatus(root.id)
                    closeMenu()
                  }}
                />
              )}
              {/* The two OS hand-offs are NOT behind that guard, and must not be.
                  A project's root Worktree row is created by
                  `reconcileProjectWorktrees`, which gives up without writing any
                  rows when `git worktree list` fails — a path that is not a git
                  repo, or has gone unreadable, never gets one. That state is
                  permanent, and it is exactly when a user wants to open the
                  folder and find out why, so hiding both items there would take
                  the tools away at the moment they are needed.

                  They still don't send a path over the bridge: these two name
                  the PROJECT and main reads its own stored `repoPath`, the same
                  provenance as the Worktree path the `(worktreeId, path)` calls
                  resolve against. What is not coming back is the renderer
                  handing main an absolute path to open. */}
              <MenuItem
                icon={<FolderOpen size={13} strokeWidth={1.5} />}
                label="Open in Explorer"
                onClick={() => {
                  fireAndForget(window.orbital.openProjectPath(project.id))
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<Terminal size={13} strokeWidth={1.5} />}
                label="Open in External Terminal"
                onClick={() => {
                  fireAndForget(window.orbital.openProjectInTerminal(project.id))
                  closeMenu()
                }}
              />
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<Trash2 size={13} strokeWidth={1.5} />}
                label="Remove project"
                danger
                onClick={() => setConfirming(true)}
              />
            </>
          ) : (
            <MenuConfirm
              message={`Remove "${project.name}" from Orbital?`}
              hint="The repo and its worktrees stay on disk; open terminals close."
              confirmLabel="Remove"
              danger={false}
              onConfirm={() => {
                void window.orbital.removeProject(project.id)
                closeMenu()
              }}
              onCancel={closeMenu}
            />
          )}
        </ContextMenu>
      )}
    </div>
  )
}
