/**
 * Azure DevOps repository links, read into their parts. Shared by the renderer
 * (which shows what a pasted link points at while it is typed) and main (which
 * reads the link again before handing it to git, so a clone never runs on the
 * renderer's word for what the link said).
 *
 * A link is all Orbital asks for. The Azure CLI was the other way in, and it
 * buys only a picker: it cannot clone, so git and git's own credentials do
 * that either way, and it wants an install, an extension and a sign-in of its
 * own on top. Anyone who can already `git clone` from Azure DevOps can paste a
 * link with nothing else set up.
 *
 * Nothing here touches a process or the network (see
 * main/services/azure-devops.ts).
 */

export interface AzureRepoRef {
  /** The organization, or on Azure DevOps Server the collection (with any path before it). */
  organization: string
  project: string
  repository: string
  host: string
  transport: 'https' | 'ssh'
  /**
   * What git is given: the pasted link cut back to the repository itself. A
   * token written into the link is left out (see `droppedToken`).
   */
  cloneUrl: string
  /** `cloneUrl` without the user name: the one to show. */
  displayUrl: string
  /**
   * The link carried a password or token (`https://user:token@…`). Orbital
   * does not clone with it: git would write it into the clone's config in
   * plain text, and it would pass through Orbital's own log on the way. Git's
   * credential helper asks for it instead and keeps it where credentials go.
   */
  droppedToken: boolean
  /** The folder the clone lands in. */
  dirName: string
}

/** What to tell someone whose paste could not be read as a repository link. */
export const AZURE_LINK_HINT =
  'Paste the link from the Clone button of an Azure DevOps repository, or the address of one of its pages. It has /_git/ in it (or starts with git@ssh.dev.azure.com).'

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
const SSH_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

// eslint-disable-next-line no-control-regex
const UNNAMEABLE = /[\\/\u0000-\u001f]/

/** A path segment that can name something: not empty, not a step up or sideways. */
function nameable(segment: string | undefined): segment is string {
  if (!segment) return false
  const plain = decode(segment)
  return plain !== '.' && plain !== '..' && !UNNAMEABLE.test(plain)
}

/**
 * The folder a repository is cloned into. Azure DevOps allows spaces and most
 * punctuation in a repository name; a folder on disk is kept to the characters
 * every tool agrees on, as the GitHub forms do.
 */
export function azureDirName(repository: string): string {
  const name = repository
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
  return name || 'repo'
}

function build(
  parts: { organization: string; project: string; repository: string },
  host: string,
  transport: AzureRepoRef['transport'],
  cloneUrl: string,
  displayUrl: string,
  droppedToken = false
): AzureRepoRef | null {
  if (!HOST_RE.test(host)) return null
  const organization = parts.organization.split('/').map(decode).join('/')
  const project = decode(parts.project)
  const repository = decode(parts.repository)
  if (!organization || !project || !repository) return null
  return {
    organization,
    project,
    repository,
    host,
    transport,
    cloneUrl,
    displayUrl,
    droppedToken,
    dirName: azureDirName(repository)
  }
}

/** `[user@]host:v3/org/project/repo`, the SSH address Azure DevOps hands out. */
function parseScp(text: string): AzureRepoRef | null {
  const m = text.match(/^(?:([^@/:\s]+)@)?([^@/:\s]+):v3\/(.+)$/i)
  if (!m) return null
  const [, user = '', host, rest] = m
  if (user && !SSH_USER_RE.test(user)) return null
  const [organization, project, repository] = rest.split('/').filter(Boolean)
  if (!nameable(organization) || !nameable(project) || !nameable(repository)) return null
  const address = `${user ? `${user}@` : ''}${host}:v3/${organization}/${project}/${repository}`
  return build({ organization, project, repository }, host, 'ssh', address, address)
}

/**
 * Read a pasted Azure DevOps link, or `null` when it is not one. Every shape
 * the product hands out is taken:
 *
 * - the Clone button's HTTPS link, `https://org@dev.azure.com/org/project/_git/repo`
 *   (the project drops out when the repository shares its name);
 * - the older `https://org.visualstudio.com/[DefaultCollection/]project/_git/repo`;
 * - Azure DevOps Server, `https://host/[tfs/]collection/project/_git/repo`;
 * - the SSH address, `git@ssh.dev.azure.com:v3/org/project/repo`, also as `ssh://`;
 * - the address bar of any page of the repository, which is the HTTPS link with
 *   more on the end (`?path=…`, `/pullrequest/12`, `/commit/…`);
 * - any of them as part of a pasted `git clone …` line.
 */
export function parseAzureRepoUrl(input: string): AzureRepoRef | null {
  const text = input
    .trim()
    .replace(/^git\s+clone\s+/i, '')
    .split(/\s+/)[0]
    ?.replace(/^["'<]+|["'>]+$/g, '')
  if (!text) return null

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return parseScp(text)

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const ssh = url.protocol === 'ssh:'
  if (!ssh && url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)
  const droppedToken = url.password !== ''
  const origin = (withUser: boolean): string =>
    `${url.protocol}//${withUser && url.username ? `${url.username}@` : ''}${url.host}`
  const transport = ssh ? 'ssh' : 'https'

  // ssh://git@ssh.dev.azure.com/v3/org/project/repo
  if (ssh && segments[0]?.toLowerCase() === 'v3') {
    const [, organization, project, repository] = segments
    if (!nameable(organization) || !nameable(project) || !nameable(repository)) return null
    const path = `/v3/${organization}/${project}/${repository}`
    return build(
      { organization, project, repository },
      host,
      'ssh',
      origin(true) + path,
      origin(false) + path,
      droppedToken
    )
  }

  const at = segments.findIndex((s) => s.toLowerCase() === '_git')
  if (at === -1) return null
  // `_git/_full/repo` and `_git/_optimized/repo` are the same repository, served another way.
  const variant = /^_(full|optimized)$/i.test(segments[at + 1] ?? '') ? 1 : 0
  const repository = segments[at + 1 + variant]
  const before = segments.slice(0, at)
  if (!nameable(repository) || !before.every(nameable)) return null

  let organization: string
  let project: string
  if (host === 'dev.azure.com') {
    if (before.length < 1 || before.length > 2) return null
    organization = before[0]
    project = before[1] ?? repository
  } else if (host.endsWith('.visualstudio.com')) {
    const rest = before[0]?.toLowerCase() === 'defaultcollection' ? before.slice(1) : before
    if (rest.length > 1) return null
    organization = host.slice(0, -'.visualstudio.com'.length)
    project = rest[0] ?? repository
  } else {
    // Azure DevOps Server: the collection, then the project unless the repository is named for it.
    if (before.length < 1) return null
    organization = (before.length > 1 ? before.slice(0, -1) : before).join('/')
    project = before.length > 1 ? before[before.length - 1] : repository
  }

  const path = `/${segments.slice(0, at + 2 + variant).join('/')}`
  return build(
    { organization, project, repository },
    host,
    transport,
    origin(true) + path,
    origin(false) + path,
    droppedToken
  )
}
