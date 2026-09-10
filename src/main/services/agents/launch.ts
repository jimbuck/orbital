import { delimiter as PATH_DELIM } from 'node:path'
import { ENV, SUPPORTED_AGENTS, resolveAgentRef, type Worktree, type Tab } from '@shared/types'
import { runtime, repo } from '../../runtime'
import { setTabStatus } from '../../status'
import { cliDir } from './paths'
import { getProvider, type AgentProvider, type AgentSession, type SessionLookup } from './provider'
import { agentProfileDir, defaultProfileDir } from './profiles'
import { expandUserPath } from './user-path'
import { writeBriefing, deleteBriefing } from './briefing'
import * as claudeHooks from './claude-hooks'
import { logger } from '../logger'
import { activeControlPipePath } from '../workspaces'
import { getSettings } from '../settings'

/**
 * Launching the PTY behind a tab: a plain shell for a terminal tab, or a coding
 * agent — resolved, briefed, and pinned to the session it resumes or mints —
 * for an agent tab.
 */

function terminalEnv(worktree: Worktree, tabId: string): Record<string, string> {
  const path = `${cliDir()}${PATH_DELIM}${process.env.PATH ?? ''}`
  return {
    [ENV.terminalId]: tabId,
    [ENV.worktreeId]: worktree.id,
    [ENV.projectId]: worktree.projectId,
    [ENV.socket]: activeControlPipePath(),
    PATH: path,
    Path: path
  }
}

function spawnTerminal(worktree: Worktree, tab: Tab): void {
  const shellPref = getSettings().defaultShell || undefined
  runtime.terminals.prepare({
    tabId: tab.id,
    cwd: worktree.path,
    shell: shellPref,
    env: terminalEnv(worktree, tab.id)
  })
}

/** Session ids Orbital will store and hand back to a CLI: Claude's are UUIDs. */
const SESSION_ID_RE = /^[0-9a-f-]{8,64}$/i

/**
 * Pin an agent tab to the session it is running, so a later respawn resumes
 * that conversation. No-op when the id is unchanged or not something a CLI
 * would accept on its command line.
 */
export function recordAgentSession(tab: Tab, sessionId: unknown): void {
  if (tab.type !== 'agent') return
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return
  if (tab.config.agentSessionId === sessionId) return
  // Re-read: the tab's config may have moved on (a rename) since `tab` was fetched.
  const current = repo.tabs.get(tab.id)
  if (!current) return
  repo.tabs.updateConfig(tab.id, { ...current.config, agentSessionId: sessionId })
}

/** Session ids every agent tab currently holds — what a discovery must not claim twice. */
function takenSessionIds(): Set<string> {
  const taken = new Set<string>()
  for (const worktree of repo.worktrees.list()) {
    for (const pane of worktree.panes) {
      for (const tab of pane.tabs) {
        if (tab.type === 'agent' && tab.config.agentSessionId) taken.add(tab.config.agentSessionId.toLowerCase())
      }
    }
  }
  return taken
}

/**
 * The session an agent tab launches under. A tab that already ran a conversation
 * resumes it, provided the provider still has it — the CLIs exit with an error
 * for an id they do not know, which would leave a dead tab where a fresh session
 * belongs. Otherwise (first launch, session cleaned up) a new id is minted and
 * stored so the NEXT respawn can resume this one; a provider that cannot choose
 * its id up front gets nothing here and is watched after launch instead (see
 * discoverAgentSession). Undefined for providers without session support.
 */
async function agentSession(tab: Tab, provider: AgentProvider, lookup: SessionLookup): Promise<AgentSession | undefined> {
  const sessions = provider.sessions
  if (!sessions) return undefined
  const stored = tab.config.agentSessionId
  if (stored && SESSION_ID_RE.test(stored)) {
    const found = await sessions.find(lookup, stored).catch(() => null)
    if (found) {
      logger.info('resuming agent session', { tab: tab.id, provider: provider.id, session: stored, path: found })
      return { id: stored, resume: true }
    }
    logger.info('agent session gone, starting fresh', { tab: tab.id, provider: provider.id, session: stored })
  }
  const id = await sessions.mint(lookup).catch((err: unknown) => {
    logger.warn('could not mint agent session', { tab: tab.id, provider: provider.id, error: String(err) })
    return null
  })
  if (!id) return undefined
  recordAgentSession(tab, id)
  return { id, resume: false }
}

/**
 * Poll schedule for a provider that reveals its session id only after launch
 * (Codex writes the rollout file itself): quick checks first, then a slow
 * heartbeat while the tab lives — the file may not appear until the first
 * prompt, and nothing says how long the human takes to type it.
 */
const DISCOVERY_DELAYS_MS = [2_000, 3_000, 5_000, 10_000, 20_000, 30_000]
const DISCOVERY_HEARTBEAT_MS = 60_000
const DISCOVERY_DEADLINE_MS = 4 * 60 * 60 * 1000

/**
 * Watch for the session a just-launched agent tab started and pin the tab to
 * it once it appears. Stops when the id is found, the tab is gone, or the
 * deadline passes; a tab that is respawned meanwhile starts its own watch and
 * this one bows out as soon as the tab already carries an id.
 */
