import { useEffect, useRef, useState, type JSX } from 'react'
import {
  Terminal,
  Globe,
  FileText,
  Plus,
  X,
  CopyX,
  Pencil,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Columns2
} from 'lucide-react'
import type { Flight, Pane, Tab, TabConfig, TabType } from '@shared/types'
import { ClaudeIcon, CodexIcon } from '../icons'
import { useStore } from '@renderer/store'
import { StatusDot } from '@renderer/lib/status'
import { ContextMenu, MenuItem, clampMenuPos, type MenuPos } from '../rail/menu'
import { TAB_DND } from './PaneGroup'

/** Compact display label for a dev-server URL: host:port (or the URL itself). */
export function serverLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return url
  }
}

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/** Glyph for a tab type (agent tabs get their provider's brand mark). */
function TypeIcon({
  type,
  provider,
  className
}: {
  type: TabType
  provider?: string
  className?: string
}): JSX.Element {
  const props = { size: 14, strokeWidth: 1.5, className }
  if (type === 'browser') return <Globe {...props} />
  if (type === 'editor') return <FileText {...props} />
  if (type === 'agent') return provider === 'codex' ? <CodexIcon {...props} /> : <ClaudeIcon {...props} />
  return <Terminal {...props} />
}

/** Display names for agent providers. */
const AGENT_TITLES: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

/** Tab types offered in the add-tab popover, with their picker labels. */
const ADD_OPTIONS: { type: TabType; label: string; config?: TabConfig }[] = [
  { type: 'terminal', label: 'Terminal' },
  { type: 'agent', label: 'Claude', config: { agentProvider: 'claude' } },
  { type: 'agent', label: 'Codex', config: { agentProvider: 'codex' } },
  { type: 'browser', label: 'Browser' },
  { type: 'editor', label: 'Editor' }
]

/** Display title: explicit override, else something derived from the config. */
function tabTitle(tab: Tab, defaultAgentProvider?: string): string {
  if (tab.config.title) return tab.config.title
  if (tab.type === 'editor') {
    const p = tab.config.filePath
    return p ? p.split('/').pop() || p : 'editor'
  }
  if (tab.type === 'browser') {
    const u = tab.config.url
    if (!u) return 'browser'
    try {
      return new URL(u).hostname || u
    } catch {
      return u
    }
  }
  if (tab.type === 'agent') {
    const provider = tab.config.agentProvider || defaultAgentProvider || 'claude'
    return AGENT_TITLES[provider] ?? provider
  }
  return 'terminal'
}

/**
 * The h-9 tab strip atop a pane: a chip per tab (draggable between panes,
 * right-click for rename / split / close options), an add-tab popover, and a
 * pane-options menu (split across / below / close). The strip is also a drop
 * target — dropping a tab here moves it into this pane.
 */
