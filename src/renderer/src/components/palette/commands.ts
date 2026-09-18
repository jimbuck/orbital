import type { ComponentType } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  Columns2,
  CornerDownLeft,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Hash,
  History,
  Info,
  KanbanSquare,
  LayoutGrid,
  ListPlus,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  SplitSquareHorizontal,
  SplitSquareVertical,
  SquareTerminal,
  Sun,
  TextSearch,
  Terminal,
  Trash2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { AgentConfig, Pane, Tab, TabType, ThemeMode, Worktree } from '@shared/types'
import { OPEN_ACTIONS, defaultAgentConfigs } from '@shared/types'
import { useStore, activePaneId, type Store } from '@renderer/store'
import { fireAndForget } from '@renderer/lib/bridge'
import { openTab } from '@renderer/lib/openTab'
import { editCopy, editPaste, editSelectAll } from '@renderer/lib/editActions'
import { setFontLigatures, setThemeMode, systemThemeId, themeModeLabel } from '@renderer/lib/theme'
import { THEMES } from '@shared/themes'

/**
 * Everything the command palette can DO, as plain records.
 *
 * The list is rebuilt from store state on each render of an open palette, which
 * is what lets rows carry live values — the agent profiles this workspace has
 * configured, the Worktree's dev servers, the current zoom and theme. Nothing
 * here renders; the palette turns these into rows.
 *
 * Deliberately absent: the destructive git operations (discard, remove
 * Worktree, delete task). A palette is a place you arrive at by typing three
 * letters and pressing Enter, and "Discard All Changes" three letters away from
 * "Stage All Changes" is a trap, not a feature. Those keep their confirm-backed
 * homes in the git panel and the rail menus.
 */

export type IconType = ComponentType<{
  size?: number | string
  strokeWidth?: number | string
  className?: string
}>

export interface PaletteCommand {
  /** Stable key, unique across the list. */
  id: string
  /** Section heading the row groups under. */
  group: string
  label: string
  /** Dim trailing text: a keyboard hint, or the value the command would set. */
  hint?: string
  /** Folded into the fuzzy match but never shown — synonyms and aliases. */
  keywords?: string
  icon: IconType
  /** Present (true or false) renders a check gutter, as the View menu does. */
  checked?: boolean
  run: () => void
  /** Keep the palette open after running — the rows that switch its mode. */
  keepOpen?: boolean
}

/** The pane a pane-scoped command acts on: the one the user last worked in. */
function currentPane(s: Store, worktree: Worktree | undefined): Pane | undefined {
  if (!worktree) return undefined
  const id = activePaneId(s, worktree.id)
  return worktree.panes.find((p) => p.id === id) ?? worktree.panes[0]
}

/** That pane's visible tab. */
function currentTab(pane: Pane | undefined): Tab | undefined {
  if (!pane) return undefined
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]
}

/** Icon for a tab type an opener creates. */
const TAB_ICONS: Record<TabType, IconType> = {
  terminal: Terminal,
  browser: Globe,
  editor: FileText,
  agent: SquareTerminal,
  search: TextSearch
}

export interface BuildContext {
  /** Seed the palette's own query — how the "search for…" rows switch mode. */
  setQuery: (query: string) => void
}

/**
 * Build the command list from the current store snapshot. Reads state directly
 * rather than taking it as arguments: the list spans a dozen slices of the
 * store, and threading each one through would be noise around the part that
 * matters, which is the commands themselves.
 */