function discoverAgentSession(tab: Tab, provider: AgentProvider, lookup: SessionLookup, launchedAt: number): void {
  const discover = provider.sessions?.discover
  if (!discover) return
  logger.info('watching for agent session', { tab: tab.id, provider: provider.id, profileDir: lookup.profileDir, cwd: lookup.cwd })
  let attempt = 0
  const tick = async (): Promise<void> => {
    const current = repo.tabs.get(tab.id)
    if (!current || current.config.agentSessionId) return
    if (Date.now() - launchedAt > DISCOVERY_DEADLINE_MS) {
      logger.info('gave up watching for agent session', { tab: tab.id, provider: provider.id })
      return
    }
    const id = await discover(lookup, launchedAt, takenSessionIds()).catch((err: unknown) => {
      logger.warn('agent session discovery failed', { tab: tab.id, provider: provider.id, error: String(err) })
      return null
    })
    if (id) {
      logger.info('discovered agent session', { tab: tab.id, provider: provider.id, session: id })
      recordAgentSession(current, id)
      return
    }
    const delay = DISCOVERY_DELAYS_MS[attempt] ?? DISCOVERY_HEARTBEAT_MS
    attempt += 1
    setTimeout(() => void tick(), delay)
  }
  setTimeout(() => void tick(), DISCOVERY_DELAYS_MS[0])
}

/**
 * Boot a coding agent (e.g. Claude) directly as the tab's PTY. Resolution is async
 * (it shells out to `where`/`which`); on failure the tab shows a clear notice and
 * flips to `error` instead of sitting as a silent dead pane. A tab that has run
 * before resumes its conversation rather than starting over (see agentSession).
 */
async function spawnAgent(worktree: Worktree, tab: Tab): Promise<void> {
  const project = repo.projects.get(worktree.projectId)
  if (!project) return
  // The configured profile this tab launches (profile dir, exec path, args, env).
  // Each reference is tried in turn, so a tab whose profile was deleted falls
  // back to the project's default rather than to a bare provider. `agentProvider`
  // is what tabs created before profiles had ids stored.
  const agentConfig = resolveAgentRef(
    getSettings().agents,
    tab.config.agentId,
    tab.config.agentProvider,
    project.defaultAgentId
  )
  const provider = getProvider(agentConfig?.provider)
  const envVar = SUPPORTED_AGENTS.find((a) => a.id === provider.id)?.configDirEnvVar
  // The directory the CLI will actually read — the same precedence as the env
  // exported below: the profile's own dir, else a hand-typed env override,
  // else the machine default. Session transcripts live under it.
  const profileDir = agentConfig?.configDir
    ? agentProfileDir(agentConfig)
    : expandUserPath((envVar && agentConfig?.env?.[envVar]) ?? '') || defaultProfileDir(provider.id)
  try {
    // Only providers that can be handed a briefing get one written — the rest
    // would leave an unread file behind on every launch.
    const briefingPath = provider.acceptsBriefingFile
      ? writeBriefing({
          project,
          worktree,
          tabId: tab.id,
          providerName: provider.id === 'claude' ? 'Claude Code' : provider.displayName,
          // The status hooks are CLAUDE's: another provider's session reports
          // nothing on its own, so it always needs the self-report instructions.
          // Read the settings.json of THIS profile (the source of truth) — a
          // sibling Claude profile's install says nothing about this one.
          hooksInstalled:
            provider.id === 'claude' && !!agentConfig && claudeHooks.status(agentConfig).installed
        })
      : null
    // A project-level path is the more specific override; the workspace
    // agent's path fills in when the project doesn't set one.
    const execPath = project.agentExecPath || agentConfig?.execPath
    const lookup: SessionLookup = { profileDir, cwd: worktree.path, execPath }
    const session = await agentSession(tab, provider, lookup)
    const command = await provider.resolveCommand({ project, worktree, briefingPath, execPath, session })
    if (agentConfig?.args?.length) command.args.push(...agentConfig.args)
    // The tab may have been closed during the async executable lookup; don't spawn
    // a PTY nothing references (it could never be killed before app exit).
    if (!repo.tabs.get(tab.id)) {
      deleteBriefing(worktree.id, tab.id)
      return
    }
    runtime.terminals.prepare({
      tabId: tab.id,
      cwd: worktree.path,
      env: {
        // Entry env first: the dedicated profile-dir field beats a hand-typed
        // duplicate, and Orbital's control vars (ids, socket, PATH) stay authoritative.
        ...agentConfig?.env,
        // The EXPANDED directory, which is also what the installers write into —
        // exporting the raw `~/…` would point the CLI at the worktree instead.
        ...(envVar && agentConfig?.configDir ? { [envVar]: agentProfileDir(agentConfig) } : {}),
        ...terminalEnv(worktree, tab.id)
      },
      command
    })
    // A provider that could not name the session up front: learn it from what
    // the CLI writes, so this tab too can resume next time.
    if (!session) discoverAgentSession(tab, provider, lookup, Date.now())
  } catch (err) {
    if (!repo.tabs.get(tab.id)) return // tab gone during resolution — nothing to report
    const msg = err instanceof Error ? err.message : String(err)
    runtime.terminals.notify(
      tab.id,
      `\r\n\x1b[31mOrbital could not launch ${provider.displayName}:\x1b[0m\r\n  ${msg}\r\n`
    )
    setTabStatus(tab.id, worktree.id, 'error')
  }
}

/** Start the PTY for a freshly created PTY-backed tab (terminal or agent). */
export function startPtyTab(worktree: Worktree, tab: Tab): void {
  if (tab.type === 'agent') void spawnAgent(worktree, tab)
  else if (tab.type === 'terminal') spawnTerminal(worktree, tab)
}