export default function TabStrip({ pane, flight }: { pane: Pane; flight: Flight }): JSX.Element {
  const [addOpen, setAddOpen] = useState(false)
  const [paneMenu, setPaneMenu] = useState(false)
  const [tabMenu, setTabMenu] = useState<{ pos: MenuPos; tab: Tab } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const onlyPane = flight.panes.length <= 1
  const servers = useStore((s) => s.devServers[flight.id]) ?? []
  const defaultAgentProvider = useStore(
    (s) => s.workspaces.find((w) => w.id === flight.workspaceId)?.defaultAgentProvider
  )

  useEffect(() => {
    if (renamingId) renameRef.current?.select()
  }, [renamingId])

  const addTab = (type: TabType, config?: TabConfig): void => {
    setAddOpen(false)
    void window.orbital.createTab(flight.id, pane.id, type, config)
  }

  const openTabMenu = (e: React.MouseEvent, tab: Tab): void => {
    e.preventDefault()
    e.stopPropagation()
    setTabMenu({ pos: clampMenuPos(e, 190, 200), tab })
  }

  const startRename = (tab: Tab): void => {
    setDraft(tabTitle(tab, defaultAgentProvider))
    setRenamingId(tab.id)
    setTabMenu(null)
  }
  const commitRename = (tab: Tab): void => {
    const title = draft.trim()
    setRenamingId(null)
    if (title && title !== tabTitle(tab, defaultAgentProvider)) void window.orbital.renameTab(tab.id, title)
  }

  const closeOthers = (tab: Tab): void => {
    setTabMenu(null)
    for (const t of pane.tabs) if (t.id !== tab.id) void window.orbital.closeTab(t.id)
  }

  const onStripDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(TAB_DND)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const onStripDrop = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(TAB_DND)) return
    e.preventDefault()
    const tabId = e.dataTransfer.getData(TAB_DND)
    if (tabId) void window.orbital.moveTab(tabId, pane.id)
  }

  return (
    <div
      onDragOver={onStripDragOver}
      onDrop={onStripDrop}
      className="flex h-9 flex-none items-stretch gap-0.5 border-b border-line bg-bar px-1.5 pt-0.5"
    >
      {pane.tabs.map((tab) => {
        const isActive = tab.id === pane.activeTabId
        const showDot =
          (tab.type === 'terminal' || tab.type === 'agent') && !!tab.status && tab.status !== 'idle'
        const chipClass = isActive
          ? '-mb-px rounded-t-btn border border-line-2 border-b-pane bg-pane text-text'
          : 'text-text-3 hover:text-text'
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            onContextMenu={(e) => openTabMenu(e, tab)}
            draggable={renamingId !== tab.id}
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_DND, tab.id)
              e.dataTransfer.effectAllowed = 'move'
              // The native drag image snapshots the chip's border box, so a tab that's
              // only rounded on top (active) or unstyled (inactive) drags as a hard-
              // cornered rectangle. Snapshot a fully-rounded clone for a clean ghost.
              const node = e.currentTarget
              const r = node.getBoundingClientRect()
              const ghost = node.cloneNode(true) as HTMLElement
              ghost.style.cssText = `position:fixed;top:-1000px;left:-1000px;margin:0;width:${r.width}px;height:${r.height}px;border-radius:var(--radius-btn);border:1px solid var(--color-line-2);background:var(--color-pane);pointer-events:none`
              document.body.appendChild(ghost)
              e.dataTransfer.setDragImage(ghost, e.nativeEvent.offsetX, e.nativeEvent.offsetY)
              // The browser snapshots synchronously; drop the clone on the next tick.
              setTimeout(() => ghost.remove(), 0)
            }}
            title="Drag to move to another pane"
            onClick={() => window.orbital.setActiveTab(pane.id, tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void window.orbital.setActiveTab(pane.id, tab.id)
              }
            }}
            className={`flex cursor-pointer items-center gap-2 px-3 ${chipClass} ${FOCUS}`}
          >
            {showDot && tab.status ? (
              <StatusDot status={tab.status} />
            ) : (
              <TypeIcon
                type={tab.type}
                provider={tab.config.agentProvider || defaultAgentProvider}
                className="text-text-3"
              />
            )}
            {renamingId === tab.id ? (
              <input
                ref={renameRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitRename(tab)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setRenamingId(null)
                  }
                }}
                onBlur={() => commitRename(tab)}
                onClick={(e) => e.stopPropagation()}
                className="allow-select w-24 rounded border border-accent/60 bg-bg px-1 py-0.5 text-xs text-text outline-none"
              />
            ) : (
              <span
                className={`text-xs ${isActive ? 'font-semibold' : 'font-medium'} ${tab.type === 'editor' ? 'font-mono' : ''}`}
              >
                {tabTitle(tab, defaultAgentProvider)}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                void window.orbital.closeTab(tab.id)
              }}
              aria-label="Close tab"
              className={`-mr-1 flex size-4 items-center justify-center rounded text-faint hover:text-text-2 ${FOCUS}`}
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          </div>
        )
      })}

      {/* Add-tab popover */}
      <div className="relative flex items-center">
        <button
          onClick={() => setAddOpen((v) => !v)}
          aria-label="New tab"
          aria-haspopup="menu"
          aria-expanded={addOpen}
          className={`flex size-7 items-center justify-center rounded text-faint hover:text-text-2 ${FOCUS}`}
        >
          <Plus size={16} strokeWidth={1.5} />
        </button>
        {addOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setAddOpen(false)} />
            <div
              role="menu"
              className="absolute left-0 top-8 z-[41] w-40 rounded-card border border-line-strong bg-elev p-1 shadow-[0_14px_36px_rgba(0,0,0,0.55)]"
            >
              {ADD_OPTIONS.map(({ type, label, config }) => (
                <button
                  key={label}
                  role="menuitem"
                  onClick={() => addTab(type, config)}
                  className={`flex w-full items-center gap-2.5 rounded-chip px-2.5 py-1.5 text-left text-xs font-medium text-text-2 hover:bg-hover ${FOCUS}`}
                >
                  <TypeIcon type={type} provider={config?.agentProvider} className="text-muted" />
                  {label}
                </button>
              ))}

              {/* Live dev servers (registered via `orbital server add`) open as browser tabs. */}
              {servers.length > 0 && (
                <>
                  <div className="my-1 h-px bg-soft" />
                  <div className="px-2.5 pb-1 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.6px] text-faint">
                    Dev servers
                  </div>
                  {servers.map((url) => (
                    <button
                      key={url}
                      role="menuitem"
                      title={url}
                      onClick={() => addTab('browser', { url })}
                      className={`flex w-full items-center gap-2.5 rounded-chip px-2.5 py-1.5 text-left text-xs font-medium text-text-2 hover:bg-hover ${FOCUS}`}
                    >
                      <span className="relative size-[7px] flex-none">
                        <span className="absolute inset-0 rounded-full bg-green animate-pulse-dot" />
                      </span>
                      <span className="truncate font-mono">{serverLabel(url)}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex-1" />

      {/* Pane-options menu */}
      <div className="relative flex items-center">
        <button
          onClick={() => setPaneMenu((v) => !v)}
          aria-label="Pane options"
          title="Pane options"
          aria-haspopup="menu"
          aria-expanded={paneMenu}
          className={`flex size-7 items-center justify-center self-center rounded text-faint hover:text-text-2 ${FOCUS}`}
        >
          <Columns2 size={15} strokeWidth={1.5} />
        </button>
        {paneMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPaneMenu(false)} />
            <div
              role="menu"
              className="absolute right-0 top-8 z-[41] w-44 rounded-card border border-line-strong bg-elev p-1 shadow-[0_14px_36px_rgba(0,0,0,0.55)]"
            >
              <PaneMenuItem
                icon={<SplitSquareHorizontal size={14} strokeWidth={1.5} />}
                label="Split across"
                onClick={() => {
                  setPaneMenu(false)
                  void window.orbital.splitPane(flight.id, pane.id, 'row', 'after')
                }}
              />
              <PaneMenuItem
                icon={<SplitSquareVertical size={14} strokeWidth={1.5} />}
                label="Split below"
                onClick={() => {
                  setPaneMenu(false)
                  void window.orbital.splitPane(flight.id, pane.id, 'column', 'after')
                }}
              />
              <div className="my-1 h-px bg-soft" />
              <PaneMenuItem
                icon={<X size={14} strokeWidth={1.5} />}
                label="Close pane"
                danger
                disabled={onlyPane}
                onClick={() => {
                  setPaneMenu(false)
                  void window.orbital.closePane(flight.id, pane.id)
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* Tab context menu (right-click on a chip) */}
      {tabMenu && (
        <ContextMenu pos={tabMenu.pos} width={190} onClose={() => setTabMenu(null)}>
          <MenuItem
            icon={<Pencil size={13} strokeWidth={1.5} />}
            label="Rename tab"
            onClick={() => startRename(tabMenu.tab)}
          />
          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={<SplitSquareHorizontal size={13} strokeWidth={1.5} />}
            label="Split across"
            onClick={() => {
              setTabMenu(null)
              void window.orbital.splitPane(flight.id, pane.id, 'row', 'after')
            }}
          />
          <MenuItem
            icon={<SplitSquareVertical size={13} strokeWidth={1.5} />}
            label="Split below"
            onClick={() => {
              setTabMenu(null)
              void window.orbital.splitPane(flight.id, pane.id, 'column', 'after')
            }}
          />
          <div className="my-1 h-px bg-soft" />
          <MenuItem
            icon={<X size={13} strokeWidth={1.5} />}
            label="Close tab"
            danger
            onClick={() => {
              setTabMenu(null)
              void window.orbital.closeTab(tabMenu.tab.id)
            }}
          />
          {pane.tabs.length > 1 && (
            <MenuItem
              icon={<CopyX size={13} strokeWidth={1.5} />}
              label="Close other tabs"
              danger
              onClick={() => closeOthers(tabMenu.tab)}
            />
          )}
        </ContextMenu>
      )}
    </div>
  )
}

function PaneMenuItem({
  icon,
  label,
  danger,
  disabled,
  onClick
}: {
  icon: JSX.Element
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-chip px-2.5 py-1.5 text-left text-xs font-medium hover:bg-hover ${FOCUS} disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent ${
        danger ? 'text-red-2' : 'text-text-2'
      }`}
    >
      <span className={`flex-none ${danger ? 'text-red-2' : 'text-muted'}`}>{icon}</span>
      {label}
    </button>
  )
}
