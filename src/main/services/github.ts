/**
 * GitHub via the `gh` CLI: who the user is, what they can create under, the
 * repositories they can clone, and creating + cloning a new one. Everything
 * goes through `gh` rather than the REST API directly so the user's existing
 * `gh auth login` (and git credential setup) is the only authentication
 * Orbital ever needs.
 *
 * As with `git.ts`, no spawn here has a terminal behind it, so every call is
 * bounded by a timeout and every prompt `gh` might raise is disabled up front.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  isValidOwner,
  parseNameWithOwner,
  validateRepoName,
  type GithubAccount,
  type GithubAccountRef,
  type GithubContext,
  type GithubCreateRepoOptions,
  type GithubCreatedRepo,
  type GithubLicense,
  type GithubRepoNameCheck,
  type GithubRepoSummary
} from '@shared/github'
import { resolveExecutable, type ExeResolution } from './agents/executable'

const execFileP = promisify(execFile)

const MAX_BUFFER = 16 * 1024 * 1024
/** API round trips: one request, or a short paginated list. */
const API_TIMEOUT_MS = 60_000
/** Creating a repository is one API call plus (with a template) a server-side generate. */
const CREATE_TIMEOUT_MS = 3 * 60_000
/** A clone can be a real download. Same ceiling as git worktree checkouts. */
const CLONE_TIMEOUT_MS = 10 * 60_000

/** Most repositories a single owner listing will fetch — enough for a picker, bounded for the API. */
const LIST_LIMIT = 300

export const GH_MISSING_MESSAGE =
  'GitHub CLI (gh) was not found on your PATH. Install it from https://cli.github.com, then sign in with `gh auth login`.'

/* ----------------------------------------------------------------------------
 * Spawning gh
 * -------------------------------------------------------------------------- */

let resolved: Promise<ExeResolution> | null = null

/** Locate `gh` once per app run; a miss is not cached so an install mid-session is picked up. */
function ghExe(): Promise<ExeResolution> {
  if (!resolved) {
    resolved = resolveExecutable(undefined, 'gh').catch((err) => {
      resolved = null
      throw new Error(GH_MISSING_MESSAGE, { cause: err })
    })
  }
  return resolved
}

/**
 * Environment for every gh spawn: no prompts, no pager, no colour, no update
 * nag. `extra` carries the per-account token (see `accountEnv`).
 */
export function ghEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1',
    CLICOLOR: '0',
    GIT_TERMINAL_PROMPT: '0',
    ...extra
  }
}

interface RunOptions {
  cwd?: string
  timeoutMs?: number
  /** Extra environment — the account token, so this call acts as that account. */
  env?: NodeJS.ProcessEnv
}

type ExecError = Error & {
  code?: number | string
  stdout?: string
  stderr?: string
  killed?: boolean
}

interface GhResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * gh's failure text, trimmed to the sentence a modal can show. A flag error
 * is followed by the full usage block; an API error is one line already.
 */
export function cleanGhError(stderr: string): string {
  const text = stderr.replace(/\r\n/g, '\n').trim()
  const usage = text.indexOf('\nUsage:')
  return (usage === -1 ? text : text.slice(0, usage)).trim()
}

async function capture(args: string[], opts: RunOptions = {}): Promise<GhResult> {
  const { file, prefixArgs } = await ghExe()
  const timeout = opts.timeoutMs ?? API_TIMEOUT_MS
  try {
    const { stdout, stderr } = await execFileP(file, [...prefixArgs, ...args], {
      cwd: opts.cwd,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      timeout,
      env: ghEnv(opts.env)
    })
    return { stdout: stdout as string, stderr: stderr as string, code: 0 }
  } catch (err) {
    const e = err as ExecError
    const code = typeof e.code === 'number' ? e.code : 1
    const stdout = typeof e.stdout === 'string' ? e.stdout : ''
    let stderr = typeof e.stderr === 'string' ? e.stderr : ''
    if (e.killed) {
      const what = `gh ${args.slice(0, 2).join(' ')}`
      stderr = `${what} timed out after ${Math.round(timeout / 1000)}s${stderr ? `\n${stderr.trim()}` : ''}`
    }
    if (!stderr && !stdout && e.message) stderr = e.message
    return { stdout, stderr, code }
  }
}

