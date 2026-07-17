// Re-export surface for the state-store benchmark: the REAL DB layer, so the
// SQLite side of the comparison measures the app's actual code paths.
export { initDb, getDb, closeDb } from '../src/main/db/database'
export {
  workspaces,
  projects,
  worktrees,
  panes,
  tabs,
  tasks,
  getAppState,
  setActiveWorkspaceId
} from '../src/main/db/repositories'
