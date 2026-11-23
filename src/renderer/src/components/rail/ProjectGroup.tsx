import { useMemo, useState, type JSX, type KeyboardEvent } from 'react'
import {
  CircleOff,
  FileText,
  FolderInput,
  FolderOpen,
  FolderRoot,
  House,
  Layers,
  ListPlus,
  Pencil,
  Plus,
  Terminal,
  Trash2,
  Ungroup
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@renderer/store'
import { StatusDot, worktreeStatusLabel } from '@renderer/lib/status'
import { fireAndForget } from '@renderer/lib/bridge'
import { fileManagerName } from '@renderer/lib/platform'
import Repo, { GroupChevron, NeedsYouPill } from './Repo'
import WorktreeRow from './WorktreeRow'
import RenameField from './RenameField'
import { SlotMarker } from './SlotMarker'
import { ContextMenu, MenuConfirm, MenuItem, clampMenuPos, type MenuPos } from './menu'
import { FolderStep, MENU_TITLE, NewFolderStep } from './menuSteps'
import { beginRailDrag, projectRollup, type ProjectRow } from './folders'
import { makeHome, openTerminals, ptyCount, repoCount } from './railActions'

type GroupRow = Extract<ProjectRow, { kind: 'group' }>

type MenuStep = 'items' | 'home' | 'move' | 'newFolder' | 'confirmUngroup' | 'confirmRemove' | { confirmHome: string }

const HOVER_BUTTON =
  'flex size-5 flex-none items-center justify-center rounded-[6px] text-faint opacity-0 outline-none hover:bg-hover hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100'

/**
 * A project that is more than a plain repo row: a header that IS the
 * project's own session, with its children below.
 *
 * The session is the home repo's root worktree when there is a home, else the
 * project's folder session (a terminal-and-agent session in the root folder,
 * with no git). Under the header come the home's linked worktrees, then the
 * member repos in the project's order; the home is never listed again, since
 * its row is this header.
 *
 * Collapsed, the chevron and the needs-you pill stand in for every hidden
 * worktree (the session's own status stays on its dot, never rolled up). The
 * header drags to move the whole project; the Rail owns the drop, and passes
 * `joinTarget` while a dragged repo would join this project and `repoSlot`
 * while it would be inserted among the members.
 */
export default function ProjectGroup({
  row,
  joinTarget,
  repoSlot
}: {
  row: GroupRow
  joinTarget: boolean
  /** The member index a dragged repo would be inserted before (members.length = last), or null. */
  repoSlot: number | null
}): JSX.Element {
  const { project, home, members, open } = row
  const worktrees = useStore(useShallow((s) => s.worktrees.filter((w) => w.projectId === project.id)))
  const rollup = useMemo(() => projectRollup(project, worktrees), [project, worktrees])
  const { session, homeLinked } = rollup
  const activeWorktreeId = useStore((s) => s.activeWorktreeId)
  const holdsActive = useStore((s) => s.activeProjectId === project.id)
  const renaming = useStore((s) => s.renamingProjectId === project.id)
  const setRenamingProject = useStore((s) => s.setRenamingProject)
  const setActiveProject = useStore((s) => s.setActiveProject)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const setExpanded = useStore((s) => s.setExpanded)
  const openModal = useStore((s) => s.openModal)

  const [menu, setMenu] = useState<MenuPos | null>(null)
  const [step, setStep] = useState<MenuStep>('items')

  const repoTotal = members.length + (home ? 1 : 0)
  const hasChildren = members.length > 0 || homeLinked.length > 0
  const sessionActive = !!session && activeWorktreeId === session.id
  const homeLinkedActive = homeLinked.some((w) => w.id === activeWorktreeId)
  const sessionStatus = session?.status ?? 'idle'
  const terminals = home ? 0 : ptyCount(session)

  const closeMenu = (): void => {
    setMenu(null)
    setStep('items')
  }
  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setStep('items')
    // 280, not the spec's 230: "Managed AGENTS.md Block" and its "needs home repo" hint wrap below that.
    setMenu(clampMenuPos(e, 280, 400))
  }

  const activate = (): void => setActiveProject(project.id)
  const onHeaderKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (renaming || e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate()
    } else if (hasChildren && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      setExpanded(project.id, e.key === 'ArrowRight')
    }
  }

  const commitRename = (draft: string): void => {
    const name = draft.trim()
    setRenamingProject(null)
    if (name && name !== project.name) fireAndForget(window.orbital.renameProject(project.id, name))
  }

  const pickHome = (repoId: string): void => {
    if (terminals > 0) {
      setStep({ confirmHome: repoId })
      return
    }
    makeHome(project.id, repoId)
    closeMenu()
  }

  const addRepo = (): void => openModal('addRepo', { projectId: project.id })

  // bg-panel-2 marks the open session's own row; bg-hover the nearest row
  // standing in for it (a home worktree, or anything inside while collapsed).
  const fill = joinTarget
    ? ''
    : sessionActive
      ? 'bg-panel-2'
      : holdsActive && (homeLinkedActive || !open)
        ? 'bg-hover'
        : 'hover:bg-hover'

  const hiddenLabel = rollup.hidden === 'idle' ? '' : ` — worktrees ${worktreeStatusLabel(rollup.hidden)}`
  const count = repoCount(repoTotal)
  const ungroupHint = home
    ? `Its ${count} become separate rows. ${home.name} keeps its session.`
    : `Its ${count} become separate rows. The project session closes${
        terminals > 0 ? `, along with ${openTerminals(terminals)}` : ''
      }.`

  return (
    // The data attribute is how the Rail tells which project a drag is over;
    // the header is the block's first child, which is what it measures.
    <div
      data-project-id={project.id}
      className={`mb-1 rounded-[8px] ${joinTarget ? 'bg-accent/10 ring-1 ring-inset ring-accent/50' : ''}`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={sessionActive ? 'true' : undefined}
        onClick={() => !renaming && activate()}
        onKeyDown={onHeaderKey}
        onContextMenu={openMenu}
        draggable={!renaming}
        onDragStart={(e) => beginRailDrag(e, { kind: 'project', id: project.id })}
        className={`group flex cursor-pointer items-center gap-2 rounded-[8px] px-[9px] py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${fill}`}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={`${open ? 'Collapse' : 'Expand'} project${hiddenLabel}`}
            aria-expanded={open}
            title={rollup.hidden === 'idle' ? undefined : `Worktrees ${worktreeStatusLabel(rollup.hidden)}`}
            onClick={(e) => {
              e.stopPropagation()
              toggleExpanded(project.id, true)
            }}
            className="flex flex-none items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <GroupChevron expanded={open} status={rollup.hidden} />
          </button>
        ) : (
          <span className="w-[14px] flex-none" />
        )}

        <span
          title={worktreeStatusLabel(sessionStatus)}
          className="flex w-[11px] flex-none items-center justify-center"
        >
          <StatusDot status={sessionStatus} />
        </span>

        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameField
              initial={project.name}
              label="Project name"
              className="text-[13.5px] font-bold"
              onCommit={commitRename}
              onCancel={() => setRenamingProject(null)}
            />
          ) : (
            <div className={`truncate text-[13.5px] font-bold ${holdsActive ? 'text-text' : 'text-text-2'}`}>
              {project.name}
              <span className="sr-only">
                , project, {count}, {home ? `home repo ${home.name}` : 'folder session'}
              </span>
            </div>
          )}
          {home ? (
            <div
              title={`${session ? `${session.branch} · ` : ''}${home.repoPath}`}
              className="mt-px truncate font-mono text-[10.5px] text-faint"
            >
              <span title={`Home repo: ${home.name}`}>
                <House size={10} strokeWidth={1.5} aria-hidden className="-mt-px mr-1 inline" />
              </span>
              {session ? `${session.branch} · ` : ''}
              {home.repoPath}
            </div>
          ) : (
            <div title={project.rootPath} className="mt-px truncate font-mono text-[10.5px] text-faint">
              <span title="Folder session. No git here.">
                <FolderRoot size={10} strokeWidth={1.5} aria-hidden className="-mt-px mr-1 inline" />
              </span>
              {project.rootPath}
            </div>
          )}
        </div>

        {!renaming &&
          (home ? (
            <button
              type="button"
              aria-label="New Worktree"
              title="New Worktree"
              onClick={(e) => {
                e.stopPropagation()
                openModal('newWorktree', { repo: home })
              }}
              className={HOVER_BUTTON}
            >
              <Plus size={13} strokeWidth={1.5} />
            </button>
          ) : (
            <button
              type="button"
              aria-label={`Add repo to ${project.name}`}
              title="Add repo"
              onClick={(e) => {
                e.stopPropagation()
                addRepo()
              }}
              className={HOVER_BUTTON}
            >
              <ListPlus size={13} strokeWidth={1.5} />
            </button>
          ))}

        {!renaming && !open && rollup.needsYou > 0 && <NeedsYouPill count={rollup.needsYou} />}
        {!renaming && (
          <span title={count} className="flex flex-none items-center gap-[3px] font-mono text-[10px] text-faint">
            <Layers size={11} strokeWidth={1.5} aria-hidden />
            {repoTotal}
          </span>
        )}
      </div>

      {open && (hasChildren || !home) && (
        <div className="ml-[15px] border-l border-line-2 pl-[5px] pt-[2px]">
          {homeLinked.length > 0 && (
            // 22px = chevron 14 + gap 8, so these dots line up with the members' dots below.
            <div className="mb-[4px] flex flex-col gap-[2px] pl-[22px]">
              {homeLinked.map((w) => (
                <WorktreeRow key={w.id} worktree={w} />
              ))}
            </div>
          )}
          {members.map((repo, i) => (
            <div key={repo.id}>
              {repoSlot === i && <SlotMarker />}
              <Repo repo={repo} project={project} variant="member" />
            </div>
          ))}
          {members.length > 0 && repoSlot === members.length && <SlotMarker />}
          {members.length === 0 && !home && (
            <>
              <div className="px-[9px] pt-[5px] text-[11px] text-faint">No repos yet. Drag one here.</div>
              <button
                type="button"
                onClick={addRepo}
                className="mt-px flex items-center gap-[7px] rounded px-[9px] py-[6px] text-left text-[11.5px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <ListPlus size={13} strokeWidth={1.5} className="flex-none" />
                <span>Add Repo</span>
              </button>
            </>
          )}
        </div>
      )}

      {menu && (
        <ContextMenu pos={menu} width={280} onClose={closeMenu}>
          {step === 'items' && (
            <>
              <MenuItem
                icon={<Pencil size={13} strokeWidth={1.5} />}
                label="Rename"
                onClick={() => {
                  setRenamingProject(project.id)
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<ListPlus size={13} strokeWidth={1.5} />}
                label="Add Repo…"
                onClick={() => {
                  addRepo()
                  closeMenu()
                }}
              />
              {home && (
                <MenuItem
                  icon={<Plus size={13} strokeWidth={1.5} />}
                  label="New Worktree"
                  onClick={() => {
                    openModal('newWorktree', { repo: home })
                    closeMenu()
                  }}
                />
              )}
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<House size={13} strokeWidth={1.5} />}
                label="Home Repo"
                hint={home ? home.name : 'none'}
                onClick={() => setStep('home')}
              />
              <MenuItem
                icon={<FolderRoot size={13} strokeWidth={1.5} />}
                label="Change Root Folder…"
                onClick={() => {
                  fireAndForget(window.orbital.setProjectRoot(project.id))
                  closeMenu()
                }}
              />
              <MenuItem
                icon={<FileText size={13} strokeWidth={1.5} />}
                label="Managed AGENTS.md Block"
                hint={home ? (project.managedBlock ? 'on' : 'off') : 'needs home repo'}
                disabled={!home}
                onClick={() => {
                  fireAndForget(window.orbital.setProjectManagedBlock(project.id, !project.managedBlock))
                  closeMenu()
                }}
              />
              <div className="my-1 h-px bg-soft" />
              <MenuItem
                icon={<FolderInput size={13} strokeWidth={1.5} />}
                label="Move to Folder"
                onClick={() => setStep('move')}
              />
              {session && (
                <MenuItem
                  icon={<CircleOff size={13} strokeWidth={1.5} />}
                  label="Clear Status"
                  onClick={() => {
                    fireAndForget(window.orbital.clearWorktreeStatus(session.id))
                    closeMenu()
                  }}
                />
              )}
              <MenuItem
                icon={<FolderOpen size={13} strokeWidth={1.5} />}
                label={`Open in ${fileManagerName}`}
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
                icon={<Ungroup size={13} strokeWidth={1.5} />}
                label="Ungroup"
                onClick={() => setStep('confirmUngroup')}
              />
              <MenuItem
                icon={<Trash2 size={13} strokeWidth={1.5} />}
                label="Remove project"
                danger
                onClick={() => setStep('confirmRemove')}
              />
            </>
          )}

          {step === 'home' && (
            <>
              <div className={MENU_TITLE}>Home repo for {project.name}</div>
              <div className="max-h-[260px] overflow-y-auto">
                {home && (
                  <MenuItem
                    icon={<House size={13} strokeWidth={1.5} />}
                    label={home.name}
                    hint="current"
                    disabled
                    onClick={() => undefined}
                  />
                )}
                {members.map((repo) => (
                  <MenuItem
                    key={repo.id}
                    icon={<span className="inline-block w-[13px]" />}
                    label={repo.name}
                    onClick={() => pickHome(repo.id)}
                  />
                ))}
              </div>
              {home && (
                <>
                  <div className="my-1 h-px bg-soft" />
                  <MenuItem
                    icon={<span className="inline-block w-[13px]" />}
                    label="Clear Home Repo"
                    onClick={() => {
                      fireAndForget(window.orbital.setProjectHome(project.id, null))
                      closeMenu()
                    }}
                  />
                </>
              )}
              {project.managedBlock && (
                <>
                  <div className="my-1 h-px bg-soft" />
                  <div className="px-2 pb-1 pt-1 text-[11px] leading-snug text-dim">
                    Orbital keeps a repo list in the home repo&rsquo;s AGENTS.md. Turn it off with Managed AGENTS.md
                    Block.
                  </div>
                </>
              )}
            </>
          )}

          {typeof step === 'object' && (
            <MenuConfirm
              message={`Make ${members.find((m) => m.id === step.confirmHome)?.name ?? 'this repo'} the home repo of "${project.name}"?`}
              hint={`The project session moves into ${members.find((m) => m.id === step.confirmHome)?.name ?? 'it'}. ${
                terminals === 1
                  ? 'The 1 terminal open in the folder session closes.'
                  : `The ${terminals} terminals open in the folder session close.`
              }`}
              confirmLabel="Make Home"
              danger={false}
              onConfirm={() => {
                makeHome(project.id, step.confirmHome)
                closeMenu()
              }}
              onCancel={closeMenu}
            />
          )}

          {step === 'move' && (
            <FolderStep
              name={project.name}
              projectId={project.id}
              onNewFolder={() => setStep('newFolder')}
              onDone={closeMenu}
            />
          )}

          {step === 'newFolder' && <NewFolderStep name={project.name} projectId={project.id} onDone={closeMenu} />}

          {step === 'confirmUngroup' && (
            <MenuConfirm
              message={`Ungroup "${project.name}"?`}
              hint={ungroupHint}
              confirmLabel="Ungroup"
              danger={false}
              onConfirm={() => {
                fireAndForget(window.orbital.ungroupProject(project.id))
                closeMenu()
              }}
              onCancel={closeMenu}
            />
          )}

          {step === 'confirmRemove' && (
            <MenuConfirm
              message={`Remove "${project.name}" and its ${count} from Orbital?`}
              hint="The repos and their worktrees stay on disk; open terminals close."
              confirmLabel="Remove"
              danger={false}
              onConfirm={() => {
                fireAndForget(window.orbital.removeProject(project.id))
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
