// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { azureDirName, parseAzureRepoUrl } from './azure-devops'

/** The parts a form shows, plus what git is handed. */
function read(link: string): Record<string, string> | null {
  const ref = parseAzureRepoUrl(link)
  if (!ref) return null
  const { organization, project, repository, cloneUrl } = ref
  return { organization, project, repository, cloneUrl }
}

describe('parseAzureRepoUrl', () => {
  it('reads the Clone button HTTPS link, with or without the org@ in front', () => {
    expect(read('https://contoso@dev.azure.com/contoso/Website/_git/api')).toEqual({
      organization: 'contoso',
      project: 'Website',
      repository: 'api',
      cloneUrl: 'https://contoso@dev.azure.com/contoso/Website/_git/api'
    })
    expect(read('https://dev.azure.com/contoso/Website/_git/api')?.cloneUrl).toBe(
      'https://dev.azure.com/contoso/Website/_git/api'
    )
  })

  it('takes the project from the repository when the link leaves it out', () => {
    // Azure DevOps drops the project from the link of the repository named after it.
    expect(read('https://dev.azure.com/contoso/_git/Website')).toMatchObject({
      organization: 'contoso',
      project: 'Website',
      repository: 'Website'
    })
  })

  it('cuts the address of a repository page back to the repository', () => {
    const pages = [
      'https://dev.azure.com/contoso/Website/_git/api?path=/src/index.ts&version=GBmain',
      'https://dev.azure.com/contoso/Website/_git/api/pullrequest/412',
      'https://dev.azure.com/contoso/Website/_git/api/commit/0a1b2c3?refName=refs/heads/main',
      'https://dev.azure.com/contoso/Website/_git/api/#readme'
    ]
    for (const page of pages) {
      expect(read(page)?.cloneUrl).toBe('https://dev.azure.com/contoso/Website/_git/api')
    }
  })

  it('reads the older visualstudio.com links', () => {
    expect(read('https://contoso.visualstudio.com/Website/_git/api')).toMatchObject({
      organization: 'contoso',
      project: 'Website',
      repository: 'api'
    })
    expect(read('https://contoso.visualstudio.com/DefaultCollection/Website/_git/api')).toMatchObject({
      organization: 'contoso',
      project: 'Website',
      cloneUrl: 'https://contoso.visualstudio.com/DefaultCollection/Website/_git/api'
    })
    expect(read('https://contoso.visualstudio.com/_git/Website')).toMatchObject({ project: 'Website' })
  })

  it('reads an Azure DevOps Server link, collection and all', () => {
    expect(read('https://tfs.contoso.com:8443/tfs/DefaultCollection/Website/_git/api')).toEqual({
      organization: 'tfs/DefaultCollection',
      project: 'Website',
      repository: 'api',
      cloneUrl: 'https://tfs.contoso.com:8443/tfs/DefaultCollection/Website/_git/api'
    })
    expect(read('http://devops/Main/_git/Website')).toMatchObject({ organization: 'Main', project: 'Website' })
  })

  it('reads the SSH address in both spellings', () => {
    expect(read('git@ssh.dev.azure.com:v3/contoso/Website/api')).toEqual({
      organization: 'contoso',
      project: 'Website',
      repository: 'api',
      cloneUrl: 'git@ssh.dev.azure.com:v3/contoso/Website/api'
    })
    expect(read('contoso@vs-ssh.visualstudio.com:v3/contoso/Website/api')?.repository).toBe('api')
    expect(read('ssh://git@ssh.dev.azure.com/v3/contoso/Website/api')).toMatchObject({
      organization: 'contoso',
      cloneUrl: 'ssh://git@ssh.dev.azure.com/v3/contoso/Website/api'
    })
    expect(parseAzureRepoUrl('git@ssh.dev.azure.com:v3/contoso/Website/api')?.transport).toBe('ssh')
  })

  it('shows names as they are written, and keeps the link as git needs it', () => {
    const ref = parseAzureRepoUrl('https://dev.azure.com/contoso/Web%20Site/_git/My%20API')
    expect(ref).toMatchObject({
      project: 'Web Site',
      repository: 'My API',
      dirName: 'My-API',
      cloneUrl: 'https://dev.azure.com/contoso/Web%20Site/_git/My%20API'
    })
  })

  it('takes the link out of a pasted git clone line', () => {
    expect(read('git clone https://dev.azure.com/contoso/Website/_git/api my-folder')?.repository).toBe('api')
    expect(read('  "https://dev.azure.com/contoso/Website/_git/api"  ')?.repository).toBe('api')
  })

  it('leaves a token that came with the link out of the clone, and says so', () => {
    const ref = parseAzureRepoUrl('https://build:s3cret@dev.azure.com/contoso/Website/_git/api')
    expect(ref?.cloneUrl).toBe('https://build@dev.azure.com/contoso/Website/_git/api')
    expect(ref?.displayUrl).toBe('https://dev.azure.com/contoso/Website/_git/api')
    expect(ref?.droppedToken).toBe(true)
    expect(JSON.stringify(ref)).not.toContain('s3cret')
    expect(parseAzureRepoUrl('https://contoso@dev.azure.com/contoso/Website/_git/api')?.droppedToken).toBe(false)
  })

  it('turns away anything that is not a repository link', () => {
    const not = [
      '',
      'api',
      'contoso/Website/api',
      'https://dev.azure.com/contoso/Website',
      'https://dev.azure.com/contoso/Website/_git/',
      'https://dev.azure.com/_git/api',
      'https://dev.azure.com/a/b/c/_git/api',
      'https://github.com/contoso/api.git',
      'https://dev.azure.com/contoso/Website/_git/..',
      'https://dev.azure.com/contoso/Website/_git/a%2Fb',
      'ext::sh -c "touch /tmp/x"',
      'file:///C:/repos/_git/api',
      'git@github.com:contoso/api.git',
      '-oProxyCommand=x@host:v3/a/b/c'
    ]
    for (const link of not) expect(parseAzureRepoUrl(link), link).toBeNull()
  })
})

describe('azureDirName', () => {
  it('keeps a plain name and tidies the rest into one a folder can carry', () => {
    expect(azureDirName('api')).toBe('api')
    expect(azureDirName('My API (v2)')).toBe('My-API-v2')
    expect(azureDirName('api.git')).toBe('api')
    expect(azureDirName('...')).toBe('repo')
    expect(azureDirName('x'.repeat(140)).length).toBe(100)
  })
})
