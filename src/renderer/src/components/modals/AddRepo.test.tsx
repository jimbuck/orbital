import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Project, RailFolder, Repo } from '@shared/types'
import type { GithubAccountRef, GithubContext, GithubCreateRepoOptions, GithubRepoSummary } from '@shared/github'
import { useStore } from '@renderer/store'

import AddRepo, { type AddRepoTarget } from './AddRepo'
import { joinPath, timeAgo } from './AddRepoGithub'

/**
 * The Add Repo dialog has four sources behind one radio group. These tests
 * pin the wiring for each: the local picker still does what it did, the two
 * GitHub forms load the gh context once, gate their primary action on the
 * right things, and hand the bridge exactly the request the form describes,
 * and the Azure DevOps form reads a pasted link back before cloning it. Opened
 * from a project or a rail folder, every source adds the repo there.
 */

const repo: Repo = {
  id: 'p1',
  name: 'orbital',
  repoPath: 'C:\\Projects\\orbital',
  defaultAgentId: 'claude',
  addedAt: 0
}

const personal: GithubAccountRef = { host: 'github.com', login: 'jimbuck' }
const work: GithubAccountRef = { host: 'github.com', login: 'jimbuckrda' }

const ctx: GithubContext = {
  accounts: [
    { ...personal, active: true },
    { ...work, active: false }
  ],
  account: personal,
  user: 'jimbuck',
  owners: ['jimbuck', 'acme'],
  licenses: [{ key: 'mit', name: 'MIT License' }],
  gitignoreTemplates: ['Node', 'C++']
}

/** The same gh install seen as the work account: its own login and org. */
const workCtx: GithubContext = { ...ctx, account: work, user: 'jimbuckrda', owners: ['jimbuckrda', 'RDACorp'] }

/** What main does with an account ref: describe that account, else the active one. */
const contextFor = async (account?: GithubAccountRef): Promise<GithubContext> =>
  account?.login === work.login ? workCtx : ctx

const repos: GithubRepoSummary[] = [
  {
    name: 'orbital',
    nameWithOwner: 'jimbuck/orbital',
    description: 'A cockpit',
    visibility: 'public',
    url: 'https://github.com/jimbuck/orbital',
    isTemplate: false,
    isArchived: false,
    isEmpty: false,
    pushedAt: '2026-09-10T00:00:00Z'
  },
  {
    name: 'secret',
    nameWithOwner: 'jimbuck/secret',
    description: '',
    visibility: 'private',
    url: 'https://github.com/jimbuck/secret',
    isTemplate: false,
    isArchived: true,
    isEmpty: false,
    pushedAt: '2025-01-01T00:00:00Z'
  }
]

const addRepo = vi.fn(async (): Promise<Repo | null> => repo)
const pickDirectory = vi.fn(async (): Promise<string | null> => 'D:\\Code')
const githubContext = vi.fn(contextFor)
const githubListRepos = vi.fn(async (_owner: string) => repos)
const githubCheckRepoName = vi.fn(async (_owner: string, _name: string) => ({ ok: true }))
const githubCreateRepo = vi.fn(async (opts: GithubCreateRepoOptions) => ({
  nameWithOwner: `${opts.owner}/${opts.name}`,
  url: `https://github.com/${opts.owner}/${opts.name}`
}))
const githubCloneRepo = vi.fn(async (_nameWithOwner: string, _parentDir: string): Promise<Repo> => repo)
const azureCloneRepo = vi.fn(async (_link: string, _parentDir: string, ..._where: unknown[]): Promise<Repo> => repo)
const readClipboard = vi.fn((): string => '')
const setRailFolderCollapsed = vi.fn(async (_folderId: string, _collapsed: boolean): Promise<void> => undefined)

