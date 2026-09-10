import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Project } from '@shared/types'
import type { GithubContext, GithubCreateRepoOptions, GithubRepoSummary } from '@shared/github'
import { useStore } from '@renderer/store'

import AddProject from './AddProject'
import { joinPath, timeAgo } from './AddProjectGithub'

/**
 * The Add Project dialog has three sources behind one radio group. These tests
 * pin the wiring for each: the local picker still does what it did, and the
 * two GitHub forms load the gh context once, gate their primary action on the
 * right things, and hand the bridge exactly the request the form describes.
 */

const project: Project = {
  id: 'p1',
  name: 'orbital',
  repoPath: 'C:\\Projects\\orbital',
  defaultAgentId: 'claude',
  addedAt: 0
}

const ctx: GithubContext = {
  user: 'jimbuck',
  owners: ['jimbuck', 'acme'],
  licenses: [{ key: 'mit', name: 'MIT License' }],
  gitignoreTemplates: ['Node', 'C++']
}

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

const addProject = vi.fn(async (): Promise<Project | null> => project)
const pickDirectory = vi.fn(async (): Promise<string | null> => 'D:\\Code')
const githubContext = vi.fn(async (): Promise<GithubContext> => ctx)
const githubListRepos = vi.fn(async (_owner: string) => repos)
const githubCheckRepoName = vi.fn(async (_owner: string, _name: string) => ({ ok: true }))
const githubCreateRepo = vi.fn(async (opts: GithubCreateRepoOptions) => ({
  nameWithOwner: `${opts.owner}/${opts.name}`,
  url: `https://github.com/${opts.owner}/${opts.name}`
}))
const githubCloneRepo = vi.fn(async (_nameWithOwner: string, _parentDir: string): Promise<Project> => project)

function seed(projects: Project[] = [project]): void {
  useStore.setState({
    projects,
    worktrees: [],
    tasks: [],
    activeProjectId: projects[0]?.id ?? null,
    activeWorktreeId: null,
    modal: 'addProject',
    modalStack: [{ type: 'addProject', data: null }],
    modalData: null
  } as unknown as Parameters<typeof useStore.setState>[0])
}

function sourceRadio(name: string): HTMLElement {
  return within(screen.getByRole('radiogroup', { name: 'Project source' })).getByRole('radio', { name })
}

/** Render and, for a GitHub mode, wait for the context to land so the form is live. */
async function open(mode: 'local' | 'clone' | 'create' = 'local'): Promise<void> {
  seed()
  render(<AddProject />)
  if (mode === 'local') return
  fireEvent.click(sourceRadio(mode === 'clone' ? 'Clone from GitHub' : 'New GitHub repo'))
  await waitFor(() => expect(githubContext).toHaveBeenCalled())
  // The owner picker is populated only once the context is ready.
  await waitFor(() => expect(screen.getByRole('option', { name: 'acme' })).toBeTruthy())
}

beforeEach(() => {
  // Reset implementations too: a `mockImplementationOnce` a failing test never
  // consumed would otherwise fire in the next one.
  addProject.mockReset().mockImplementation(async () => project)
  pickDirectory.mockReset().mockImplementation(async () => 'D:\\Code')
  githubContext.mockReset().mockImplementation(async () => ctx)
  githubListRepos.mockReset().mockImplementation(async () => repos)
  githubCheckRepoName.mockReset().mockImplementation(async () => ({ ok: true }))
  githubCreateRepo.mockReset().mockImplementation(async (opts: GithubCreateRepoOptions) => ({
    nameWithOwner: `${opts.owner}/${opts.name}`,
    url: `https://github.com/${opts.owner}/${opts.name}`
  }))
  githubCloneRepo.mockReset().mockImplementation(async () => project)
  vi.stubGlobal('orbital', {
    addProject,
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

describe('AddProject — source switch', () => {
  it('starts on the local folder picker and does not touch gh until asked', async () => {
    await open()
    expect(screen.getByRole('button', { name: /Choose folder/ })).toBeTruthy()
    expect(githubContext).not.toHaveBeenCalled()
  })

  it('opens the native picker and closes once a project comes back', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }))
    await waitFor(() => expect(addProject).toHaveBeenCalledTimes(1))
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
    render(<AddProject />)
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

describe('AddProject — new GitHub repo', () => {
  it('defaults the owner to the signed-in user and the folder to beside an existing project', async () => {
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

    await waitFor(() => expect(githubCheckRepoName).toHaveBeenCalledWith('jimbuck', 'my-app'), { timeout: 2000 })
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
    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledWith('jimbuck/demo', 'D:\\Code'))
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
    expect(useStore.getState().modal).toBe('addProject')
    // The form is frozen on the repo that now exists; only the clone reruns.
    expect(screen.getByLabelText('Repository name').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry clone' }))
    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledTimes(2))
    expect(githubCreateRepo).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
  })
})

describe('AddProject — clone from GitHub', () => {
  it('lists the owner\u2019s repositories with their visibility and filters as you type', async () => {
    await open('clone')
    await waitFor(() => expect(githubListRepos).toHaveBeenCalledWith('jimbuck'))
    const list = screen.getByRole('listbox', { name: 'Repositories' })
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
    expect(within(list).getByRole('option', { name: /orbital.*Public/ })).toBeTruthy()
    expect(within(list).getByRole('option', { name: /secret.*Private.*Archived/ })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'sec' } })
    expect(within(list).getAllByRole('option')).toHaveLength(1)
  })

  it('reloads the list when the owner changes', async () => {
    await open('clone')
    await waitFor(() => expect(githubListRepos).toHaveBeenCalledWith('jimbuck'))
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'acme' } })
    await waitFor(() => expect(githubListRepos).toHaveBeenCalledWith('acme'))
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
    // an existing project), so read it rather than assume which.
    const parent = (screen.getByLabelText(/Local folder/) as HTMLInputElement).value
    expect(parent).toBeTruthy()
    expect(screen.getByText(`${parent}\\orbital`)).toBeTruthy()
    fireEvent.click(clone)

    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledWith('jimbuck/orbital', parent))
    await waitFor(() => expect(useStore.getState().modal).toBeNull())
  })

  it('offers a typed owner/repo that is not in the list', async () => {
    await open('clone')
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'cli/cli' } })
    const list = screen.getByRole('listbox', { name: 'Repositories' })
    fireEvent.click(within(list).getByRole('option', { name: /cli\/cli/ }))
    const parent = (screen.getByLabelText(/Local folder/) as HTMLInputElement).value
    fireEvent.click(screen.getByRole('button', { name: 'Clone repository' }))
    await waitFor(() => expect(githubCloneRepo).toHaveBeenCalledWith('cli/cli', parent))
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
    expect(useStore.getState().modal).toBe('addProject')
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
