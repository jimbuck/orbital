import { useState } from 'react'
import { Terminal, Globe, FileText, Plus, X, SplitSquareHorizontal } from 'lucide-react'
import type { Flight, Pane, Tab, TabType } from '@shared/types'
import { StatusDot } from '@renderer/lib/status'

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
 * The h-9 tab strip atop a pane: a chip per tab, an add-tab popover and a
 * split-pane button. Terminals show their StatusDot when not idle.
 */
export default function TabStrip({ pane, flight }: { pane: Pane; flight: Flight }): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)

  const addTab = (type: TabType): void => {
    setMenuOpen(false)
    void window.orbital.createTab(flight.id, pane.id, type)
  }

  return (
    <div className="flex h-9 flex-none items-stretch gap-0.5 border-b border-line bg-bar px-1.5">
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
            <span className={`text-xs ${isActive ? 'font-semibold' : 'font-medium'} ${tab.type === 'editor' ? 'font-mono' : ''}`}>
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
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="New tab"
          className={`flex size-7 items-center justify-center rounded text-faint hover:text-text-2 ${FOCUS}`}
        >
          <Plus size={16} strokeWidth={1.5} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute left-0 top-8 z-[41] w-40 rounded-card border border-line-strong bg-elev p-1 shadow-[0_14px_36px_rgba(0,0,0,0.55)]">
              {(['terminal', 'browser', 'editor'] as TabType[]).map((type) => (
                <button
                  key={type}
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

      <button
        onClick={() => window.orbital.splitPane(flight.id, pane.id, 'row')}
        aria-label="Split pane"
        title="Split pane"
        className={`flex size-7 items-center justify-center self-center rounded text-faint hover:text-text-2 ${FOCUS}`}
      >
        <SplitSquareHorizontal size={15} strokeWidth={1.5} />
      </button>
    </div>
  )
}