/** Run gh, throwing a cleaned `Error(stderr)` on any non-zero exit. */
async function run(args: string[], opts: RunOptions = {}): Promise<string> {
  const { stdout, stderr, code } = await capture(args, opts)
  if (code !== 0) throw new Error(cleanGhError(stderr) || stdout.trim() || `gh ${args.join(' ')} failed`)
  return stdout
}

/* ----------------------------------------------------------------------------
 * Accounts: gh can hold several logins per host; act as one without switching
 * -------------------------------------------------------------------------- */

/**
 * The accounts `gh auth status` reports, active ones first. gh prints one
 * block per host, and inside it one "Logged in to HOST account LOGIN" line per
 * account followed by an "Active account: true|false" line; accounts whose
 * token no longer works show as "Failed to log in" and are left out, since a
 * call as them would only fail later with a worse message.
 */
export function parseAuthStatus(text: string): GithubAccount[] {
  const accounts: GithubAccount[] = []
  let current: GithubAccount | null = null
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    const login = line.match(/^(?:✓|√|\*)?\s*Logged in to (\S+) account (\S+)/)
    if (login) {
      current = { host: login[1], login: login[2], active: false }
      accounts.push(current)
      continue
    }
    if (/Failed to log in/.test(line)) {
      current = null
      continue
    }
    const active = line.match(/^-?\s*Active account:\s*(true|false)/)
    if (active && current) current.active = active[1] === 'true'
  }
  return accounts.sort((a, b) => Number(b.active) - Number(a.active))
}

/**
 * Every signed-in account. `gh auth status` exits non-zero when any account
 * has gone bad but still lists the good ones, so the output is parsed either
 * way; only an empty list is an error, and gh's own sign-in hint is the text.
 */
async function listAccounts(): Promise<GithubAccount[]> {
  const { stdout, stderr, code } = await capture(['auth', 'status'])
  const accounts = parseAuthStatus(`${stdout}\n${stderr}`)
  if (accounts.length === 0) {
    const hint = cleanGhError(stderr) || cleanGhError(stdout)
    throw new Error(
      code === 0 || !hint ? 'gh reports no signed-in GitHub account. Run `gh auth login` and try again.' : hint
    )
  }
  return accounts
}

/** Cached per-account tokens: keyring reads are not free, and the name check runs on every pause in typing. */
const tokenCache = new Map<string, { token: string; at: number }>()
const TOKEN_TTL_MS = 60_000

function accountKey(ref: GithubAccountRef): string {
  return `${ref.host}/${ref.login}`
}

/**
 * The environment that makes gh act as `ref` for one call, without touching
 * the globally active account (which every other terminal on the machine
 * shares). gh honours `GH_TOKEN` for github.com and `GH_ENTERPRISE_TOKEN` for
 * a GHES host — both for API calls and for the git credential helper it wires
 * into `gh repo clone` — and `GH_HOST` points commands at the right host. The
 * token never leaves this process: it goes into a child's environment and
 * nowhere else.
 */
async function accountEnv(ref: GithubAccountRef | undefined): Promise<NodeJS.ProcessEnv> {
  if (!ref) return {}
  if (!/^[A-Za-z0-9.-]+$/.test(ref.host) || !isValidOwner(ref.login)) {
    throw new Error('That GitHub account is not one gh is signed in to.')
  }
  const key = accountKey(ref)
  const cached = tokenCache.get(key)
  let token = cached && Date.now() - cached.at < TOKEN_TTL_MS ? cached.token : ''
  if (!token) {
    token = (await run(['auth', 'token', '--hostname', ref.host, '--user', ref.login])).trim()
    if (!token) {
      throw new Error(`gh has no token for ${ref.login} on ${ref.host}. Run \`gh auth login\` for that account.`)
    }
    tokenCache.set(key, { token, at: Date.now() })
  }
  return { GH_HOST: ref.host, GH_TOKEN: token, GH_ENTERPRISE_TOKEN: token }
}

/* ----------------------------------------------------------------------------
 * Context: who am I, what can I create under, which templates exist
 * -------------------------------------------------------------------------- */

/** `key<TAB>name` lines from `gh api licenses --jq`. */
export function parseLicenses(tsv: string): GithubLicense[] {
  return tsv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return tab === -1 ? { key: line, name: line } : { key: line.slice(0, tab), name: line.slice(tab + 1) }
    })
}

