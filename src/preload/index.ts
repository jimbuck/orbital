import { contextBridge, ipcRenderer, clipboard, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type OrbitalApi,
  type AppState,
  type Settings,
  type Workspace,
  type Flight,
  type Tab,
  type Pane,
  type Task,
  type TabType,
  type TabConfig,
  type SplitDirection,
  type SplitWhere,
  type CreateFlightOptions,
  type RemoveFlightOptions,
  type TaskPatch,
  type WorkspaceAgentPatch,
  type ClaudeHooksStatus,
  type ClaudeHooksPlan,
  type GitStatus,
  type BranchInfo,
  type FileDiff,
  type FileNode,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalBuffer,
  type AlertEvent,
  type UpdateStatus
} from '@shared/types'

/** Subscribe to a main->renderer push channel; returns an unsubscribe fn. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: OrbitalApi = {
  // state
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<AppState>,
  setSettings: (settings: Settings) => ipcRenderer.invoke(IPC.setSettings, settings) as Promise<Settings>,

  // workspaces
  addWorkspace: () => ipcRenderer.invoke(IPC.addWorkspace) as Promise<Workspace | null>,
  removeWorkspace: (id: string) => ipcRenderer.invoke(IPC.removeWorkspace, id) as Promise<void>,
  renameWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke(IPC.renameWorkspace, id, name) as Promise<void>,

  // flights / panes / tabs
  createFlight: (workspaceId: string, opts: CreateFlightOptions) =>
    ipcRenderer.invoke(IPC.createFlight, workspaceId, opts) as Promise<Flight>,
  removeFlight: (flightId: string, opts: RemoveFlightOptions) =>
    ipcRenderer.invoke(IPC.removeFlight, flightId, opts) as Promise<void>,
  renameFlight: (flightId: string, name: string) =>
    ipcRenderer.invoke(IPC.renameFlight, flightId, name) as Promise<void>,
  clearFlightStatus: (flightId: string) =>
    ipcRenderer.invoke(IPC.clearFlightStatus, flightId) as Promise<void>,
  listBranches: (workspaceId: string) =>
    ipcRenderer.invoke(IPC.listBranches, workspaceId) as Promise<BranchInfo>,
  setWorkspaceAgent: (workspaceId: string, patch: WorkspaceAgentPatch) =>
    ipcRenderer.invoke(IPC.setWorkspaceAgent, workspaceId, patch) as Promise<void>,
  claudeHooksStatus: () => ipcRenderer.invoke(IPC.claudeHooksStatus) as Promise<ClaudeHooksStatus>,
  claudeHooksPlan: () => ipcRenderer.invoke(IPC.claudeHooksPlan) as Promise<ClaudeHooksPlan>,
  installClaudeHooks: () => ipcRenderer.invoke(IPC.installClaudeHooks) as Promise<ClaudeHooksStatus>,
  removeClaudeHooks: () => ipcRenderer.invoke(IPC.removeClaudeHooks) as Promise<ClaudeHooksStatus>,
  createTab: (flightId: string, paneId: string | null, type: TabType, config?: TabConfig) =>
    ipcRenderer.invoke(IPC.createTab, flightId, paneId, type, config) as Promise<Tab>,
  closeTab: (tabId: string) => ipcRenderer.invoke(IPC.closeTab, tabId) as Promise<void>,
  renameTab: (tabId: string, title: string) =>
    ipcRenderer.invoke(IPC.renameTab, tabId, title) as Promise<void>,
  setActiveTab: (paneId: string, tabId: string) =>
    ipcRenderer.invoke(IPC.setActiveTab, paneId, tabId) as Promise<void>,
  moveTab: (tabId: string, targetPaneId: string) =>
    ipcRenderer.invoke(IPC.moveTab, tabId, targetPaneId) as Promise<void>,
  splitPane: (flightId: string, paneId: string, dir: SplitDirection, where: SplitWhere) =>
    ipcRenderer.invoke(IPC.splitPane, flightId, paneId, dir, where) as Promise<Pane>,
  closePane: (flightId: string, paneId: string) =>
    ipcRenderer.invoke(IPC.closePane, flightId, paneId) as Promise<void>,
  moveTabToEdge: (tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom') =>
    ipcRenderer.invoke(IPC.moveTabToEdge, tabId, targetPaneId, edge) as Promise<void>,
  setSplitRatio: (flightId: string, splitId: string, ratio: number) =>
    ipcRenderer.invoke(IPC.setSplitRatio, flightId, splitId, ratio) as Promise<void>,

  // terminals (fire-and-forget)
  terminalInput: (tabId: string, data: string) => ipcRenderer.send(IPC.terminalInput, tabId, data),
  terminalResize: (tabId: string, cols: number, rows: number) =>
    ipcRenderer.send(IPC.terminalResize, tabId, cols, rows),
  terminalBuffer: (tabId: string) => ipcRenderer.invoke(IPC.terminalBuffer, tabId) as Promise<TerminalBuffer>,
  readClipboard: () => clipboard.readText(),

  // git
  gitStatus: (flightId: string) => ipcRenderer.invoke(IPC.gitStatus, flightId) as Promise<GitStatus>,
  gitStage: (flightId: string, path: string) => ipcRenderer.invoke(IPC.gitStage, flightId, path) as Promise<void>,
  gitUnstage: (flightId: string, path: string) =>
    ipcRenderer.invoke(IPC.gitUnstage, flightId, path) as Promise<void>,
  gitStageAll: (flightId: string) => ipcRenderer.invoke(IPC.gitStageAll, flightId) as Promise<void>,
  gitUnstageAll: (flightId: string) => ipcRenderer.invoke(IPC.gitUnstageAll, flightId) as Promise<void>,
  gitDiscard: (flightId: string, path: string) =>
    ipcRenderer.invoke(IPC.gitDiscard, flightId, path) as Promise<void>,
  gitDiscardAll: (flightId: string) => ipcRenderer.invoke(IPC.gitDiscardAll, flightId) as Promise<void>,
  gitCommit: (flightId: string, message: string, amend?: boolean) =>
    ipcRenderer.invoke(IPC.gitCommit, flightId, message, amend) as Promise<void>,
  gitLastCommitMessage: (flightId: string) =>
    ipcRenderer.invoke(IPC.gitLastCommitMessage, flightId) as Promise<string>,
  gitPush: (flightId: string) => ipcRenderer.invoke(IPC.gitPush, flightId) as Promise<void>,
  gitPull: (flightId: string) => ipcRenderer.invoke(IPC.gitPull, flightId) as Promise<void>,
  gitFetch: (flightId: string) => ipcRenderer.invoke(IPC.gitFetch, flightId) as Promise<void>,
  gitDiff: (flightId: string, path: string, staged: boolean) =>
    ipcRenderer.invoke(IPC.gitDiff, flightId, path, staged) as Promise<FileDiff>,
  fileTree: (flightId: string) => ipcRenderer.invoke(IPC.fileTree, flightId) as Promise<FileNode[]>,
  readFile: (flightId: string, path: string) =>
    ipcRenderer.invoke(IPC.readFile, flightId, path) as Promise<string>,
  readFileBase64: (flightId: string, path: string) =>
    ipcRenderer.invoke(IPC.readFileBase64, flightId, path) as Promise<string>,
  writeFile: (flightId: string, path: string, content: string) =>
    ipcRenderer.invoke(IPC.writeFile, flightId, path, content) as Promise<void>,

  // tasks
  createTask: (workspaceId: string, title: string, description?: string, tags?: string[]) =>
    ipcRenderer.invoke(IPC.createTask, workspaceId, title, description, tags) as Promise<Task>,
  updateTask: (taskId: string, patch: TaskPatch) =>
    ipcRenderer.invoke(IPC.updateTask, taskId, patch) as Promise<Task>,
  deleteTask: (taskId: string) => ipcRenderer.invoke(IPC.deleteTask, taskId) as Promise<void>,

  // browser / window
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  windowMinimize: () => ipcRenderer.send(IPC.windowMinimize),
  windowMaximize: () => ipcRenderer.send(IPC.windowMaximize),
  windowClose: () => ipcRenderer.send(IPC.windowClose),
  toggleDevTools: () => ipcRenderer.send(IPC.toggleDevTools),

  // updates
  getVersion: () => ipcRenderer.invoke(IPC.getVersion) as Promise<string>,
  updateStatus: () => ipcRenderer.invoke(IPC.updateStatus) as Promise<UpdateStatus>,
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateStatus>,
  installUpdate: () => ipcRenderer.send(IPC.updateInstall),

  // events
  onStateChanged: (cb: (state: AppState) => void) => on<AppState>(IPC.evtStateChanged, cb),
  onTerminalData: (cb: (evt: TerminalDataEvent) => void) => on<TerminalDataEvent>(IPC.evtTerminalData, cb),
  onTerminalExit: (cb: (evt: TerminalExitEvent) => void) => on<TerminalExitEvent>(IPC.evtTerminalExit, cb),
  onAlert: (cb: (evt: AlertEvent) => void) => on<AlertEvent>(IPC.evtAlert, cb),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => on<UpdateStatus>(IPC.evtUpdate, cb)
}

contextBridge.exposeInMainWorld('orbital', api)
