import { contextBridge, ipcRenderer, clipboard, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type OrbitalApi,
  type AppState,
  type Settings,
  type SettingsPatch,
  type Project,
  type Worktree,
  type Tab,
  type Pane,
  type Task,
  type TabType,
  type TabConfig,
  type SplitDirection,
  type SplitWhere,
  type CreateWorktreeOptions,
  type RemoveWorktreeOptions,
  type TaskPatch,
  type ProjectAgentPatch,
  type ProfileDirInfo,
  type ClaudeHooksStatus,
  type ClaudeHooksPlan,
  type ClaudeSkillStatus,
  type ClaudeSkillPlan,
  type CodexInstructionsStatus,
  type CodexInstructionsPlan,
  type GitStatus,
  type BranchInfo,
  type FileDiff,
  type FileNode,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalBuffer,
  type AlertEvent,
  type UpdateStatus,
  type WorkspaceInfo
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
  setSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.setSettings, patch) as Promise<Settings>,

  // workspaces
  listWorkspaces: () => ipcRenderer.invoke(IPC.listWorkspaces) as Promise<WorkspaceInfo[]>,
  openWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(IPC.openWorkspace, workspaceId) as Promise<WorkspaceInfo | null>,
  createWorkspace: (name: string) => ipcRenderer.invoke(IPC.createWorkspace, name) as Promise<WorkspaceInfo | null>,
  renameWorkspace: (workspaceId: string, name: string) =>
    ipcRenderer.invoke(IPC.renameWorkspace, workspaceId, name) as Promise<void>,
  removeWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(IPC.removeWorkspace, workspaceId) as Promise<WorkspaceInfo[]>,
  exportWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(IPC.exportWorkspace, workspaceId) as Promise<string | null>,
  importWorkspace: () => ipcRenderer.invoke(IPC.importWorkspace) as Promise<WorkspaceInfo | null>,

  // projects
  addProject: () => ipcRenderer.invoke(IPC.addProject) as Promise<Project | null>,
  removeProject: (id: string) => ipcRenderer.invoke(IPC.removeProject, id) as Promise<void>,
  renameProject: (id: string, name: string) =>
    ipcRenderer.invoke(IPC.renameProject, id, name) as Promise<void>,

  // worktrees / panes / tabs
  createWorktree: (projectId: string, opts: CreateWorktreeOptions) =>
    ipcRenderer.invoke(IPC.createWorktree, projectId, opts) as Promise<Worktree>,
  removeWorktree: (worktreeId: string, opts: RemoveWorktreeOptions) =>
    ipcRenderer.invoke(IPC.removeWorktree, worktreeId, opts) as Promise<void>,
  renameWorktree: (worktreeId: string, name: string) =>
    ipcRenderer.invoke(IPC.renameWorktree, worktreeId, name) as Promise<void>,
  clearWorktreeStatus: (worktreeId: string) =>
    ipcRenderer.invoke(IPC.clearWorktreeStatus, worktreeId) as Promise<void>,
  listBranches: (projectId: string) =>
    ipcRenderer.invoke(IPC.listBranches, projectId) as Promise<BranchInfo>,
  setProjectAgent: (projectId: string, patch: ProjectAgentPatch) =>
    ipcRenderer.invoke(IPC.setProjectAgent, projectId, patch) as Promise<void>,
  inspectProfileDir: (provider: string, configDir: string) =>
    ipcRenderer.invoke(IPC.inspectProfileDir, provider, configDir) as Promise<ProfileDirInfo>,
  claudeHooksStatus: (agentId: string) =>
    ipcRenderer.invoke(IPC.claudeHooksStatus, agentId) as Promise<ClaudeHooksStatus>,
  claudeHooksPlan: (agentId: string) => ipcRenderer.invoke(IPC.claudeHooksPlan, agentId) as Promise<ClaudeHooksPlan>,
  installClaudeHooks: (agentId: string) =>
    ipcRenderer.invoke(IPC.installClaudeHooks, agentId) as Promise<ClaudeHooksStatus>,
  removeClaudeHooks: (agentId: string) =>
    ipcRenderer.invoke(IPC.removeClaudeHooks, agentId) as Promise<ClaudeHooksStatus>,
  claudeSkillStatus: (agentId: string) =>
    ipcRenderer.invoke(IPC.claudeSkillStatus, agentId) as Promise<ClaudeSkillStatus>,
  claudeSkillPlan: (agentId: string) => ipcRenderer.invoke(IPC.claudeSkillPlan, agentId) as Promise<ClaudeSkillPlan>,
  installClaudeSkill: (agentId: string) =>
    ipcRenderer.invoke(IPC.installClaudeSkill, agentId) as Promise<ClaudeSkillStatus>,
  removeClaudeSkill: (agentId: string) =>
    ipcRenderer.invoke(IPC.removeClaudeSkill, agentId) as Promise<ClaudeSkillStatus>,
  codexInstructionsStatus: (agentId: string) =>
    ipcRenderer.invoke(IPC.codexInstructionsStatus, agentId) as Promise<CodexInstructionsStatus>,
  codexInstructionsPlan: (agentId: string) =>
    ipcRenderer.invoke(IPC.codexInstructionsPlan, agentId) as Promise<CodexInstructionsPlan>,
  installCodexInstructions: (agentId: string) =>
    ipcRenderer.invoke(IPC.installCodexInstructions, agentId) as Promise<CodexInstructionsStatus>,
  removeCodexInstructions: (agentId: string) =>
    ipcRenderer.invoke(IPC.removeCodexInstructions, agentId) as Promise<CodexInstructionsStatus>,
  createTab: (worktreeId: string, paneId: string | null, type: TabType, config?: TabConfig) =>
    ipcRenderer.invoke(IPC.createTab, worktreeId, paneId, type, config) as Promise<Tab>,
  closeTab: (tabId: string) => ipcRenderer.invoke(IPC.closeTab, tabId) as Promise<void>,
  renameTab: (tabId: string, title: string) =>
    ipcRenderer.invoke(IPC.renameTab, tabId, title) as Promise<void>,
  setActiveTab: (paneId: string, tabId: string) =>
    ipcRenderer.invoke(IPC.setActiveTab, paneId, tabId) as Promise<void>,
  moveTab: (tabId: string, targetPaneId: string) =>
    ipcRenderer.invoke(IPC.moveTab, tabId, targetPaneId) as Promise<void>,
  splitPane: (worktreeId: string, paneId: string, dir: SplitDirection, where: SplitWhere) =>
    ipcRenderer.invoke(IPC.splitPane, worktreeId, paneId, dir, where) as Promise<Pane>,
  closePane: (worktreeId: string, paneId: string) =>
    ipcRenderer.invoke(IPC.closePane, worktreeId, paneId) as Promise<void>,
  moveTabToEdge: (tabId: string, targetPaneId: string, edge: 'left' | 'right' | 'top' | 'bottom') =>
    ipcRenderer.invoke(IPC.moveTabToEdge, tabId, targetPaneId, edge) as Promise<void>,
  setSplitRatio: (worktreeId: string, splitId: string, ratio: number) =>
    ipcRenderer.invoke(IPC.setSplitRatio, worktreeId, splitId, ratio) as Promise<void>,

  // terminals (fire-and-forget)
  terminalInput: (tabId: string, data: string) => ipcRenderer.send(IPC.terminalInput, tabId, data),
  terminalResize: (tabId: string, cols: number, rows: number) =>
    ipcRenderer.send(IPC.terminalResize, tabId, cols, rows),
  terminalBuffer: (tabId: string) => ipcRenderer.invoke(IPC.terminalBuffer, tabId) as Promise<TerminalBuffer>,
  terminalAlive: (tabId: string) => ipcRenderer.invoke(IPC.terminalAlive, tabId) as Promise<boolean>,
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text: string) => clipboard.writeText(text),
  pasteClipboardImage: () => ipcRenderer.invoke(IPC.pasteClipboardImage) as Promise<string | null>,

  // git
  gitStatus: (worktreeId: string) => ipcRenderer.invoke(IPC.gitStatus, worktreeId) as Promise<GitStatus>,
  gitStage: (worktreeId: string, path: string) => ipcRenderer.invoke(IPC.gitStage, worktreeId, path) as Promise<void>,
  gitUnstage: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.gitUnstage, worktreeId, path) as Promise<void>,
  gitStageAll: (worktreeId: string) => ipcRenderer.invoke(IPC.gitStageAll, worktreeId) as Promise<void>,
  gitUnstageAll: (worktreeId: string) => ipcRenderer.invoke(IPC.gitUnstageAll, worktreeId) as Promise<void>,
  gitDiscard: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.gitDiscard, worktreeId, path) as Promise<void>,
  gitDiscardAll: (worktreeId: string) => ipcRenderer.invoke(IPC.gitDiscardAll, worktreeId) as Promise<void>,
  gitCommit: (worktreeId: string, message: string, amend?: boolean) =>
    ipcRenderer.invoke(IPC.gitCommit, worktreeId, message, amend) as Promise<void>,
  gitLastCommitMessage: (worktreeId: string) =>
    ipcRenderer.invoke(IPC.gitLastCommitMessage, worktreeId) as Promise<string>,
  gitPush: (worktreeId: string) => ipcRenderer.invoke(IPC.gitPush, worktreeId) as Promise<void>,
  gitPull: (worktreeId: string) => ipcRenderer.invoke(IPC.gitPull, worktreeId) as Promise<void>,
  gitFetch: (worktreeId: string) => ipcRenderer.invoke(IPC.gitFetch, worktreeId) as Promise<void>,
  gitCheckout: (worktreeId: string, branch: string, create?: boolean) =>
    ipcRenderer.invoke(IPC.gitCheckout, worktreeId, branch, create) as Promise<void>,
  gitDiff: (worktreeId: string, path: string, staged: boolean) =>
    ipcRenderer.invoke(IPC.gitDiff, worktreeId, path, staged) as Promise<FileDiff>,
  fileTree: (worktreeId: string) => ipcRenderer.invoke(IPC.fileTree, worktreeId) as Promise<FileNode[]>,
  listDir: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.listDir, worktreeId, path) as Promise<FileNode[]>,
  readFile: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.readFile, worktreeId, path) as Promise<string>,
  readFileBase64: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.readFileBase64, worktreeId, path) as Promise<string>,
  writeFile: (worktreeId: string, path: string, content: string) =>
    ipcRenderer.invoke(IPC.writeFile, worktreeId, path, content) as Promise<void>,
  createFile: (worktreeId: string, parentDir: string, name: string) =>
    ipcRenderer.invoke(IPC.createFile, worktreeId, parentDir, name) as Promise<string>,
  createDirectory: (worktreeId: string, parentDir: string, name: string) =>
    ipcRenderer.invoke(IPC.createDirectory, worktreeId, parentDir, name) as Promise<string>,
  renamePath: (worktreeId: string, path: string, newName: string) =>
    ipcRenderer.invoke(IPC.renamePath, worktreeId, path, newName) as Promise<string>,
  trashPath: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.trashPath, worktreeId, path) as Promise<void>,
  resolvePath: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.resolvePath, worktreeId, path) as Promise<string>,

  // tasks
  createTask: (projectId: string, title: string, description?: string, tags?: string[]) =>
    ipcRenderer.invoke(IPC.createTask, projectId, title, description, tags) as Promise<Task>,
  updateTask: (taskId: string, patch: TaskPatch) =>
    ipcRenderer.invoke(IPC.updateTask, taskId, patch) as Promise<Task>,
  deleteTask: (taskId: string) => ipcRenderer.invoke(IPC.deleteTask, taskId) as Promise<void>,

  // browser / window
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  registerBrowserView: (webContentsId: number, worktreeId: string, paneId: string) =>
    ipcRenderer.invoke(IPC.registerBrowserView, webContentsId, worktreeId, paneId) as Promise<void>,
  openPath: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.openPath, worktreeId, path) as Promise<void>,
  revealPath: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.revealPath, worktreeId, path) as Promise<void>,
  openInTerminal: (worktreeId: string, path: string) =>
    ipcRenderer.invoke(IPC.openInTerminal, worktreeId, path) as Promise<void>,
  openProjectPath: (projectId: string) =>
    ipcRenderer.invoke(IPC.openProjectPath, projectId) as Promise<void>,
  openProjectInTerminal: (projectId: string) =>
    ipcRenderer.invoke(IPC.openProjectInTerminal, projectId) as Promise<void>,
  openLogFolder: () => ipcRenderer.invoke(IPC.openLogFolder) as Promise<void>,
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
