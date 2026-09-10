import * as workspace from './workspace'
import * as projects from './projects'
import * as agentConfig from './agent-config'
import * as worktrees from './worktrees'
import * as layout from './layout'
import * as terminals from './terminals'
import * as git from './git'
import * as tasks from './tasks'
import * as shell from './shell'
import * as window from './window'

export { handleControl } from '../control/dispatch'
export { resumeProjects, stopWorktreesWatchers, reconcileProjectWorktrees } from '../worktree-lifecycle'
export { resumeTerminals } from '../tabs'

/**
 * Register every renderer-facing IPC channel. Each domain module registers
 * its own handlers through the logging wrapper in ./handle; nothing here
 * carries behaviour of its own.
 */
export function registerIpc(): void {
  workspace.register()
  projects.register()
  agentConfig.register()
  worktrees.register()
  layout.register()
  terminals.register()
  git.register()
  tasks.register()
  shell.register()
  window.register()
}
