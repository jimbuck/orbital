/**
 * Reading the calling terminal's identity out of the environment Orbital set.
 * Kept apart from orbital.ts (which runs on import) so it can be tested; like
 * that file, it imports the shared contract by relative path.
 */
import { ENV } from '../shared/types'

/**
 * The repo and project this terminal belongs to. ORBITAL_REPO_ID is the repo
 * whenever it is set at all (empty in a project's folder session, which has
 * no repo), and ORBITAL_PROJECT_ID is then the project. A terminal opened by
 * an older build has no ORBITAL_REPO_ID, and its ORBITAL_PROJECT_ID is the
 * repo id under its old name.
 */
export function envIdentity(env: NodeJS.ProcessEnv): { repoId?: string; projectId?: string } {
  const repo = env[ENV.repoId]
  const project = env[ENV.projectId] || undefined
  if (repo === undefined) return { repoId: project }
  return { repoId: repo || undefined, projectId: project }
}
