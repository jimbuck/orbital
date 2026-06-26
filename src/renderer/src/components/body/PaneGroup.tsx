import { useState } from 'react'
import { Orbit, Plus } from 'lucide-react'
import type { Flight, Pane } from '@shared/types'
import { useStore, activeFlight } from '@renderer/store'
import TabStrip from './TabStrip'
import TerminalTab from './TerminalTab'
import EditorTab from './EditorTab'
import BrowserTab from './BrowserTab'

/**
 * The tiled pane area — the main body of the cockpit. Lays out the active
 * Flight's panes with flex in the Flight's split direction, each pane carrying a
 * TabStrip on top of the active tab's body. Terminal tabs stay mounted (hidden)
 * when inactive so their PTY/xterm survive tab switches.
 */
export default function PaneGroup(): JSX.Element {
  const flight = useStore(activeFlight)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)

  if (!flight) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-bg text-faint">
        <Orbit size={26} strokeWidth={1.5} className="opacity-60" />
        <span className="text-sm">No Flight selected</span>
      </div>
    )
  }

  const dir = flight.splitDirection === 'row' ? 'flex-row' : 'flex-col'
  // The focused pane gets the accent inset ring; fall back to the first pane.
  const activePaneId = flight.panes.some((p) => p.id === focusedPaneId)
    ? focusedPaneId
    : (flight.panes[0]?.id ?? null)

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 gap-px bg-line ${dir}`}>
      {flight.panes.map((pane) => (
        <PaneView
          key={pane.id}
          pane={pane}
          flight={flight}
          active={pane.id === activePaneId}
          onFocus={() => setFocusedPaneId(pane.id)}
        />
      ))}
    </div>
  )
}

function PaneView({
  pane,
  flight,
  active,
  onFocus
}: {
  pane: Pane
  flight: Flight
  active: boolean
  onFocus: () => void
}): JSX.Element {
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]
  const terminals = pane.tabs.filter((t) => t.type === 'terminal')
  const ring = active ? 'shadow-[inset_0_0_0_1px_rgba(79,140,255,0.20)]' : ''

  return (
    <div
      onMouseDownCapture={onFocus}
      style={{ flexGrow: pane.flex, flexBasis: 0 }}
      className={`flex min-h-0 min-w-0 flex-col bg-pane ${ring}`}
    >
      <TabStrip pane={pane} flight={flight} />
      <div className="relative min-h-0 flex-1">
        {/* Terminals are always mounted; inactive ones are hidden to keep the PTY alive. */}
        {terminals.map((t) => (
          <div
            key={t.id}
            className={`absolute inset-0 ${activeTab && t.id === activeTab.id ? '' : 'hidden'}`}
          >
            <TerminalTab tab={t} />
          </div>
        ))}

        {/* Non-terminal tabs are only rendered while active. */}
        {activeTab && activeTab.type === 'editor' && (
          <div className="absolute inset-0">
            <EditorTab tab={activeTab} />
          </div>
        )}
        {activeTab && activeTab.type === 'browser' && (
          <div className="absolute inset-0">
            <BrowserTab tab={activeTab} />
          </div>
        )}

        {pane.tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <button
              onClick={() => window.orbital.createTab(flight.id, pane.id, 'terminal')}
              className="flex items-center gap-2 rounded-btn border border-line-2 bg-hover px-4 py-2.5 text-sm font-medium text-text-2 outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Plus size={15} strokeWidth={1.5} />
              Open a terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
