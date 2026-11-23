import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Folder as FolderClosed, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { aggregateStatus, type Repo as RepoModel, type RailFolder } from '@shared/types'
import { useStore } from '@renderer/store'
import { worktreeStatusLabel } from '@renderer/lib/status'
import { fireAndForget } from '@renderer/lib/bridge'
import Repo, { GroupChevron } from './Repo'
import { ContextMenu, MenuConfirm, MenuItem, clampMenuPos, type MenuPos } from './menu'
import { beginRailDrag } from './folders'

/** Where a dragged row would be inserted. Zero-height, so showing it never shifts the rows it sits between. */
export function SlotMarker(): JSX.Element {
  return (
    <div className="pointer-events-none relative h-0">
      <div className="absolute inset-x-[6px] -top-[3px] h-[2px] rounded-full bg-accent" />
    </div>
  )
}

/**
 * The folder's name as an editable field. Mounted only while renaming, so its
 * draft always starts from the current name and it takes focus as it appears.
 * Enter or leaving the field commits; Escape drops the edit.
 */
function RenameField({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onCommit(draft)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label="Folder name"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => onCommit(draft)}
      onClick={(e) => e.stopPropagation()}
      className="allow-select w-full rounded border border-accent/60 bg-bg px-1 py-0.5 text-[12px] font-semibold text-text outline-none"
    />
  )
}

/**
 * A folder in the rail: a named, collapsible group of repos.
 *
 * It is an arrangement of the panel and nothing else. The repos inside are
 * the same `Repo` rows the loose list renders, and nothing about them (repo
 * path, worktrees, agent, settings) depends on which folder they sit in.
 *
 * The whole header toggles the folder, since there is nothing to select here
 * the way a repo header selects its root Worktree. Collapsed, the chevron
 * and the count badge stand in for the rows that are hidden, in the same status
 * vocabulary a repo's chevron uses for its hidden Worktrees. Right-click
 * renames or deletes it; deleting only ungroups. The header drags to move the
 * folder along the rail. The Rail owns every drop: it passes `dropInto` while
 * a dragged repo would be filed here, and `dropSlot` while one would be
 * inserted at a place among the repos already inside.
 */
