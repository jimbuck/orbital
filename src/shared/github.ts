/**
 * GitHub-side shapes and pure helpers shared by main (which drives the `gh`
 * CLI) and the renderer (which renders the Add Project forms). Nothing here
 * touches a process or the network — that is `main/services/github.ts`.
 */

export type GithubVisibility = 'public' | 'private' | 'internal'

export interface GithubLicense {
  /** The `gh --license` keyword, e.g. `mit`. */
  key: string
  /** Human name, e.g. `MIT License`. */
  name: string
}

/** One account `gh` is signed in as. A user can hold several per host. */
export interface GithubAccount {
  host: string
  login: string
  /** The one `gh` would use on its own (`gh auth switch`). */
  active: boolean
}

/** Which signed-in account a GitHub call should act as; omitted means gh's active one. */
export interface GithubAccountRef {
  host: string
  login: string
}

/** Everything the New GitHub Repo form needs before it can render its pickers. */
export interface GithubContext {
  /** Every account `gh` is signed in as, across hosts, active first. */
  accounts: GithubAccount[]
  /** The account this context describes and every follow-up call should act as. */
  account: GithubAccountRef
  /** Login of `account` — the default owner. */
  user: string
  /** Owners a repository can be created under: the user first, then their organizations. */
  owners: string[]
  licenses: GithubLicense[]
  /** `.gitignore` template names as GitHub spells them (`Node`, `C++`, ...). */
  gitignoreTemplates: string[]
}

/** One row of `gh repo list`, trimmed to what the Clone picker shows. */
export interface GithubRepoSummary {
  name: string
  nameWithOwner: string
  description: string
  visibility: GithubVisibility
  url: string
  isTemplate: boolean
  isArchived: boolean
  isEmpty: boolean
  /** ISO timestamp of the last push. */
  pushedAt: string
}

/** Mirrors the flags of `gh repo create`. */
export interface GithubCreateRepoOptions {
  /** Act as this signed-in account; omitted means gh's active one. */
  account?: GithubAccountRef
  owner: string
  name: string
  visibility: GithubVisibility
  description?: string
  homepage?: string
  /** A `.gitignore` template name from `GithubContext.gitignoreTemplates`. */
  gitignore?: string
  /** A license keyword from `GithubContext.licenses`. */
  license?: string
  addReadme?: boolean
  disableIssues?: boolean
  disableWiki?: boolean
  /** `OWNER/REPO` of a template repository to generate from. */
  template?: string
  /** With `template`: copy every branch, not just the default one. */
  includeAllBranches?: boolean
  /** Organization team granted access to the new repository. */
  team?: string
}

export interface GithubCreatedRepo {
  nameWithOwner: string
  url: string
}

export interface GithubRepoNameCheck {
  ok: boolean
  /** Why the name cannot be used, when `ok` is false. */
  reason?: string
}

export const GITHUB_REPO_NAME_MAX = 100

/** GitHub logins: alphanumerics and single hyphens, never leading or trailing. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPO_CHARS_RE = /^[A-Za-z0-9._-]+$/

/**
 * The rules GitHub applies to a new repository name, as a message for the form
 * or `null` when the name is fine. GitHub would silently rewrite an offending
 * name (`My App` becomes `My-App`); we would rather say so and let the user
 * pick, since the folder on disk takes the same name.
 */
export function validateRepoName(name: string): string | null {
  if (!name) return 'Repository name is required.'
  if (name.length > GITHUB_REPO_NAME_MAX) {
    return `Repository names are at most ${GITHUB_REPO_NAME_MAX} characters.`
  }
  if (!REPO_CHARS_RE.test(name)) {
    return 'Only letters, numbers, hyphens, underscores and periods are allowed.'
  }
  if (/^\.+$/.test(name)) return 'A repository name cannot be only periods.'
  if (/\.git$/i.test(name)) return 'A repository name cannot end in ".git".'
  return null
}

/** What GitHub would turn free text into: runs of disallowed characters become one hyphen. */
export function suggestRepoName(input: string): string {
  return input.trim().replace(/[^A-Za-z0-9._-]+/g, '-')
}

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner)
}

/** `OWNER/REPO` with both halves well-formed, or `null`. */
export function parseNameWithOwner(input: string): { owner: string; name: string } | null {
  const trimmed = input.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash !== trimmed.lastIndexOf('/')) return null
  const owner = trimmed.slice(0, slash)
  const name = trimmed.slice(slash + 1)
  if (!isValidOwner(owner) || validateRepoName(name)) return null
  return { owner, name }
}
