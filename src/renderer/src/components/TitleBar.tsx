import { useEffect, useState, type JSX } from 'react'
import { Minus, Square, X, ChevronRight, RefreshCw, Globe, Check } from 'lucide-react'
import { useStore, activeProject, activeWorktree } from '@renderer/store'
import { serverLabel } from './body/TabStrip'
import { editCopy, editPaste, editSelectAll } from '@renderer/lib/editActions'
import { setThemeMode, useResolvedTheme, useThemeMode, THEME_MODES } from '@renderer/lib/theme'

interface MenuItem {
  label: string
  onClick?: () => void
  disabled?: boolean
  sep?: boolean
  /**
   * Present (true OR false) turns the row into a `menuitemradio`: it renders a
   * check gutter and reports aria-checked. Absent leaves a plain `menuitem` with
   * no gutter, so the ordinary commands keep their existing look.
   */
  checked?: boolean
  /** Dimmed trailing text — used to show what 'System' currently resolves to. */
  hint?: string
  /** A non-interactive group caption (e.g. "Theme") rather than a command. */
  heading?: boolean
}
interface Menu {
  id: string
  label: string
  items: MenuItem[]
}

/**
 * Native (frameless) window titlebar: the Orbital brand + an app menu bar
 * (File / View / Help) on the left, the project ▸ worktree breadcrumb centered,
 * and the needs-attention banner + window controls on the right. The bar itself
 * is the drag region; interactive clusters opt out with `no-drag`.
 */