export default function Folder({
  folder,
  repos,
  dropInto,
  dropSlot,
  renaming,
  onRenaming
}: {
  folder: RailFolder
  repos: RepoModel[]
  /** A dragged repo would land in this folder if dropped now. */
  dropInto: boolean
  /** The index among `repos` a dragged repo would be inserted before (its length = last), or null. */
  dropSlot: number | null
  /** Controlled by the Rail, so a folder it has just created can open straight into its name. */
  renaming: boolean
  onRenaming: (renaming: boolean) => void
}): JSX.Element {
  // Every Worktree under the folder, roots included: collapsed, none of its
  // repos' own dots are on screen, so this is the only place they report.
  const statuses = useStore(
    useShallow((s) => s.worktrees.filter((w) => folder.repoIds.includes(w.repoId)).map((w) => w.status))
  )
  const holdsActive = useStore((s) => !!s.activeRepoId && folder.repoIds.includes(s.activeRepoId))
  const expanded = !folder.collapsed
  const status = aggregateStatus(statuses)
  const needsAttention = statuses.filter((s) => s === 'needs_attention').length

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [confirming, setConfirming] = useState(false)

  const closeMenu = (): void => {
    setMenu(null)
    setConfirming(false)
  }
  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setConfirming(false)
    setMenu(clampMenuPos(e, 210, 120))
  }

  const toggle = (): void => {
    fireAndForget(window.orbital.setRailFolderCollapsed(folder.id, expanded))
  }
  const commitRename = (draft: string): void => {
    const name = draft.trim()
    onRenaming(false)
    if (name && name !== folder.name) fireAndForget(window.orbital.renameRailFolder(folder.id, name))
  }
  const remove = (): void => {
    fireAndForget(window.orbital.removeRailFolder(folder.id))
    closeMenu()
  }

  const Icon = expanded ? FolderOpen : FolderClosed
  const count = `${repos.length} repo${repos.length === 1 ? '' : 's'}`

  return (
    // The data attribute is how the Rail tells which folder a drag is over. The
    // gap below is padding, not margin, so it belongs to this folder and a drag
    // crossing from one folder to the next never passes over "no folder".
    <div data-folder-id={folder.id} className="pb-1">
      <div className={`rounded-[8px] ${dropInto ? 'bg-accent/10 ring-1 ring-inset ring-accent/50' : ''}`}>
        <div
          // How the Rail finds the row to measure a drag against.
          data-folder-header
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => !renaming && toggle()}
          onKeyDown={(e) => {
            if (renaming) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggle()
            }
          }}
          onContextMenu={openMenu}
          draggable={!renaming}
          onDragStart={(e) => beginRailDrag(e, { kind: 'folder', id: folder.id })}
          className="flex cursor-pointer items-center gap-2 rounded-[8px] px-[9px] py-[6px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <span
            title={status === 'idle' ? undefined : `Worktrees ${worktreeStatusLabel(status)}`}
            className="flex flex-none items-center"
          >
            <GroupChevron expanded={expanded} status={status} />
          </span>
          <span className="flex w-[11px] flex-none items-center justify-center text-faint">
            <Icon size={13} strokeWidth={1.5} className="flex-none" />
          </span>

          <div className="min-w-0 flex-1">
            {renaming ? (
              <RenameField initial={folder.name} onCommit={commitRename} onCancel={() => onRenaming(false)} />
            ) : (
              <div
                className={`truncate text-[12px] font-semibold ${
                  holdsActive && !expanded ? 'text-text' : 'text-text-3'
                }`}
              >
                {folder.name}
                {/* The chevron's tint is a colour, and colour alone is not a status. */}
                {status !== 'idle' && <span className="sr-only"> — worktrees {worktreeStatusLabel(status)}</span>}
              </div>
            )}
          </div>

          {!renaming && !expanded && needsAttention > 0 && (
            <span className="inline-flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-amber/15 px-[5px] font-mono text-[10px] font-bold text-amber-2">
              {needsAttention}
            </span>
          )}
          {!renaming && (
            <span title={count} className="flex-none font-mono text-[10px] text-faint">
              {repos.length}
            </span>
          )}
        </div>

        {expanded && (
          <div className="ml-[15px] border-l border-line-2 pl-[5px] pt-[2px]">
            {repos.length > 0 ? (
              <>
                {repos.map((repo, i) => (
                  <div key={repo.id}>
                    {dropSlot === i && <SlotMarker />}
                    <Repo repo={repo} />
                  </div>
                ))}
                {dropSlot === repos.length && <SlotMarker />}
              </>
            ) : (
              <div className="px-[9px] pb-[7px] pt-[5px] text-[11px] text-faint">Empty. Drag a repo here.</div>
            )}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu pos={menu} width={210} onClose={closeMenu}>
          {!confirming ? (
            <>
              <MenuItem
                icon={<Pencil size={13} strokeWidth={1.5} />}
                label="Rename"
                onClick={() => {
                  onRenaming(true)
                  closeMenu()
                }}
              />
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<Trash2 size={13} strokeWidth={1.5} />}
                label="Delete Folder"
                danger
                // An empty folder holds nothing to lose track of, so it just goes.
                onClick={() => (repos.length > 0 ? setConfirming(true) : remove())}
              />
            </>
          ) : (
            <MenuConfirm
              message={`Delete the folder "${folder.name}"?`}
              hint={`Its ${count} stay${repos.length === 1 ? 's' : ''} in Orbital, ungrouped. Nothing on disk changes.`}
              confirmLabel="Delete Folder"
              danger={false}
              onConfirm={remove}
              onCancel={closeMenu}
            />
          )}
        </ContextMenu>
      )}
    </div>
  )
}
