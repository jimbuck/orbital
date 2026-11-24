// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { parseAzureRepoUrl, type AzureRepoRef } from '@shared/azure-devops'

const clone = vi.hoisted(() => vi.fn(async (_cwd: string, _url: string, _dest: string): Promise<void> => {}))
vi.mock('./git', () => ({ git: { clone } }))

import { azureDevops, explainCloneError } from './azure-devops'

const https = parseAzureRepoUrl('https://contoso@dev.azure.com/contoso/Website/_git/api') as AzureRepoRef
const ssh = parseAzureRepoUrl('git@ssh.dev.azure.com:v3/contoso/Website/api') as AzureRepoRef

describe('azureDevops.readLink', () => {
  it('hands back the parts of a link, and says what a link looks like otherwise', () => {
    expect(azureDevops.readLink('https://dev.azure.com/contoso/Website/_git/api').repository).toBe('api')
    expect(() => azureDevops.readLink('https://github.com/contoso/api')).toThrow(/_git/)
  })
})

describe('azureDevops.cloneRepo', () => {
  it('clones the link into the destination, from the folder it goes in', async () => {
    await azureDevops.cloneRepo(https, 'C:\\Projects\\api')
    expect(clone).toHaveBeenCalledWith('C:\\Projects', 'https://contoso@dev.azure.com/contoso/Website/_git/api', 'C:\\Projects\\api')
  })

  it('rejects with the explained failure, not git\u2019s raw text', async () => {
    clone.mockRejectedValueOnce(
      new Error(
        "Cloning into 'C:\\Projects\\api'...\nfatal: could not read Username for 'https://contoso@dev.azure.com/contoso/Website/_git/api': terminal prompts disabled\n"
      )
    )
    await expect(azureDevops.cloneRepo(https, 'C:\\Projects\\api')).rejects.toThrow(/Git could not sign in to dev\.azure\.com/)
  })
})

describe('explainCloneError', () => {
  it('says how to sign in when git had no credential', () => {
    const text = explainCloneError(
      "Cloning into 'api'...\nfatal: Authentication failed for 'https://contoso@dev.azure.com/contoso/Website/_git/api/'\n",
      https
    )
    expect(text).toContain('git clone https://dev.azure.com/contoso/Website/_git/api')
    expect(text).toContain('Git said: fatal: Authentication failed')
    // The address git echoes loses its user name on the way to the dialog.
    expect(text).not.toContain('contoso@')
    expect(text).not.toContain('Cloning into')
  })

  it('says what to do about a refused SSH key', () => {
    const text = explainCloneError('git@ssh.dev.azure.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', ssh)
    expect(text).toContain('SSH public keys')
    expect(text).toContain('HTTPS link')
  })

  it('names the repository when Azure DevOps says it is missing or not yours', () => {
    const text = explainCloneError(
      'remote: TF401019: The Git repository with name or identifier api does not exist or you do not have permissions for the operation you are attempting.\nfatal: repository not found',
      https
    )
    expect(text).toBe(
      'Azure DevOps has no repository "api" in contoso/Website that your account can read. Check the link, and which account git is signed in to dev.azure.com with.'
    )
  })

  it('passes anything else through as git said it', () => {
    expect(explainCloneError("fatal: unable to access 'https://dev.azure.com/': Could not resolve host: dev.azure.com", https)).toBe(
      "fatal: unable to access 'https://dev.azure.com/': Could not resolve host: dev.azure.com"
    )
    expect(explainCloneError('git clone timed out after 600s', https)).toBe('git clone timed out after 600s')
    expect(explainCloneError('', https)).toBe('git clone failed.')
  })
})