function seed(repos: Repo[] = [repo]): void {
  useStore.setState({
    repos,
    projects: [],
    railFolders: [],
    expanded: {},
    renamingProjectId: null,
    worktrees: [],
    tasks: [],
    activeRepoId: repos[0]?.id ?? null,
    activeWorktreeId: null,
    modal: 'addRepo',
    modalStack: [{ type: 'addRepo', data: null }],
    modalData: null
  } as unknown as Parameters<typeof useStore.setState>[0])
}

function sourceRadio(name: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Repo source' })).getByRole('radio', { name })
}

/** Render and, for a GitHub mode, wait for the context to land so the form is live. */
async function open(mode: 'local' | 'clone' | 'create' = 'local'): Promise<void> {
  seed()
  render(<AddRepo />)
  if (mode === 'local') return
  fireEvent.click(sourceRadio(mode === 'clone' ? 'Clone from GitHub' : 'New GitHub repo'))
  await waitFor(() => expect(githubContext).toHaveBeenCalled())
  // The owner picker is populated only once the context is ready.
  await waitFor(() => expect(screen.getByRole('option', { name: 'acme' })).toBeTruthy())
}

beforeEach(() => {
  // Reset implementations too: a `mockImplementationOnce` a failing test never
  // consumed would otherwise fire in the next one.
  addRepo.mockReset().mockImplementation(async () => repo)
  pickDirectory.mockReset().mockImplementation(async () => 'D:\\Code')
  githubContext.mockReset().mockImplementation(contextFor)
  githubListRepos.mockReset().mockImplementation(async () => repos)
  githubCheckRepoName.mockReset().mockImplementation(async () => ({ ok: true }))
  githubCreateRepo.mockReset().mockImplementation(async (opts: GithubCreateRepoOptions) => ({
    nameWithOwner: `${opts.owner}/${opts.name}`,
    url: `https://github.com/${opts.owner}/${opts.name}`
  }))
  githubCloneRepo.mockReset().mockImplementation(async () => repo)
  azureCloneRepo.mockReset().mockImplementation(async () => repo)
  readClipboard.mockReset().mockImplementation(() => '')
  setRailFolderCollapsed.mockReset().mockImplementation(async () => undefined)
  vi.stubGlobal('orbital', {
    addRepo,
    azureCloneRepo,
    readClipboard,
    setRailFolderCollapsed,
    pickDirectory,
    githubContext,
    githubListRepos,
    githubCheckRepoName,
    githubCreateRepo,
    githubCloneRepo
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AddRepo — source switch', () => {
  it('starts on the local folder picker and does not touch gh until asked', async () => {
    await open()
    expect(screen.getByRole('button', { name: /Choose folder/ })).toBeTruthy()
    expect(githubContext).not.toHaveBeenCalled()
  })

  it('opens the native picker and closes once a repo comes back', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }))
    await waitFor(() => expect(addRepo).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
  })

  it('loads the gh context once and keeps it while flipping between the GitHub modes', async () => {
    await open('create')
    fireEvent.click(sourceRadio('Clone from GitHub'))
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Repositories' })).toBeTruthy())
    fireEvent.click(sourceRadio('New GitHub repo'))
    expect(screen.getByLabelText('Repository name')).toBeTruthy()
    expect(githubContext).toHaveBeenCalledTimes(1)
  })

  it('shows the gh failure with a retry instead of a dead form', async () => {
    githubContext.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'orbital:githubContext': Error: You are not logged into any GitHub hosts. Run gh auth login")
    })
    seed()
    render(<AddRepo />)
    fireEvent.click(sourceRadio('New GitHub repo'))
    const alert = await screen.findByRole('alert')
    // Electron's IPC wrapper is stripped so the user sees gh's own sentence.
    expect(alert.textContent).toContain('You are not logged into any GitHub hosts')
    expect(alert.textContent).not.toContain('Error invoking remote method')
    expect(screen.getByRole('button', { name: 'Create repository' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(within(alert).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(githubContext).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('AddRepo — new GitHub repo', () => {
  it('defaults the owner to the signed-in user and the folder to beside an existing repo', async () => {
    await open('create')
    expect((screen.getByLabelText('Owner') as HTMLSelectElement).value).toBe('jimbuck')
    expect((screen.getByLabelText(/Local folder/) as HTMLInputElement).value).toBe('C:\\Projects')
  })

  it('validates the name locally, offers GitHub\u2019s rewrite, then checks availability', async () => {
    await open('create')
    const name = screen.getByLabelText('Repository name')

    fireEvent.change(name, { target: { value: 'my app' } })
    expect(screen.getByText(/Only letters, numbers/)).toBeTruthy()
    expect(githubCheckRepoName).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use my-app?' }))
    expect((name as HTMLInputElement).value).toBe('my-app')

    await waitFor(() => expect(githubCheckRepoName).toHaveBeenCalledWith('jimbuck', 'my-app', personal), { timeout: 2000 })
    await waitFor(() => expect(screen.getByText(/is available\./)).toBeTruthy())
  })

  it('blocks creating a name that is already taken', async () => {
    githubCheckRepoName.mockImplementation(async () => ({ ok: false, reason: 'jimbuck/orbital already exists on GitHub.' }))
    await open('create')
    fireEvent.change(screen.getByLabelText('Repository name'), { target: { value: 'orbital' } })
    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy(), { timeout: 2000 })
    expect(screen.getByRole('button', { name: 'Create repository' }).hasAttribute('disabled')).toBe(true)
    expect(githubCreateRepo).not.toHaveBeenCalled()
  })

  it('only offers "internal" under an organization owner', async () => {
    await open('create')
    const visibility = (): HTMLElement => screen.getByRole('radiogroup', { name: 'Visibility' })
    expect(within(visibility()).queryByRole('radio', { name: 'Internal' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'acme' } })
    expect(within(visibility()).getByRole('radio', { name: 'Internal' })).toBeTruthy()
    // The org-only team field lives under "More options".
    fireEvent.click(screen.getByRole('button', { name: /More options/ }))
    expect(screen.getByLabelText(/^Team/)).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Internal' }))
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'jimbuck' } })
    // Back on a personal owner the impossible choice is dropped, not sent.
    expect(within(visibility()).queryByRole('radio', { name: 'Internal' })).toBeNull()
    expect(within(visibility()).getByRole('radio', { name: 'Private' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByLabelText(/^Team/)).toBeNull()
  })

  it('creates with every option the form collected, then clones into the chosen folder', async () => {
    await open('create')
    fireEvent.change(screen.getByLabelText('Repository name'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'A demo' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Public' }))
    fireEvent.click(screen.getByRole('button', { name: /More options/ }))
    fireEvent.change(screen.getByLabelText('.gitignore template'), { target: { value: 'Node' } })
    fireEvent.change(screen.getByLabelText('License'), { target: { value: 'mit' } })
    fireEvent.click(screen.getByLabelText('Disable wiki'))
    fireEvent.change(screen.getByLabelText(/Homepage URL/), { target: { value: 'https://demo.dev' } })
    fireEvent.click(screen.getByRole('button', { name: 'Browse for a folder' }))
    await waitFor(() => expect((screen.getByLabelText(/Local folder/) as HTMLInputElement).value).toBe('D:\\Code'))
    // The resulting path is spelled out so nobody is surprised where it lands.
    expect(screen.getByText('D:\\Code\\demo')).toBeTruthy()

    await waitFor(() => expect(screen.getByText(/is available\./)).toBeTruthy(), { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: 'Create repository' }))

    await waitFor(() => expect(githubCreateRepo).toHaveBeenCalledTimes(1))
    expect(githubCreateRepo.mock.calls[0][0]).toMatchObject({
      owner: 'jimbuck',
      name: 'demo',
      visibility: 'public',
      description: 'A demo',
      homepage: 'https://demo.dev',
      gitignore: 'Node',
      license: 'mit',
      addReadme: true,
      disableIssues: false,
      disableWiki: true,
      template: undefined,
      team: undefined
    })
    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledWith('jimbuck/demo', 'D:\\Code', personal, undefined, undefined))
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
  })

  it('sends the template instead of gitignore / license / README when one is given', async () => {
    await open('create')
    fireEvent.change(screen.getByLabelText('Repository name'), { target: { value: 'demo' } })
    fireEvent.click(screen.getByRole('button', { name: /More options/ }))
    fireEvent.change(screen.getByLabelText('.gitignore template'), { target: { value: 'Node' } })
    fireEvent.change(screen.getByLabelText(/Template repository/), { target: { value: 'jimbuck/starter' } })
    // Those pickers are now moot and say so.
    expect(screen.getByLabelText('.gitignore template').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByLabelText(/Include all branches/))

    await waitFor(() => expect(screen.getByText(/is available\./)).toBeTruthy(), { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: 'Create repository' }))
    await waitFor(() => expect(githubCreateRepo).toHaveBeenCalledTimes(1))
    expect(githubCreateRepo.mock.calls[0][0]).toMatchObject({
      template: 'jimbuck/starter',
      includeAllBranches: true,
      gitignore: undefined,
      license: undefined,
      addReadme: undefined
    })
  })

  it('keeps the created repo and offers only a clone retry when the clone fails', async () => {
    githubCloneRepo.mockImplementationOnce(async () => {
      throw new Error('fatal: could not write to D:\\Code\\demo')
    })
    await open('create')
    fireEvent.change(screen.getByLabelText('Repository name'), { target: { value: 'demo' } })
    await waitFor(() => expect(screen.getByText(/is available\./)).toBeTruthy(), { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: 'Create repository' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('was created at https://github.com/jimbuck/demo')
    expect(alert.textContent).toContain('could not write')
    expect(useStore.getState().modal).toBe('addRepo')
    // The form is frozen on the repo that now exists; only the clone reruns.
    expect(screen.getByLabelText('Repository name').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry clone' }))
    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledTimes(2))
    expect(githubCreateRepo).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
  })
})

describe('AddRepo — clone from GitHub', () => {
  it('lists the owner\u2019s repositories with their visibility and filters as you type', async () => {
    await open('clone')
    await waitFor(() => expect(githubListRepos).toHaveBeenCalledWith('jimbuck', personal))
    const list = screen.getByRole('listbox', { name: 'Repositories' })
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
    expect(within(list).getByRole('option', { name: /orbital.*Public/ })).toBeTruthy()
    expect(within(list).getByRole('option', { name: /secret.*Private.*Archived/ })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'sec' } })
    expect(within(list).getAllByRole('option')).toHaveLength(1)
  })

  it('reloads the list when the owner changes', async () => {
    await open('clone')
    await waitFor(() => expect(githubListRepos).toHaveBeenCalledWith('jimbuck', personal))
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'acme' } })
    await waitFor(() => expect(githubListRepos).toHaveBeenCalledWith('acme', personal))
  })

  it('clones the selected repository into the chosen folder', async () => {
    await open('clone')
    const list = screen.getByRole('listbox', { name: 'Repositories' })
    const row = await within(list).findByRole('option', { name: /orbital/ })
    const clone = screen.getByRole('button', { name: 'Clone repository' })
    expect(clone.hasAttribute('disabled')).toBe(true)

    fireEvent.click(row)
    expect(row.getAttribute('aria-selected')).toBe('true')
    // The folder defaults to the last one cloned into this session (or beside
    // an existing repo), so read it rather than assume which.
    const parent = (screen.getByLabelText(/Local folder/) as HTMLInputElement).value
    expect(parent).toBeTruthy()
    expect(screen.getByText(`${parent}\\orbital`)).toBeTruthy()
    fireEvent.click(clone)

    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledWith('jimbuck/orbital', parent, personal, undefined, undefined))
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
  })

  it('offers a typed owner/repo that is not in the list', async () => {
    await open('clone')
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'cli/cli' } })
    const list = screen.getByRole('listbox', { name: 'Repositories' })
    fireEvent.click(within(list).getByRole('option', { name: /cli\/cli/ }))
    const parent = (screen.getByLabelText(/Local folder/) as HTMLInputElement).value
    fireEvent.click(screen.getByRole('button', { name: 'Clone repository' }))
    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledWith('cli/cli', parent, personal, undefined, undefined))
  })

  it('surfaces a clone failure and stays open', async () => {
    githubCloneRepo.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'orbital:githubCloneRepo': Error: D:\\x\\orbital already exists and is not empty.")
    })
    await open('clone')
    const list = screen.getByRole('listbox', { name: 'Repositories' })
    fireEvent.click(await within(list).findByRole('option', { name: /orbital/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Clone repository' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('D:\\x\\orbital already exists and is not empty.')
    expect(useStore.getState().modal).toBe('addRepo')
  })
})

