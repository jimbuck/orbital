/**
 * Per-launch agent briefing.
 *
 * Writes a short operational system-prompt file into Orbital's own app-data dir
 * (NOT the repo — zero git footprint) and returns its path. Regenerated on every
 * tab launch; deleted when the tab/worktree goes away (and swept at startup) so
 * the files never accumulate. This is harness wiring only; it deliberately does
 * not duplicate anything from the repo's CLAUDE.md.
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Repo, Worktree } from '@shared/types'
import type { ProjectMap, RepoMapEntry, SessionRole } from '../project-map'

function briefingDir(): string {
  return join(app.getPath('userData'), 'agent-briefings')
}

/** Stable per-tab briefing key (also the filename stem). */
export function briefingKey(worktreeId: string, tabId: string): string {
  return `${worktreeId}__${tabId}`
}

export interface BriefingInput {
  repo: Repo
  worktree: Worktree
  tabId: string
  /** Agent name used in the opener; defaults to 'Claude Code'. */
  providerName?: string
  /** When true, the cockpit learns status from Claude hooks, so drop the self-report block. */
  hooksInstalled: boolean
  /**
   * The session's place in a multi-repo project (see project-map.ts) and the
   * live map of that project; absent for a plain one-repo project, whose
   * briefing has no project section.
   */
  project?: { role: SessionRole; map: ProjectMap | null; addDirs: string[] }
}

