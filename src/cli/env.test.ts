import { describe, expect, it } from 'vitest'
import { envIdentity } from './env'

describe('envIdentity', () => {
  it('reads the repo and the project from a current terminal', () => {
    expect(envIdentity({ ORBITAL_REPO_ID: 'repo-1', ORBITAL_PROJECT_ID: 'proj-1' })).toEqual({
      repoId: 'repo-1',
      projectId: 'proj-1'
    })
  })

  it('gives a folder session (empty repo) no repo, only its project', () => {
    expect(envIdentity({ ORBITAL_REPO_ID: '', ORBITAL_PROJECT_ID: 'proj-1' })).toEqual({
      repoId: undefined,
      projectId: 'proj-1'
    })
  })

  it('reads ORBITAL_PROJECT_ID as the repo only when ORBITAL_REPO_ID is absent (an older terminal)', () => {
    expect(envIdentity({ ORBITAL_PROJECT_ID: 'repo-legacy' })).toEqual({ repoId: 'repo-legacy' })
  })

  it('is empty outside Orbital', () => {
    expect(envIdentity({})).toEqual({ repoId: undefined })
  })
})
