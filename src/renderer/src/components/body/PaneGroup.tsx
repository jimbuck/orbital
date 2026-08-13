import { useEffect, useRef, useState, type ComponentType, type JSX } from 'react'
import { Orbit, Terminal, Globe, FileText } from 'lucide-react'
import type { Worktree, Pane, LayoutNode, DropEdge, TabConfig, TabType } from '@shared/types'
import { defaultAgentConfigs } from '@shared/types'
import { ClaudeIcon, CodexIcon, CursorIcon, type BrandIconProps } from '../icons'
import { useStore, activeWorktree } from '@renderer/store'
import TabStrip from './TabStrip'
import TerminalTab from './TerminalTab'
import EditorTab from './EditorTab'
import BrowserTab from './BrowserTab'

/** Custom drag MIME carrying a tab id, so only Orbital tab-drags trigger drop zones. */
export const TAB_DND = 'application/x-orbital-tab'

/**
 * The tiled pane area — the main body of the cockpit. Renders the active
 * Worktree's binary layout tree: split nodes become resizable flex containers,
 * pane leaves render a TabStrip over the active tab. Tabs can be dragged between
 * panes; dropping near an edge splits the target toward that edge.
 */
export default function PaneGroup(): JSX.Element {
  const worktree = useStore(activeWorktree)

  if (!worktree) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-bg text-faint">
        <Orbit size={26} strokeWidth={1.5} className="opacity-60" />
        <span className="text-sm">No Worktree selected</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-bg">
      {worktree.layout ? (
        <LayoutView node={worktree.layout} worktree={worktree} />
      ) : (
        // Defensive fallback if the layout tree is momentarily absent.
        worktree.panes.map((p) => <PaneView key={p.id} pane={p} worktree={worktree} />)
      )}
    </div>
  )
}

function LayoutView({ node, worktree }: { node: LayoutNode; worktree: Worktree }): JSX.Element | null {
  if (!node) return null
  if (node.type === 'pane') {
    const pane = worktree.panes.find((p) => p.id === node.paneId)
    return pane ? <PaneView pane={pane} worktree={worktree} /> : null
  }
  return <SplitView node={node} worktree={worktree} />
}

function SplitView({
  node,
  worktree
}: {
  node: Extract<LayoutNode, { type: 'split' }>
  worktree: Worktree
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const isRow = node.dir === 'row'
  const ratio = dragRatio ?? node.ratio

  // Detach an in-flight drag's window listeners if the split unmounts mid-drag.
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const el = ref.current
    if (!el) return
    const fracAt = (clientX: number, clientY: number): number => {
      const rect = el.getBoundingClientRect()
      const r = isRow ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height
      return Math.min(0.9, Math.max(0.1, r))
    }
    const move = (ev: MouseEvent): void => setDragRatio(fracAt(ev.clientX, ev.clientY))
    const stop = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragCleanup.current = null
    }
    const up = (ev: MouseEvent): void => {
      stop()
      const final = fracAt(ev.clientX, ev.clientY)
      setDragRatio(null)
      void window.orbital.setSplitRatio(worktree.id, node.id, final)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    dragCleanup.current = stop
  }

  return (
    <div ref={ref} className={`flex min-h-0 min-w-0 flex-1 ${isRow ? 'flex-row' : 'flex-col'}`}>
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flexGrow: ratio, flexBasis: 0 }}>
        <LayoutView node={node.a} worktree={worktree} />
      </div>
      <div
        onMouseDown={startResize}
        role="separator"
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
        className={`group relative z-10 flex-none bg-line transition-colors hover:bg-accent/50 ${
          isRow ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
        } ${dragRatio !== null ? 'bg-accent/60' : ''}`}
      />
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flexGrow: 1 - ratio, flexBasis: 0 }}>
        <LayoutView node={node.b} worktree={worktree} />
      </div>
    </div>
  )
}

function computeEdge(el: HTMLElement, clientX: number, clientY: number): DropEdge {
  const rect = el.getBoundingClientRect()
  const fx = (clientX - rect.left) / rect.width
  const fy = (clientY - rect.top) / rect.height
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }
  const min = Math.min(d.left, d.right, d.top, d.bottom)
  if (min >= 0.25) return 'center'
  if (min === d.left) return 'left'
  if (min === d.right) return 'right'
  if (min === d.top) return 'top'
  return 'bottom'
}

