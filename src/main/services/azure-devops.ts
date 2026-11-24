/**
 * Azure DevOps: cloning the repository a pasted link points at.
 *
 * There is no Azure tooling behind this, only git. The Azure CLI cannot clone
 * (it lists and manages; the clone is still `git clone`), so asking for it
 * would add an install, an extension and a second sign-in without removing
 * the need for git's own credentials. Those are what this uses: Git Credential
 * Manager, which ships with Git for Windows and signs in to Azure DevOps in
 * its own window, or an SSH key for an SSH link. Whoever can already clone
 * from Azure DevOps in a terminal can clone here.
 *
 * Link reading is in shared/azure-devops.ts; this is the process side.
 */
import { dirname } from 'node:path'
import { AZURE_LINK_HINT, parseAzureRepoUrl, type AzureRepoRef } from '@shared/azure-devops'
import { git } from './git'

/** The link's parts, or an error saying what a link looks like. */
function readLink(link: string): AzureRepoRef {
  const ref = parseAzureRepoUrl(link)
  if (!ref) throw new Error(AZURE_LINK_HINT)
  return ref
}

/** Git's progress chatter, which is not part of why a clone failed. */
const NOISE = /^(Cloning into |warning: |hint: |$)/

/**
 * What git said, cut to the lines that say why, with any `user@` in a URL
 * taken out (git echoes the address it was given).
 */
function gitSaid(stderr: string): string {
  return stderr
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !NOISE.test(line))
    .join(' ')
    .replace(/(\w+:\/\/)[^/@\s]+@/g, '$1')
    .trim()
}

/**
 * A failed clone in words someone can act on. Git's own text for the three
 * ordinary failures (no credential, a refused key, a repository that is not
 * there or not theirs) names none of the things that fix them.
 */
export function explainCloneError(stderr: string, ref: AzureRepoRef): string {
  const said = gitSaid(stderr)
  const where = `${ref.organization}/${ref.project}`
  const quote = said ? ` Git said: ${said}` : ''
  if (/timed out after/i.test(said)) return said
  if (/TF401019|does not exist or you do not have permissions/i.test(said)) {
    return `Azure DevOps has no repository "${ref.repository}" in ${where} that your account can read. Check the link, and which account git is signed in to ${ref.host} with.`
  }
  if (/Permission denied \(publickey|Host key verification failed/i.test(said)) {
    return `${ref.host} turned down the SSH connection. Add your public key in Azure DevOps under User settings, SSH public keys, or paste the repository's HTTPS link instead.${quote}`
  }
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|HTTP 40[13]|error: 40[13]/i.test(said)) {
    return `Git could not sign in to ${ref.host}. Run \`git clone ${ref.displayUrl}\` once in a terminal to sign in and store the credential, then try again here. The repository's SSH link also works if you have a key set up.${quote}`
  }
  return said || 'git clone failed.'
}

/** `git clone` the repository into `dest`, with whatever credentials git has for it. */
async function cloneRepo(ref: AzureRepoRef, dest: string): Promise<void> {
  try {
    await git.clone(dirname(dest), ref.cloneUrl, dest)
  } catch (err) {
    throw new Error(explainCloneError(err instanceof Error ? err.message : String(err), ref))
  }
}

export const azureDevops = { readLink, cloneRepo }