export default function TitleBar(): JSX.Element {
  const projName = useStore((s) => activeProject(s)?.name ?? 'orbital')
  const worktreeName = useStore((s) => activeWorktree(s)?.name)
  // Prefix the breadcrumb with the workspace only when it's a named one — the
  // implicit default profile workspace would just be noise.
  const workspaceName = useStore((s) => (s.workspace && s.workspace.name !== 'Default' ? s.workspace.name : null))
  const alertCount = useStore((s) => s.alertCount)
  const updateStatus = useStore((s) => s.updateStatus)
  const openModal = useStore((s) => s.openModal)
  const project = useStore(activeProject)

  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [devMenu, setDevMenu] = useState(false)

  // The picked mode drives the check mark; the resolved theme only annotates
  // 'System', so the menu shows which way "follow the OS" is currently leaning.
  const themeMode = useThemeMode()
  const resolvedTheme = useResolvedTheme()

  const activeWorktreeId = useStore((s) => s.activeWorktreeId)
  const servers = useStore((s) => (s.activeWorktreeId ? s.devServers[s.activeWorktreeId] : undefined)) ?? []

  const openServer = (url: string): void => {
    setDevMenu(false)
    if (activeWorktreeId) void window.orbital.createTab(activeWorktreeId, null, 'browser', { url })
  }

  // Escape closes an open menu (WAI-ARIA menu-button pattern).
  useEffect(() => {
    if (!openMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openMenu])

  const menus: Menu[] = [
    {
      id: 'file',
      label: 'File',
      items: [
        { label: 'Add Project…', onClick: () => openModal('addProject') },
        { label: 'New Worktree…', onClick: () => openModal('newWorktree', { project }), disabled: !project },
        { sep: true, label: '' },
        { label: 'Workspaces…', onClick: () => openModal('workspaces') },
        { label: 'Settings…', onClick: () => openModal('settings') },
        { sep: true, label: '' },
        { label: 'Quit', onClick: () => window.orbital.windowClose() }
      ]
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { label: 'Copy', onClick: editCopy },
        { label: 'Paste', onClick: editPaste },
        { sep: true, label: '' },
        { label: 'Select All', onClick: editSelectAll }
      ]
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { label: 'All Tasks…', onClick: () => openModal('board') },
        { label: 'Reload', onClick: () => window.location.reload() },
        { label: 'Toggle Developer Tools', onClick: () => window.orbital.toggleDevTools() },
        { sep: true, label: '' },
        { label: 'Theme', heading: true },
        // Applies (and persists) on click through the same path the Settings
        // modal uses, so the two controls always agree.
        ...THEME_MODES.map<MenuItem>((mode) => ({
          label: mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark',
          checked: themeMode === mode,
          hint: mode === 'system' ? resolvedTheme : undefined,
          onClick: () => setThemeMode(mode)
        }))
      ]
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        {
          label: 'Check for Updates…',
          onClick: () => {
            void window.orbital.checkForUpdates()
            openModal('about')
          }
        },
        { sep: true, label: '' },
        { label: 'About Orbital', onClick: () => openModal('about') }
      ]
    }
  ]

  const choose = (item: MenuItem): void => {
    if (item.disabled) return
    setOpenMenu(null)
    item.onClick?.()
  }

  const ctrl =
    'flex h-full w-[46px] items-center justify-center text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60'

  return (
    // The border is the header's own border-b, and every child (menu buttons,
    // window controls) is h-full — i.e. the 33px content box — so opaque child
    // backgrounds can never paint over the hairline.
    <header className="drag-region relative flex h-[34px] flex-none items-center justify-between border-b border-line bg-bar pl-[14px]">
      {/* Left: brand + app menu bar. bg-bar so the centered breadcrumb is occluded
          here rather than visually colliding at narrow widths. */}
      <div className="no-drag z-50 flex h-full items-center gap-2.5 bg-bar">
        <div className="relative size-[15px] flex-none">
          <div className="absolute inset-0 rounded-full border-[1.2px] border-accent/55" />
          <div className="absolute left-1/2 top-1/2 -ml-[2.5px] -mt-[2.5px] size-[5px] rounded-full bg-accent shadow-[0_0_7px_rgba(79,140,255,0.9)]" />
        </div>
        <span className="text-[12px] font-semibold tracking-[0.2px]">Orbital</span>

        <nav className="flex h-full items-center">
          {menus.map((m) => (
            <div key={m.id} className="relative h-full">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenu === m.id}
                // Don't take focus: Edit-menu copy/paste act on whatever the user
                // was editing (a terminal or input), so focus must stay put.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setOpenMenu((o) => (o === m.id ? null : m.id))}
                onMouseEnter={() => setOpenMenu((o) => (o ? m.id : o))}
                className={`flex h-full items-center px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  openMenu === m.id ? 'bg-hover text-text' : 'text-text-3 hover:text-text'
                }`}
              >
                {m.label}
              </button>

              {openMenu === m.id && (
                <div
                  role="menu"
                  className="absolute left-0 top-[34px] z-50 min-w-[210px] rounded-b-[9px] border border-line-strong bg-elev p-1 elev-menu"
                >
                  {m.items.map((it, i) =>
                    it.sep ? (
                      <div key={i} role="separator" className="my-1 h-px bg-soft" />
                    ) : it.heading ? (
                      <div
                        key={i}
                        role="presentation"
                        className="px-2.5 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-[0.6px] text-faint"
                      >
                        {it.label}
                      </div>
                    ) : (
                      <button
                        key={i}
                        type="button"
                        role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                        aria-checked={it.checked}
                        disabled={it.disabled}
                        // Preserve focus (see the menu button above) so Edit
                        // actions target the terminal/input, not this menuitem.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(it)}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium text-text-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent"
                      >
                        {/* Reserve the gutter on every radio row so the labels
                            line up whether or not that row is the selected one. */}
                        {it.checked !== undefined && (
                          <Check
                            size={12}
                            strokeWidth={2.5}
                            aria-hidden
                            className={`flex-none text-accent ${it.checked ? '' : 'invisible'}`}
                          />
                        )}
                        <span className="min-w-0 truncate">{it.label}</span>
                        {it.hint && <span className="ml-auto flex-none text-[11px] text-faint">{it.hint}</span>}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </nav>
      </div>

      {/* Center: workspace ▸ project ▸ worktree breadcrumb (non-interactive, so dragging still works) */}
      <div className="pointer-events-none absolute left-1/2 top-0 flex h-full max-w-[40%] -translate-x-1/2 items-center">
        <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-dim">
          {workspaceName && (
            <>
              <span className="truncate text-faint">{workspaceName}</span>
              <ChevronRight size={12} strokeWidth={1.5} className="flex-none text-faint" />
            </>
          )}
          <span className="truncate">{projName}</span>
          {worktreeName && (
            <>
              <ChevronRight size={12} strokeWidth={1.5} className="flex-none text-faint" />
              <span className="truncate text-text-3">{worktreeName}</span>
            </>
          )}
        </span>
      </div>

      {/* Right: needs-attention banner + window controls. bg-bar occludes the
          centered breadcrumb; clicking here also dismisses any open menu. */}
      <div className="no-drag z-50 flex h-full items-center gap-1 bg-bar" onClick={() => setOpenMenu(null)}>
        {servers.length > 0 && (
          <div className="relative mr-2">
            <button
              type="button"
              title="Live dev servers in this Worktree — click to open one in a browser tab"
              aria-haspopup="menu"
              aria-expanded={devMenu}
              onClick={() => setDevMenu((v) => !v)}
              className="flex items-center gap-[7px] rounded-[7px] border border-green/25 bg-green/10 py-[3px] pl-2 pr-[9px] outline-none hover:bg-green/20 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Globe size={11} strokeWidth={2} className="flex-none text-green-2" />
              <span className="whitespace-nowrap text-[11px] font-semibold text-green-2">
                {servers.length} dev server{servers.length === 1 ? '' : 's'}
              </span>
            </button>
            {devMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setDevMenu(false)} />
                <div
                  role="menu"
                  className="absolute right-0 top-[30px] z-50 min-w-[190px] rounded-[9px] border border-line-strong bg-elev p-1 elev-menu"
                >
                  {servers.map((url) => (
                    <button
                      key={url}
                      type="button"
                      role="menuitem"
                      title={url}
                      onClick={() => openServer(url)}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[11.5px] text-text-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <span className="relative size-[7px] flex-none">
                        <span className="absolute inset-0 rounded-full bg-green animate-pulse-dot" />
                      </span>
                      <span className="truncate">{serverLabel(url)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {updateStatus.phase === 'ready' && (
          <button
            type="button"
            title={`Orbital ${updateStatus.version} has been downloaded — restart to apply it`}
            onClick={() => window.orbital.installUpdate()}
            className="mr-2 flex items-center gap-[7px] rounded-[7px] border border-accent/30 bg-accent/12 py-[3px] pl-2 pr-[9px] outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <RefreshCw size={11} strokeWidth={2} className="flex-none text-accent" />
            <span className="whitespace-nowrap text-[11px] font-semibold text-accent">Restart to update</span>
          </button>
        )}
        {alertCount > 0 && (
          <div className="mr-2 flex items-center gap-[7px] rounded-[7px] border border-amber/25 bg-amber/12 py-[3px] pl-2 pr-[9px]">
            <span className="relative size-[7px] flex-none">
              <span className="absolute inset-0 rounded-full bg-amber animate-pulse-dot" />
            </span>
            <span className="whitespace-nowrap text-[11px] font-semibold text-amber-2">
              {alertCount} {alertCount === 1 ? 'agent needs' : 'agents need'} you
            </span>
          </div>
        )}
        <button type="button" aria-label="Minimize" onClick={() => window.orbital.windowMinimize()} className={ctrl}>
          <Minus size={16} strokeWidth={1.5} />
        </button>
        <button type="button" aria-label="Maximize" onClick={() => window.orbital.windowMaximize()} className={ctrl}>
          <Square size={13} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => window.orbital.windowClose()}
          className="flex h-full w-[46px] items-center justify-center text-muted outline-none hover:bg-[#c4314b] hover:text-white focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>

      {/* Click-away backdrop while a menu is open. */}
      {openMenu && <div className="no-drag fixed inset-0 z-40" onClick={() => setOpenMenu(null)} />}
    </header>
  )
}
