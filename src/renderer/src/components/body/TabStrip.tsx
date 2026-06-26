import { useState, type JSX } from 'react'
import {
  Terminal,
  Globe,
  FileText,
  Plus,
  X,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Columns2
} from 'lucide-react'
import type { Flight, Pane, Tab, TabType } from '@shared/types'
import { StatusDot } from '@renderer/lib/status'
import { TAB_DND } from './PaneGroup'

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/** Lucide glyph for a tab type. */
function TypeIcon({ type, className }: { type: TabType; className?: string }): JSX.Element {
  const props = { size: 14, strokeWidth: 1.5, className }
  if (type === 'browser') return <Globe {...props} />
  if (type === 'editor') return <FileText {...props} />
  return <Terminal {...props} />
}

/** Display title: explicit override, else something derived from the config. */
function tabTitle(tab: Tab): string {
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
  return 'terminal'
}

/**
 * The h-9 tab strip atop a pane: a chip per tab (draggable between panes), an
 * add-tab popover, and a pane-options menu (split across / below / close). The
 * strip is also a drop target — dropping a tab here moves it into this pane.
 */
export default function TabStrip({ pane, flight }: { pane: Pane; flight: Flight }): JSX.Element {
  const [addOpen, setAddOpen] = useState(false)
  const [paneMenu, setPaneMenu] = useState(false)
  const onlyPane = flight.panes.length <= 1

  const addTab = (type: TabType): void => {
    setAddOpen(false)
    void window.orbital.createTab(flight.id, pane.id, type)
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
      className="flex h-9 flex-none items-stretch gap-0.5 border-b border-line bg-bar px-1.5"
    >
      {pane.tabs.map((tab) => {
        const isActive = tab.id === pane.activeTabId
        const showDot = tab.type === 'terminal' && !!tab.status && tab.status !== 'idle'
        const chipClass = isActive
          ? '-mb-px rounded-t-btn border border-line-2 border-b-pane bg-pane text-text'
          : 'text-text-3 hover:text-text'
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_DND, tab.id)
              e.dataTransfer.effectAllowed = 'move'
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
              <TypeIcon type={tab.type} className="text-text-3" />
            )}
            <span
              className={`text-xs ${isActive ? 'font-semibold' : 'font-medium'} ${tab.type === 'editor' ? 'font-mono' : ''}`}
            >
              {tabTitle(tab)}
            </span>
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
              {(['terminal', 'browser', 'editor'] as TabType[]).map((type) => (
                <button
                  key={type}
                  role="menuitem"
                  onClick={() => addTab(type)}
                  className={`flex w-full items-center gap-2.5 rounded-chip px-2.5 py-1.5 text-left text-xs font-medium capitalize text-text-2 hover:bg-hover ${FOCUS}`}
                >
                  <TypeIcon type={type} className="text-muted" />
                  {type}
                </button>
              ))}
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