describe('AddRepo — GitHub account picker', () => {
  it('lists every signed-in account, defaulting to the active one, and hides itself with only one', async () => {
    await open('create')
    const picker = screen.getByLabelText(/GitHub account/) as HTMLSelectElement
    expect(picker.value).toBe('github.com/jimbuck')
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['jimbuck (active)', 'jimbuckrda'])
    // The first load asks for gh's own active account, not a specific one.
    expect(githubContext).toHaveBeenCalledWith(undefined)
    cleanup()

    githubContext.mockImplementation(async () => ({ ...ctx, accounts: [{ ...personal, active: true }] }))
    await open('create')
    expect(screen.queryByLabelText(/GitHub account/)).toBeNull()
  })

  it('reloads the context as the chosen account and acts as it from then on', async () => {
    await open('create')
    fireEvent.change(screen.getByLabelText(/GitHub account/), { target: { value: 'github.com/jimbuckrda' } })

    await waitFor(() => expect(githubContext).toHaveBeenLastCalledWith(work))
    // Owners now belong to the work account; the picker keeps its choice.
    await waitFor(() => expect((screen.getByLabelText('Owner') as HTMLSelectElement).value).toBe('jimbuckrda'))
    expect(screen.getByRole('option', { name: 'RDACorp' })).toBeTruthy()
    expect((screen.getByLabelText(/GitHub account/) as HTMLSelectElement).value).toBe('github.com/jimbuckrda')

    fireEvent.change(screen.getByLabelText('Repository name'), { target: { value: 'demo' } })
    await waitFor(() => expect(githubCheckRepoName).toHaveBeenCalledWith('jimbuckrda', 'demo', work), {
      timeout: 2000
    })
    await waitFor(() => expect(screen.getByText(/is available\./)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Create repository' }))

    await waitFor(() => expect(githubCreateRepo).toHaveBeenCalledTimes(1))
    expect(githubCreateRepo.mock.calls[0][0]).toMatchObject({ account: work, owner: 'jimbuckrda', name: 'demo' })
    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledWith('jimbuckrda/demo', expect.any(String), work, undefined, undefined))
  })

  it('keeps the account across the two GitHub modes and re-lists repositories as it', async () => {
    await open('clone')
    await waitFor(() => expect(githubListRepos).toHaveBeenCalledWith('jimbuck', personal))
    fireEvent.change(screen.getByLabelText(/GitHub account/), { target: { value: 'github.com/jimbuckrda' } })
    await waitFor(() => expect(githubListRepos).toHaveBeenCalledWith('jimbuckrda', work))

    fireEvent.click(sourceRadio('New GitHub repo'))
    await waitFor(() => expect((screen.getByLabelText('Owner') as HTMLSelectElement).value).toBe('jimbuckrda'))
    expect((screen.getByLabelText(/GitHub account/) as HTMLSelectElement).value).toBe('github.com/jimbuckrda')
    // One load per account, not one per mode.
    expect(githubContext).toHaveBeenCalledTimes(2)
  })
})