export function buildCommands(ctx: BuildContext): PaletteCommand[] {
  const s = useStore.getState()
  const worktree = s.worktrees.find((w) => w.id === s.activeWorktreeId)
  const project = s.projects.find((p) => p.id === s.activeProjectId)
  const pane = currentPane(s, worktree)
  const tab = currentTab(pane)
  const agents: AgentConfig[] = s.settings?.agents ?? defaultAgentConfigs()
  const servers = worktree ? (s.devServers[worktree.id] ?? []) : []
  const openAction = s.settings?.defaultOpenAction ?? 'right'
  const wid = worktree?.id

  const out: PaletteCommand[] = []
  const add = (c: PaletteCommand): void => {
    out.push(c)
  }

  /* ---- Search modes ---------------------------------------------------- */
  add({
    id: 'search.files',
    group: 'Search',
    label: 'Go to File…',
    hint: 'type a name',
    keywords: 'open find quick',
    icon: Search,
    keepOpen: true,
    run: () => ctx.setQuery('')
  })
  add({
    id: 'search.content',
    group: 'Search',
    label: 'Search in Files…',
    hint: '/',
    keywords: 'grep text content find in files full text',
    icon: TextSearch,
    keepOpen: true,
    run: () => ctx.setQuery('/')
  })
  add({
    id: 'search.worktrees',
    group: 'Search',
    label: 'Go to Worktree…',
    hint: '@',
    keywords: 'switch project jump',
    icon: GitBranch,
    keepOpen: true,
    run: () => ctx.setQuery('@')
  })
  add({
    id: 'search.tasks',
    group: 'Search',
    label: 'Go to Task…',
    hint: '#',
    keywords: 'issue board find',
    icon: Hash,
    keepOpen: true,
    run: () => ctx.setQuery('#')
  })

  /* ---- Tabs ------------------------------------------------------------ */
  if (wid) {
    const opener = (id: string, label: string, type: TabType, config?: Record<string, unknown>): void =>
      add({
        id,
        group: 'Tabs',
        label,
        keywords: 'new open create tab',
        icon: TAB_ICONS[type],
        run: () => fireAndForget(openTab(wid, type, config))
      })
    opener('tab.terminal', 'New Terminal', 'terminal')
    for (const agent of agents) {
      opener(`tab.agent.${agent.id}`, `New ${agent.name} Session`, 'agent', { agentId: agent.id })
    }
    opener('tab.editor', 'New Editor', 'editor')
    opener('tab.browser', 'New Browser', 'browser')
    opener('tab.search', 'New Search', 'search')

    for (const url of servers) {
      add({
        id: `tab.server.${url}`,
        group: 'Tabs',
        label: `Open Dev Server ${url}`,
        keywords: 'localhost preview browser',
        icon: Globe,
        run: () => fireAndForget(openTab(wid, 'browser', { url }))
      })
    }

    if (tab) {
      add({
        id: 'tab.close',
        group: 'Tabs',
        label: 'Close Active Tab',
        icon: X,
        run: () => fireAndForget(window.orbital.closeTab(tab.id))
      })
    }
  }

  /* ---- Panes ----------------------------------------------------------- */
  if (wid && pane) {
    add({
      id: 'pane.splitRight',
      group: 'Panes',
      label: 'Split Pane Across',
      keywords: 'vertical right side by side',
      icon: SplitSquareHorizontal,
      run: () => fireAndForget(window.orbital.splitPane(wid, pane.id, 'row', 'after'))
    })
    add({
      id: 'pane.splitDown',
      group: 'Panes',
      label: 'Split Pane Below',
      keywords: 'horizontal bottom stack',
      icon: SplitSquareVertical,
      run: () => fireAndForget(window.orbital.splitPane(wid, pane.id, 'column', 'after'))
    })
    if ((worktree?.panes.length ?? 0) > 1) {
      add({
        id: 'pane.close',
        group: 'Panes',
        label: 'Close Pane',
        icon: Columns2,
        run: () => fireAndForget(window.orbital.closePane(wid, pane.id))
      })
    }
  }

  /* ---- Git ------------------------------------------------------------- */
  if (wid) {
    const git = (id: string, label: string, keywords: string, icon: IconType, call: () => Promise<void>): void =>
      add({ id, group: 'Git', label, keywords, icon, run: () => fireAndForget(call()) })
    git('git.stageAll', 'Stage All Changes', 'add index', Plus, () => window.orbital.gitStageAll(wid))
    git('git.unstageAll', 'Unstage All Changes', 'reset index', Minus, () => window.orbital.gitUnstageAll(wid))
    git('git.push', 'Push', 'upload remote origin', ArrowUpFromLine, () => window.orbital.gitPush(wid))
    git('git.pull', 'Pull', 'download remote origin', ArrowDownToLine, () => window.orbital.gitPull(wid))
    git('git.fetch', 'Fetch', 'remote origin refresh', RefreshCw, () => window.orbital.gitFetch(wid))
    add({
      id: 'git.history',
      group: 'Git',
      label: 'Commit History…',
      keywords: 'log commits graph',
      icon: GitCommitHorizontal,
      run: () => s.openModal('commitHistory')
    })
  }

  /* ---- Worktree -------------------------------------------------------- */
  if (wid) {
    add({
      id: 'worktree.explorer',
      group: 'Worktree',
      label: 'Open in File Explorer',
      keywords: 'reveal folder finder',
      icon: FolderOpen,
      run: () => fireAndForget(window.orbital.openPath(wid, ''))
    })
    add({
      id: 'worktree.terminal',
      group: 'Worktree',
      label: 'Open in External Terminal',
      keywords: 'shell powershell windows terminal',
      icon: SquareTerminal,
      run: () => fireAndForget(window.orbital.openInTerminal(wid, ''))
    })
    add({
      id: 'worktree.syncEnv',
      group: 'Worktree',
      label: 'Sync Environment Files',
      keywords: 'env copy dotenv',
      icon: RotateCcw,
      run: () => fireAndForget(window.orbital.syncWorktreeEnv(wid))
    })
    add({
      id: 'worktree.clearStatus',
      group: 'Worktree',
      label: 'Clear Worktree Status',
      keywords: 'idle reset attention alert',
      icon: Trash2,
      run: () => fireAndForget(window.orbital.clearWorktreeStatus(wid))
    })
  }
  add({
    id: 'worktree.new',
    group: 'Worktree',
    label: 'New Worktree…',
    keywords: 'branch create checkout',
    icon: GitBranch,
    run: () => s.openModal('newWorktree', { project })
  })

  /* ---- Project & workspace --------------------------------------------- */
  add({
    id: 'project.add',
    group: 'Project',
    label: 'Add Project…',
    keywords: 'repo clone folder open',
    icon: FolderPlus,
    run: () => s.openModal('addProject')
  })
  if (project) {
    add({
      id: 'project.explorer',
      group: 'Project',
      label: 'Open Project in File Explorer',
      keywords: 'reveal folder repo',
      icon: FolderOpen,
      run: () => fireAndForget(window.orbital.openProjectPath(project.id))
    })
    add({
      id: 'project.terminal',
      group: 'Project',
      label: 'Open Project in External Terminal',
      keywords: 'shell repo',
      icon: SquareTerminal,
      run: () => fireAndForget(window.orbital.openProjectInTerminal(project.id))
    })
  }
  add({
    id: 'workspace.manage',
    group: 'Project',
    label: 'Workspaces…',
    keywords: 'switch import export',
    icon: Boxes,
    run: () => s.openModal('workspaces')
  })

  /* ---- Tasks ----------------------------------------------------------- */
  add({
    id: 'task.board',
    group: 'Tasks',
    label: 'All Tasks…',
    keywords: 'board kanban',
    icon: KanbanSquare,
    run: () => s.openModal('board')
  })
  if (project) {
    add({
      id: 'task.new',
      group: 'Tasks',
      label: 'New Task…',
      keywords: 'create add todo',
      icon: ListPlus,
      // Created first, then opened for editing: the task modal edits an
      // existing task (it has no create mode), and a task row that exists is
      // also what the board and the CLI can already see.
      run: () =>
        fireAndForget(
          window.orbital.createTask(project.id, 'New task').then((task) => s.openModal('editTask', { task }))
        )
    })
  }

  /* ---- View ------------------------------------------------------------ */
  add({
    id: 'view.settings',
    group: 'View',
    label: 'Settings…',
    keywords: 'preferences options config',
    icon: SettingsIcon,
    run: () => s.openModal('settings')
  })
  add({
    id: 'view.zoomIn',
    group: 'View',
    label: 'Zoom In',
    hint: 'Ctrl +',
    icon: ZoomIn,
    run: () => window.orbital.zoomIn()
  })
  add({
    id: 'view.zoomOut',
    group: 'View',
    label: 'Zoom Out',
    hint: 'Ctrl −',
    icon: ZoomOut,
    run: () => window.orbital.zoomOut()
  })
  add({
    id: 'view.zoomReset',
    group: 'View',
    label: 'Reset Zoom',
    hint: `${Math.round(s.zoomFactor * 100)}%`,
    icon: LayoutGrid,
    run: () => window.orbital.zoomReset()
  })
  // Every theme gets its own command. The palette is a search box, so twenty
  // rows cost nothing to someone who types "drac" and everything to someone who
  // would otherwise have to remember the theme lives three modals deep.
  const themeModes: ThemeMode[] = ['system', ...THEMES.map((t) => t.id)]
  for (const mode of themeModes) {
    const spec = mode === 'system' ? null : THEMES.find((t) => t.id === mode)
    add({
      id: `view.theme.${mode}`,
      group: 'View',
      label: `Theme: ${themeModeLabel(mode)}`,
      keywords: `appearance colour color ${spec ? spec.appearance : 'dark light os'}`,
      icon: Sun,
      // System names the half of the pair it would pick, so the row is not a
      // blind choice; which half is a question for the OS, not the settings.
      hint: spec ? undefined : themeModeLabel(systemThemeId()),
      checked: (s.settings?.theme ?? 'dark') === mode,
      run: () => setThemeMode(mode)
    })
  }
  add({
    id: 'view.ligatures',
    group: 'View',
    label: 'Code Ligatures',
    keywords: 'font glyph jetbrains mono arrow appearance',
    icon: Sun,
    checked: s.settings?.fontLigatures ?? true,
    run: () => setFontLigatures(!(s.settings?.fontLigatures ?? true))
  })
  for (const action of OPEN_ACTIONS) {
    add({
      id: `view.openAction.${action.value}`,
      group: 'View',
      label: `Open Tabs In: ${action.label}`,
      keywords: 'default open action pane placement split',
      icon: CornerDownLeft,
      checked: openAction === action.value,
      run: () => fireAndForget(window.orbital.setSettings({ defaultOpenAction: action.value }))
    })
  }
  add({
    id: 'view.reload',
    group: 'View',
    label: 'Reload Window',
    hint: 'Ctrl Shift R',
    keywords: 'refresh restart',
    icon: RefreshCw,
    run: () => window.location.reload()
  })
  add({
    id: 'view.devtools',
    group: 'View',
    label: 'Toggle Developer Tools',
    keywords: 'inspect console debug',
    icon: History,
    run: () => window.orbital.toggleDevTools()
  })

  /* ---- Edit ------------------------------------------------------------ */
  // These act on whatever had focus before the palette opened, which the
  // palette restores on close — see CommandPalette's focus handling.
  add({ id: 'edit.copy', group: 'Edit', label: 'Copy', icon: FileText, run: editCopy })
  add({ id: 'edit.paste', group: 'Edit', label: 'Paste', icon: FileText, run: editPaste })
  add({ id: 'edit.selectAll', group: 'Edit', label: 'Select All', icon: FileText, run: editSelectAll })

  /* ---- Help ------------------------------------------------------------ */
  add({
    id: 'help.updates',
    group: 'Help',
    label: 'Check for Updates…',
    keywords: 'version upgrade',
    icon: Download,
    run: () => {
      fireAndForget(window.orbital.checkForUpdates())
      s.openModal('about')
    }
  })
  add({
    id: 'help.logs',
    group: 'Help',
    label: 'Open Log Folder',
    keywords: 'debug diagnostics',
    icon: FolderOpen,
    run: () => fireAndForget(window.orbital.openLogFolder())
  })
  add({
    id: 'help.about',
    group: 'Help',
    label: 'About Orbital',
    keywords: 'version',
    icon: Info,
    run: () => s.openModal('about')
  })

  return out
}