function parseLines(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * The signed-in user plus their organizations, licenses and gitignore
 * templates. The user lookup is the one call that must succeed — it is also
 * the auth check, and gh's own "run gh auth login" text is the message the
 * form shows. The template lists degrade to empty so a flaky secondary call
 * never blocks creating a repository.
 */
async function getContext(account?: GithubAccountRef): Promise<GithubContext> {
  const accounts = await listAccounts()
  // An unknown ref (an account signed out since the form loaded) falls back
  // to the active one rather than acting as a token gh no longer has.
  const chosen = account && accounts.find((a) => accountKey(a) === accountKey(account))
  const acting = chosen ?? accounts[0]
  const ref: GithubAccountRef = { host: acting.host, login: acting.login }
  const env = await accountEnv(ref)
  const [user, orgs, licenses, gitignores] = await Promise.all([
    run(['api', 'user', '--jq', '.login'], { env }).then((s) => s.trim()),
    run(['api', 'user/orgs', '--paginate', '--jq', '.[].login'], { env })
      .then(parseLines)
      .catch(() => [] as string[]),
    run(['api', 'licenses', '--jq', '.[] | [.key, .name] | @tsv'], { env })
      .then(parseLicenses)
      .catch(() => [] as GithubLicense[]),
    run(['api', 'gitignore/templates', '--jq', '.[]'], { env })
      .then(parseLines)
      .catch(() => [] as string[])
  ])
  if (!user) throw new Error('gh returned no signed-in user. Run `gh auth login` and try again.')
  return {
    accounts,
    account: ref,
    user,
    owners: [user, ...orgs.filter((o) => o !== user)],
    licenses,
    gitignoreTemplates: gitignores
  }
}

/* ----------------------------------------------------------------------------
 * Listing and checking repositories
 * -------------------------------------------------------------------------- */

const LIST_FIELDS = [
  'name',
  'nameWithOwner',
  'description',
  'visibility',
  'url',
  'isTemplate',
  'isArchived',
  'isEmpty',
  'pushedAt'
] as const

interface RawRepo {
  name: string
  nameWithOwner: string
  description: string | null
  visibility: string
  url: string
  isTemplate: boolean
  isArchived: boolean
  isEmpty: boolean
  pushedAt: string | null
}

export function parseRepoList(json: string): GithubRepoSummary[] {
  const rows = JSON.parse(json) as RawRepo[]
  return rows
    .map((r) => ({
      name: r.name,
      nameWithOwner: r.nameWithOwner,
      description: r.description ?? '',
      visibility: (r.visibility ?? 'PRIVATE').toLowerCase() as GithubRepoSummary['visibility'],
      url: r.url,
      isTemplate: Boolean(r.isTemplate),
      isArchived: Boolean(r.isArchived),
      isEmpty: Boolean(r.isEmpty),
      pushedAt: r.pushedAt ?? ''
    }))
    .sort((a, b) => (b.pushedAt > a.pushedAt ? 1 : b.pushedAt < a.pushedAt ? -1 : a.name.localeCompare(b.name)))
}

/** Repositories under `owner` the signed-in user can see, most recently pushed first. */
async function listRepos(owner: string, account?: GithubAccountRef): Promise<GithubRepoSummary[]> {
  if (!isValidOwner(owner)) throw new Error(`"${owner}" is not a valid GitHub owner.`)
  const env = await accountEnv(account)
  const args = ['repo', 'list', owner, '--limit', String(LIST_LIMIT), '--json', LIST_FIELDS.join(',')]
  return parseRepoList(await run(args, { env }))
}

/**
 * Whether `owner/name` can be created: the local naming rules first, then a
 * lookup that distinguishes "does not exist" (good) from any other failure,
 * which is rethrown so a network problem is not mistaken for a free name.
 */
async function checkRepoName(
  owner: string,
  name: string,
  account?: GithubAccountRef
): Promise<GithubRepoNameCheck> {
  if (!isValidOwner(owner)) return { ok: false, reason: `"${owner}" is not a valid GitHub owner.` }
  const invalid = validateRepoName(name)
  if (invalid) return { ok: false, reason: invalid }
  const env = await accountEnv(account)
  const { stderr, code } = await capture(['repo', 'view', `${owner}/${name}`, '--json', 'name'], { env })
  if (code === 0) return { ok: false, reason: `${owner}/${name} already exists on GitHub.` }
  if (/could not resolve to a repository/i.test(stderr)) return { ok: true }
  throw new Error(cleanGhError(stderr) || 'Could not check the repository name.')
}

/* ----------------------------------------------------------------------------
 * Creating and cloning
 * -------------------------------------------------------------------------- */

/**
 * The argv for `gh repo create`. Values ride in `--flag=value` form so a value
 * that happens to start with a dash is never read as another flag. `gh` refuses
 * gitignore / license / README alongside a template, so those are dropped when
 * one is given rather than failing the whole create.
 */
export function buildCreateRepoArgs(opts: GithubCreateRepoOptions): string[] {
  const args = ['repo', 'create', `${opts.owner}/${opts.name}`, `--${opts.visibility}`]
  const text = (flag: string, value: string | undefined): void => {
    const v = value?.trim()
    if (v) args.push(`--${flag}=${v}`)
  }
  text('description', opts.description)
  text('homepage', opts.homepage)
  if (opts.template?.trim()) {
    text('template', opts.template)
    if (opts.includeAllBranches) args.push('--include-all-branches')
  } else {
    text('gitignore', opts.gitignore)
    text('license', opts.license)
    if (opts.addReadme) args.push('--add-readme')
  }
  if (opts.disableIssues) args.push('--disable-issues')
  if (opts.disableWiki) args.push('--disable-wiki')
  text('team', opts.team)
  return args
}

/** Reject anything that cannot be a real `gh repo create` before spawning it. */
export function validateCreateRepoOptions(opts: GithubCreateRepoOptions): string | null {
  if (!isValidOwner(opts.owner)) return `"${opts.owner}" is not a valid GitHub owner.`
  const invalid = validateRepoName(opts.name)
  if (invalid) return invalid
  if (!['public', 'private', 'internal'].includes(opts.visibility)) return 'Pick a visibility.'
  if (opts.template?.trim() && !parseNameWithOwner(opts.template)) {
    return 'Template must be written as owner/repository.'
  }
  if (opts.team?.trim() && !/^[A-Za-z0-9_.-]+$/.test(opts.team.trim())) return 'That is not a valid team slug.'
  if (opts.homepage?.trim() && !/^https?:\/\/\S+$/i.test(opts.homepage.trim())) {
    return 'Homepage must be an http(s) URL.'
  }
  return null
}

/** Create the repository on GitHub. Nothing is cloned; see `cloneRepo`. */
async function createRepo(opts: GithubCreateRepoOptions): Promise<GithubCreatedRepo> {
  const invalid = validateCreateRepoOptions(opts)
  if (invalid) throw new Error(invalid)
  const env = await accountEnv(opts.account)
  const out = await run(buildCreateRepoArgs(opts), { timeoutMs: CREATE_TIMEOUT_MS, env })
  const nameWithOwner = `${opts.owner}/${opts.name}`
  // gh prints the new repository's URL on its own line.
  const url = out.match(/https?:\/\/\S+/)?.[0] ?? `https://github.com/${nameWithOwner}`
  return { nameWithOwner, url }
}

/**
 * Where a clone of `dirName` under `parentDir` would land, after checking the
 * parent exists and the target is absent or an empty directory — git refuses a
 * non-empty target itself, but this way the message names Orbital's own form
 * fields instead of paraphrasing git.
 */
export function resolveCloneTarget(parentDir: string, dirName: string): string {
  const parent = parentDir.trim()
  if (!parent) throw new Error('Choose a local folder to clone into.')
  if (!isAbsolute(parent)) throw new Error('The local folder must be an absolute path.')
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error(`The local folder does not exist: ${parent}`)
  }
  const invalid = validateRepoName(dirName)
  if (invalid) throw new Error(invalid)
  const dest = resolve(join(parent, dirName))
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) throw new Error(`A file already exists at ${dest}`)
    if (readdirSync(dest).length > 0) throw new Error(`${dest} already exists and is not empty.`)
  }
  return dest
}

/**
 * `gh repo clone` into `dest`. gh picks https or ssh from the user's own
 * `git_protocol` setting and supplies credentials, so a private repository
 * clones without any extra setup on Orbital's side.
 */
async function cloneRepo(nameWithOwner: string, dest: string, account?: GithubAccountRef): Promise<void> {
  const parsed = parseNameWithOwner(nameWithOwner)
  if (!parsed) throw new Error('Repository must be written as owner/repository.')
  const env = await accountEnv(account)
  await run(['repo', 'clone', `${parsed.owner}/${parsed.name}`, dest], { timeoutMs: CLONE_TIMEOUT_MS, env })
}

export const github = {
  listAccounts,
  getContext,
  listRepos,
  checkRepoName,
  createRepo,
  resolveCloneTarget,
  cloneRepo
}