describe('AddRepo — Azure DevOps', () => {
  const link = 'https://contoso@dev.azure.com/contoso/Website/_git/api'

  async function openAzure(): Promise<void> {
    seed()
    render(<AddRepo />)
    fireEvent.click(sourceRadio('Azure DevOps'))
  }
  const cloneButton = (): HTMLElement => screen.getByRole('button', { name: 'Clone repository' })
  const linkField = (): HTMLInputElement => screen.getByLabelText(/Repository link/) as HTMLInputElement
  /** The folder the form defaults to: beside an existing repo, or wherever the last clone went. */
  const parentDir = (): string => (screen.getByLabelText(/Local folder/) as HTMLInputElement).value

  it('needs nothing from gh, and waits for a link', async () => {
    await openAzure()
    expect(githubContext).not.toHaveBeenCalled()
    expect(linkField().value).toBe('')
    expect(cloneButton().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/choose Clone and copy the HTTPS or SSH link/)).toBeTruthy()
  })

  it('reads a pasted link back as its parts and clones it beside the other repos', async () => {
    await openAzure()
    fireEvent.change(linkField(), { target: { value: `${link}?path=/src&version=GBmain` } })

    const parts = screen.getAllByRole('definition').map((d) => d.textContent)
    expect(parts).toEqual(['contoso', 'Website', 'api'])
    // Where it lands: the default folder, in a folder named for the repository.
    const parent = parentDir()
    expect(parent).not.toBe('')
    expect(screen.getByText(joinPath(parent, 'api'))).toBeTruthy()

    fireEvent.click(cloneButton())
    // The page address was cut back to the repository itself.
    await waitFor(() => expect(azureCloneRepo).toHaveBeenCalledWith(link, parent, undefined, undefined))
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
  })

  it('takes the SSH address too, and says which way it clones', async () => {
    await openAzure()
    fireEvent.change(linkField(), { target: { value: 'git@ssh.dev.azure.com:v3/contoso/Website/api' } })
    expect(screen.getByText(/Cloned over SSH/)).toBeTruthy()
    fireEvent.keyDown(linkField(), { key: 'Enter' })
    await waitFor(() =>
      expect(azureCloneRepo).toHaveBeenCalledWith(
        'git@ssh.dev.azure.com:v3/contoso/Website/api',
        expect.any(String),
        undefined,
        undefined
      )
    )
  })

  it('says so when what was typed is not a repository link, and does not clone', async () => {
    await openAzure()
    fireEvent.change(linkField(), { target: { value: 'https://github.com/contoso/api' } })
    expect(screen.getByText(/That is not an Azure DevOps repository link/)).toBeTruthy()
    expect(linkField().getAttribute('aria-invalid')).toBe('true')
    expect(cloneButton().hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(linkField(), { key: 'Enter' })
    expect(azureCloneRepo).not.toHaveBeenCalled()
  })

  it('starts with the link on the clipboard when there is one, and says where it came from', async () => {
    readClipboard.mockReturnValue(`  ${link}  `)
    await openAzure()
    expect(linkField().value).toBe(link)
    expect(screen.getByText(/Filled in from your clipboard/)).toBeTruthy()
    expect(cloneButton().hasAttribute('disabled')).toBe(false)
  })

  it('leaves the field empty when the clipboard holds something else', async () => {
    readClipboard.mockReturnValue('npm run build')
    await openAzure()
    expect(linkField().value).toBe('')
  })

  it('pastes on request, whatever is there, so a bad paste can be seen and fixed', async () => {
    await openAzure()
    readClipboard.mockReturnValue('https://dev.azure.com/contoso/Website')
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(linkField().value).toBe('https://dev.azure.com/contoso/Website')
    expect(screen.getByText(/That is not an Azure DevOps repository link/)).toBeTruthy()
  })

  it('clones without a token that was written into the link, and explains', async () => {
    await openAzure()
    fireEvent.change(linkField(), { target: { value: 'https://build:s3cret@dev.azure.com/contoso/Website/_git/api' } })
    expect(screen.getByText(/The token in this link is left out/)).toBeTruthy()
    fireEvent.click(cloneButton())
    await waitFor(() => expect(azureCloneRepo).toHaveBeenCalledTimes(1))
    expect(azureCloneRepo.mock.calls[0][0]).toBe('https://build@dev.azure.com/contoso/Website/_git/api')
  })

  it('shows why a clone failed and stays open to try again', async () => {
    azureCloneRepo.mockImplementationOnce(async () => {
      throw new Error(
        "Error invoking remote method 'orbital:azureCloneRepo': Error: Git could not sign in to dev.azure.com. Run `git clone` once in a terminal."
      )
    })
    await openAzure()
    fireEvent.change(linkField(), { target: { value: link } })
    fireEvent.click(cloneButton())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Git could not sign in to dev.azure.com. Run `git clone` once in a terminal.')
    expect(useStore.getState().modal).toBe('addRepo')
    expect(cloneButton().hasAttribute('disabled')).toBe(false)
  })
})