/** Non-agent openers an empty pane offers; the workspace's configured agents slot in after Terminal. */
const OPENERS: { type: TabType; label: string; Icon: ComponentType<BrandIconProps>; config?: TabConfig }[] = [
  { type: 'terminal', label: 'Terminal', Icon: Terminal },
  { type: 'browser', label: 'Browser', Icon: Globe },
  { type: 'editor', label: 'Editor', Icon: FileText }
]

/** Brand icon per agent provider (Claude's doubles as the unknown-provider fallback). */
const AGENT_ICONS: Record<string, ComponentType<BrandIconProps>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  cursor: CursorIcon
}

const OVERLAY_POS: Record<DropEdge, string> = {
  center: 'inset-0',
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  top: 'inset-x-0 top-0 h-1/2',
  bottom: 'inset-x-0 bottom-0 h-1/2'
}

function PaneView({ pane, worktree }: { pane: Pane; worktree: Worktree }): JSX.Element {
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]
  // Terminal AND agent tabs are PTY-backed and share the xterm view; keep both
  // mounted (hidden when inactive) so their PTYs survive tab switches.
  const ptyTabs = pane.tabs.filter((t) => t.type === 'terminal' || t.type === 'agent')
  // Editor tabs keep in-memory-only state (selected file, unsaved draft, tree
  // expansion, view mode, scroll); keep them mounted (hidden when inactive) so
  // that state survives switching away and back.
  const editorTabs = pane.tabs.filter((t) => t.type === 'editor')
  // The workspace's agent profiles (Settings → Agents) fill the agent openers,
  // in list order. Undefined (state not loaded yet) means the default lineup.
  const agents = useStore((s) => s.settings?.agents) ?? defaultAgentConfigs()
  const openers = [
    OPENERS[0],
    ...agents.map((a) => ({
      type: 'agent' as TabType,
      label: a.name,
      Icon: AGENT_ICONS[a.provider] ?? ClaudeIcon,
      config: { agentId: a.id }
    })),
    ...OPENERS.slice(1)
  ]

  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(TAB_DND) || !bodyRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropEdge(computeEdge(bodyRef.current, e.clientX, e.clientY))
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(TAB_DND) || !bodyRef.current) return
    e.preventDefault()
    const tabId = e.dataTransfer.getData(TAB_DND)
    const edge = computeEdge(bodyRef.current, e.clientX, e.clientY)
    setDropEdge(null)
    if (!tabId) return
    if (edge === 'center') void window.orbital.moveTab(tabId, pane.id)
    else void window.orbital.moveTabToEdge(tabId, pane.id, edge)
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropEdge(null)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-pane">
      <TabStrip pane={pane} worktree={worktree} />
      <div ref={bodyRef} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave} className="relative min-h-0 flex-1">
        {/* PTY-backed tabs (terminal + agent) stay mounted so their PTY survives switches. */}
        {ptyTabs.map((t) => {
          const isActive = !!activeTab && t.id === activeTab.id
          return (
            <div key={t.id} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>
              {/* `active` also tells the terminal to take keyboard focus when shown. */}
              <TerminalTab tab={t} active={isActive} />
            </div>
          )
        })}

        {/* Editor tabs stay mounted so their in-memory state survives switches.
            Keyed by tab id: without it React reuses the instance across editor
            tabs, so a newly created tab kept showing the previous tab's file. */}
        {editorTabs.map((t) => {
          const isActive = !!activeTab && t.id === activeTab.id
          return (
            <div key={t.id} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>
              {/* `active` lets a hidden editor pause its background tree refetches. */}
              <EditorTab tab={t} active={isActive} />
            </div>
          )
        })}
        {activeTab && activeTab.type === 'browser' && (
          <div className="absolute inset-0">
            <BrowserTab tab={activeTab} />
          </div>
        )}

        {pane.tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5">
            <span className="text-xs text-faint">Open a tab in this pane</span>
            <div className="flex items-center gap-2">
              {openers.map(({ type, label, Icon, config }) => (
                <button
                  key={label}
                  onClick={() => window.orbital.createTab(worktree.id, pane.id, type, config)}
                  className="flex w-[84px] flex-col items-center gap-2 rounded-btn border border-line-2 bg-hover px-3 py-3.5 text-text-2 outline-none transition-colors hover:border-line-strong hover:bg-panel-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <Icon size={18} strokeWidth={1.5} />
                  <span className="text-[11px] font-medium">{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {dropEdge && (
          <div className="pointer-events-none absolute inset-0 z-20">
            <div className={`absolute ${OVERLAY_POS[dropEdge]} rounded-sm border border-accent/60 bg-accent/15`} />
          </div>
        )}
      </div>
    </div>
  )
}