/** Write the briefing for an agent tab launch; returns the absolute file path. */
export function writeBriefing(input: BriefingInput): string {
  const dir = briefingDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${briefingKey(input.worktree.id, input.tabId)}.txt`)
  writeFileSync(file, briefingText(input), 'utf8')
  return file
}

/** Best-effort delete of a single agent tab's briefing file. */
export function deleteBriefing(worktreeId: string, tabId: string): void {
  try {
    rmSync(join(briefingDir(), `${briefingKey(worktreeId, tabId)}.txt`), { force: true })
  } catch {
    /* nothing to remove */
  }
}

/** Startup sweep: drop any briefing file whose worktree__tab key is not in `keep`. */
export function pruneBriefings(keep: Set<string>): void {
  let files: string[]
  try {
    files = readdirSync(briefingDir())
  } catch {
    return // dir not created yet — nothing to prune
  }
  for (const f of files) {
    if (!f.endsWith('.txt') || keep.has(f.slice(0, -4))) continue
    try {
      rmSync(join(briefingDir(), f), { force: true })
    } catch {
      /* ignore */
    }
  }
}

export function briefingText({ repo, worktree, providerName, hooksInstalled, project }: BriefingInput): string {
  const folder = worktree.kind === 'folder'
  const lines = [
    `You are ${providerName ?? 'Claude Code'} running inside an Orbital worktree — one checkout in the`,
    'Orbital cockpit, which runs several coding-agent sessions side by side, each in its own git',
    'worktree within a repo.',
    '',
    'Worktree context:',
    ...(folder
      ? [
          `- Project: ${repo.name} (its folder session: no repo of its own, not a git checkout)`,
          `- Path: ${worktree.path}`
        ]
      : [`- Repo: ${repo.name}`, `- Worktree: ${worktree.name}`, `- Path: ${worktree.path}`, `- Branch: ${worktree.branch}`]),
    '',
    'The `orbital` CLI is on your PATH — use it to work with the cockpit. Add `--json` to any',
    'command to get the raw payload instead of a table when you intend to parse it.',
    '- `orbital task add "<title>" [--description <text>] [--tags <a,b>]` — queue follow-up work you notice but should not tackle now. Tasks belong to the project; this files it under this repo from a repo worktree and under no repo (the whole project) from the project session. `--repo <name>` or `--no-repo` says otherwise.',
    "- `orbital task list [--status <s>] [--tag <t>]` — this terminal's open tasks (number, status, title): this repo's from a repo worktree, the whole project's from the project session. `--all-repos` lists the whole project's, `--no-repo` only those filed under no repo. Done tasks are hidden unless you pass `--all` or ask for a status explicitly; archived tasks are hidden unless you pass `--all` or `--archived`.",
    '- `orbital task show <number>` — full detail for any task of the project (e.g. `orbital task show 12`).',
    '- `orbital task update <number> --status <todo|in-progress|ready-for-review|done>` — progress a task you are working on; `orbital task done <number>` when it is finished; `orbital task archive <number>` to drop one from the board (it is kept, not deleted; `orbital task unarchive <number>` brings it back). `--repo <name>` / `--no-repo` on `task update` refiles a task, except while it has a worktree: its repo follows the worktree.',
    '  Move a task to `in-progress` the moment you start on it and off it when you finish — the board is how the human sees what is underway, and a task left in `todo` while you work reads as unclaimed. (A worktree opened with `orbital task start` has already done this.)',
    "- `orbital task start <number>` — open a worktree for a task, linked and moved to in-progress, in the task's repo. A task filed under no repo needs `--repo <name>` to say where.",
    "- `orbital worktrees` — list this repo's worktrees.",
    "- `orbital repos` — the workspace's other repos (name, id, repo path). Worktree commands stay scoped to this repo and task commands to this project; pass `--repo <name|id>` to read or write a sibling's instead. Passing it is the opt-in, so only reach across when the work calls for it.",
    '- `orbital worktree new [--worktree <branch>] [--existing-branch <branch>] [--base <ref>] [name]` — open a new worktree, on a fresh branch, an existing one, or forked from a given ref.',
    "- `orbital worktree sync` — copy the root checkout's env files (.env, agent config) into this worktree again; they are copied once at creation and never kept in sync, so run this if the root's changed. Overwrites this worktree's copies.",
    '- `orbital tab new <terminal|browser|editor|agent|search> [arg]` — open a tab in this worktree (browser arg = URL, editor arg = file path, agent arg = the name of a configured agent, search arg = a query to run across the checkout).',
    '- `orbital server add <url|port>` / `orbital server remove <url|port>` — tell the cockpit when you start or stop a dev server, so the human can open it in one click; `orbital server list` shows what is registered.',
    '- `orbital whoami` — this worktree at a glance: repo, branch, path, status, linked task, dev servers.'
  ]
  if (project) lines.push('', ...projectSection(project.role, project.map, project.addDirs, worktree))
  if (!hooksInstalled) {
    lines.push(
      '',
      'Report your status as you work so the cockpit can show what each worktree is doing:',
      '- `orbital status working` — actively working',
      '- `orbital status needs-attention` — blocked and waiting on a human',
      '- `orbital status idle` — waiting for the next instruction',
      '- `orbital status done` — the current task is complete'
    )
  }
  return lines.join('\n') + '\n'
}

/** "main, clean", "feat/x, dirty", or what is known of it. */
function checkoutState(r: Pick<RepoMapEntry, 'branch' | 'dirty'>): string {
  const branch = r.branch ? `branch ${r.branch}` : 'branch unknown'
  const dirty = r.dirty === null ? '' : r.dirty ? ', uncommitted changes' : ', clean'
  return `${branch}${dirty}`
}

/** One repo of the project session's map, a few lines long. */
function repoLines(r: RepoMapEntry): string[] {
  const where = r.relPath ? `${r.path} (${r.relPath}/ in the project root)` : r.path
  const head = `- ${r.name}${r.home ? ' [home]' : ''}: ${where}`
  const facts = [
    r.remote ? `remote ${r.remote}` : 'no remote',
    `root checkout on ${checkoutState(r)}`,
    `${r.openTasks} open task${r.openTasks === 1 ? '' : 's'}`
  ]
  const out = [head, `  ${facts.join('; ')}`]
  for (const w of r.worktrees) {
    out.push(`  worktree ${w.name} (${w.branch}) at ${w.path}${w.task !== null ? `, task #${w.task}` : ''}`)
  }
  if (r.steering.length) out.push(`  Has ${r.steering.join(' and ')}: read it before changing this repo.`)
  return out
}

/** The project part of the briefing: the full map for the project session, a pointer for a member repo. */
function projectSection(
  role: SessionRole,
  map: ProjectMap | null,
  addDirs: string[],
  worktree: Pick<Worktree, 'kind' | 'path'>
): string[] {
  const name = role.project.name
  // A folder session gets every member; a home session every member but its own repo.
  const reachable = !addDirs.length
    ? ''
    : addDirs.length >= role.members.length
      ? 'They are added to this session, so you can read and edit them without leaving it.'
      : 'The others are added to this session, so you can read and edit them without leaving it.'
  if (role.kind === 'project') {
    const where =
      worktree.kind === 'folder'
        ? `This session runs in the project's root folder (${role.project.rootPath}); the project has no home repo.`
        : `This session runs in the home repo, ${role.home?.name ?? ''}. Its AGENTS.md / CLAUDE.md is the project's shared steering.`
    const lines = [
      `Project "${name}": this is the project session, the place to plan work that spans its repos.`,
      where,
      '',
      `Repos in this project (root ${role.project.rootPath}). ${reachable}`.trimEnd()
    ]
    if (map) for (const r of map.repos) lines.push(...repoLines(r))
    else for (const r of role.members) lines.push(`- ${r.name}${r.id === role.home?.id ? ' [home]' : ''}: ${r.repoPath}`)
    if (map) lines.push(`- Filed under no repo (work that spans the project): ${map.openTasks} open task${map.openTasks === 1 ? '' : 's'}.`)
    lines.push(
      '',
      'Working across these repos:',
      '- `orbital project` — this map, refreshed (branches, changes, worktrees).',
      '- `orbital worktree new --repo <name> [--task <n>] [--worktree <branch>]` — open a worktree in one repo for a piece of the work.',
      '- `orbital tab new agent --repo <name> [--worktree <name|branch>] --prompt "<instructions>"` — start an agent in that repo (its root checkout, or the named worktree) with its instructions.',
      '- `orbital task add "<title>" [--repo <name>]` — file work for the whole project, or with `--repo` against one repo.',
      'Plan here, then hand each repo its part. Prefer a worktree per change over editing a root checkout directly.'
    )
    if (worktree.kind === 'folder') {
      lines.push('Worktree commands need `--repo <name>` here: the folder session has no repo of its own.')
    }
    return lines
  }
  const lines = [`Project "${name}": this repo is one of ${role.members.length} in it (root ${role.project.rootPath}).`]
  if (role.home) {
    lines.push(
      `- Home repo: ${role.home.name} at ${role.home.repoPath}. It holds the project's shared docs and skills${addDirs.length ? ', and is added to this session (its AGENTS.md / CLAUDE.md and skills are loaded)' : ''}.`
    )
  }
  const siblings = (map?.repos ?? role.members.map((r) => ({ id: r.id, name: r.name, path: r.repoPath, branch: null, dirty: null })))
    .filter((r) => r.id !== role.repo.id && r.id !== role.home?.id)
  if (siblings.length) {
    lines.push('- Other repos:')
    for (const r of siblings) {
      lines.push(`  - ${r.name}: ${r.path}${r.branch !== null || r.dirty !== null ? ` (${checkoutState(r)})` : ''}`)
    }
  }
  lines.push(
    '- `orbital project` lists them live. Work that spans repos is better planned from the project session; stay in this repo unless the task needs more.'
  )
  return lines
}