describe('AddRepo — opened from a project or a folder', () => {
  const project = (id: string, name: string, repoIds: string[], homeRepoId: string | null = null): Project => ({
    id,
    name,
    rootPath: `D:\\Work\\${id}`,
    homeRepoId,
    managedBlock: true,
    codeWorkspace: false,
    repoIds,
    createdAt: 0
  })
  const acme = project('acme', 'Acme', ['home', 'api'], 'home')
  const apps: RailFolder = { id: 'f-apps', name: 'Apps', collapsed: true, projectId: 'acme', parentId: null, items: [] }
  const mobile: RailFolder = { id: 'f-mobile', name: 'Mobile', collapsed: false, projectId: 'acme', parentId: 'f-apps', items: [] }
  const clients: RailFolder = { id: 'f-clients', name: 'Clients', collapsed: false, projectId: null, parentId: null, items: [] }

  function openFrom(target: AddRepoTarget, projects: Project[] = [acme]): void {
    seed()
    useStore.setState({
      projects,
      railFolders: [apps, mobile, clients],
      modalStack: [{ type: 'addRepo', data: target }],
      modalData: target
    } as unknown as Parameters<typeof useStore.setState>[0])
    render(<AddRepo />)
  }

  it('adds a local repo to the folder it was opened from, in that folder\u2019s project', async () => {
    openFrom({ projectId: 'acme', folderId: 'f-mobile' })
    expect(screen.getByText('Acme').parentElement?.textContent).toBe('Adding to Acme › Apps › Mobile')

    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }))
    await waitFor(() => expect(addRepo).toHaveBeenCalledWith('acme', 'f-mobile'))
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
    // What it was added to is opened, so the new row is on screen: the one
    // folder around it that was shut, and the project.
    expect(setRailFolderCollapsed.mock.calls).toEqual([['f-apps', false]])
    expect(useStore.getState().expanded.acme).toBe(true)
  })

  it('goes by the folder for the project, since a folder of repos belongs to one', async () => {
    // The folder alone is enough, and it wins over a project that disagrees.
    openFrom({ projectId: 'elsewhere', folderId: 'f-apps' })
    expect(screen.getByText('Acme').parentElement?.textContent).toBe('Adding to Acme › Apps')
    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }))
    await waitFor(() => expect(addRepo).toHaveBeenCalledWith('acme', 'f-apps'))
  })

  it('adds to a folder of projects as a row of its own, with no project', async () => {
    openFrom({ folderId: 'f-clients' })
    expect(screen.getByText('Clients').parentElement?.textContent).toBe('Adding to the folder Clients')
    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }))
    await waitFor(() => expect(addRepo).toHaveBeenCalledWith(undefined, 'f-clients'))
  })

  it('carries the folder through a GitHub clone, into the project\u2019s root folder', async () => {
    openFrom({ projectId: 'acme', folderId: 'f-apps' })
    fireEvent.click(sourceRadio('Clone from GitHub'))
    fireEvent.click(await screen.findByRole('option', { name: /orbital/ }))
    expect((screen.getByLabelText(/Local folder/) as HTMLInputElement).value).toBe('D:\\Work\\acme')
    fireEvent.click(screen.getByRole('button', { name: 'Clone repository' }))
    await waitFor(() =>
      expect(githubCloneRepo).toHaveBeenCalledWith('jimbuck/orbital', 'D:\\Work\\acme', personal, 'acme', 'f-apps')
    )
  })

  it('carries the folder through an Azure DevOps clone', async () => {
    openFrom({ folderId: 'f-clients' })
    fireEvent.click(sourceRadio('Azure DevOps'))
    fireEvent.change(screen.getByLabelText(/Repository link/), {
      target: { value: 'https://dev.azure.com/contoso/Website/_git/api' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clone repository' }))
    await waitFor(() =>
      expect(azureCloneRepo).toHaveBeenCalledWith(
        'https://dev.azure.com/contoso/Website/_git/api',
        expect.any(String),
        undefined,
        'f-clients'
      )
    )
  })

  it('says a second repo starts a project, clones beside the first, and opens the new project into its name', async () => {
    const flat: Project = { ...project('solo', 'orbital', ['p1']), rootPath: 'C:\\Projects\\orbital' }
    openFrom({ projectId: 'solo' }, [flat])
    expect(screen.getByText('orbital').parentElement?.textContent).toBe('Starts a project with orbital')
    // Not "in orbital": that is the repo it will sit beside.
    expect(screen.getByText('Open a local git repo in Orbital')).toBeTruthy()

    fireEvent.click(sourceRadio('Azure DevOps'))
    // Beside the repo, never inside its working tree.
    expect((screen.getByLabelText(/Local folder/) as HTMLInputElement).value).toBe('C:\\Projects')
    fireEvent.change(screen.getByLabelText(/Repository link/), {
      target: { value: 'https://dev.azure.com/contoso/Website/_git/api' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clone repository' }))
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
    expect(azureCloneRepo.mock.calls[0].slice(2)).toEqual(['solo', undefined])
    expect(useStore.getState().renamingProjectId).toBe('solo')
  })

  it('names the project in the local picker, and leaves a real project alone once the repo is in', async () => {
    openFrom({ projectId: 'acme' })
    expect(screen.getByText('Open a local git repo in Acme')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }))
    await waitFor(() => expect(addRepo).toHaveBeenCalledWith('acme', undefined))
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
    expect(useStore.getState().renamingProjectId).toBeNull()
    expect(setRailFolderCollapsed).not.toHaveBeenCalled()
  })
})

describe('helpers', () => {
  it('joinPath follows the separator the parent already uses', () => {
    expect(joinPath('C:\\Projects\\', 'demo')).toBe('C:\\Projects\\demo')
    expect(joinPath('/home/me/code', 'demo')).toBe('/home/me/code/demo')
    expect(joinPath('', 'demo')).toBe('demo')
  })

  it('timeAgo rounds to the coarsest useful unit', () => {
    const now = Date.parse('2026-09-10T12:00:00Z')
    expect(timeAgo('2026-09-10T11:59:50Z', now)).toBe('just now')
    expect(timeAgo('2026-09-10T11:30:00Z', now)).toBe('30m ago')
    expect(timeAgo('2026-09-10T06:00:00Z', now)).toBe('6h ago')
    expect(timeAgo('2026-09-01T12:00:00Z', now)).toBe('9d ago')
    expect(timeAgo('2026-03-10T12:00:00Z', now)).toBe('6mo ago')
    expect(timeAgo('2020-09-10T12:00:00Z', now)).toBe('6y ago')
    expect(timeAgo('', now)).toBe('')
  })
})
