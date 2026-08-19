import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CreateWorktreeOptions, Project } from '@shared/types'
import { useStore } from '@renderer/store'

import NewWorktree from './NewWorktree'

/**
 * The branch-source choice is the modal's one real branch point: everything
 * below it, and what gets sent to createWorktree, hangs off it. This PR swapped
 * the hand-rolled `aria-pressed` toggles that used to drive it for the shared
 * SegmentedControl, so the wiring is new even though the behaviour should not
 * be — hence a test that the choice still selects, still swaps the form, and
 * still reaches the bridge as the right field.
 *
 * SegmentedControl.test.tsx owns the ARIA and key handling in the abstract;
 * this file owns "and this parent is wired to it correctly".
 */

const createWorktree = vi.fn(async (projectId: string, opts: CreateWorktreeOptions) => ({
  id: 'wt-1',
  projectId,
  name: opts.name,
  branch: 'x'
}))
const listBranches = vi.fn(async () => ({
  branches: ['main', 'feat/existing'],
  remotes: ['origin/feat/remote'],
  head: 'main'
}))

const project: Project = {
  id: 'p1',
  name: 'orbital',
  repoPath: 'C:/repo',
  defaultAgentId: 'claude',
  addedAt: 0
}

function seed(): void {
  useStore.setState({
    projects: [project],
    worktrees: [],
    tasks: [],
    activeProjectId: project.id,
    activeWorktreeId: null,
    modalData: { project }
  } as unknown as Parameters<typeof useStore.setState>[0])
}

/** The branch-source group's two options, in rendered order. */
function sourceRadios(): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: 'Branch source' })).getAllByRole('radio')
}

/**
 * The existing-branch <select>, matched on its caption's trailing hint: its
 * label is just "Branch", which also prefixes the "Branch source" group and the
 * "Branch name" field.
 */
function existingBranchPicker(): HTMLElement {
  return screen.getByLabelText(/remote picks get a local tracking branch/)
}

/**
 * Render and wait for the branch list to land. The modal loads branches in an
 * effect, so asserting before that resolves would fight an act() warning rather
 * than test anything.
 */
async function open(): Promise<void> {
  seed()
  render(<NewWorktree />)
  await waitFor(() => expect(listBranches).toHaveBeenCalled())
}

beforeEach(() => {
  createWorktree.mockClear()
  listBranches.mockClear()
  vi.stubGlobal('orbital', { createWorktree, listBranches })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NewWorktree — branch source', () => {
  it('offers both sources and starts on "create new"', async () => {
    await open()

    expect(sourceRadios().map((r) => r.textContent)).toEqual([
      'Create new branch',
      'Open existing branch'
    ])
    expect(sourceRadios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  })

  it('swaps the form when the other source is picked', async () => {
    await open()
    // The new-branch fields are what a fresh modal shows.
    expect(screen.getByLabelText(/Branch name/)).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Open existing branch' }))

    expect(sourceRadios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    // Branch name / base ref are gone; the existing-branch picker replaced them.
    expect(screen.queryByLabelText(/Branch name/)).toBeNull()
    expect(existingBranchPicker()).toBeTruthy()
  })

  it('sends a NEW branch when "create new" is the selection', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Worktree name'), { target: { value: 'Login flow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Worktree' }))

    await waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1))
    const opts = createWorktree.mock.calls[0][1]
    // `branch` creates; `existingBranch` checks one out. Sending the wrong one
    // would silently do the opposite of what the user selected.
    expect(opts.branch).toBe('login-flow')
    expect(opts.existingBranch).toBeUndefined()
  })

  it('sends an EXISTING branch when the other source is selected', async () => {
    await open()
    fireEvent.click(screen.getByRole('radio', { name: 'Open existing branch' }))
    fireEvent.change(existingBranchPicker(), { target: { value: 'feat/existing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Worktree' }))

    await waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1))
    const opts = createWorktree.mock.calls[0][1]
    expect(opts.existingBranch).toBe('feat/existing')
    expect(opts.branch).toBeUndefined()
    // A branch pick with no typed name defaults the name off the branch.
    expect(opts.name).toBe('existing')
  })

  it('keeps the selection through an arrow key, including its submit gating', async () => {
    await open()
    // Selection follows focus in this control, so arrowing is a real pick — the
    // submit button must gate on the newly selected source, not the old one.
    fireEvent.keyDown(sourceRadios()[0], { key: 'ArrowRight' })

    expect(sourceRadios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    // 'existing' with nothing picked yet: submit stays disabled even though a
    // branch name was never required for this source.
    expect(screen.getByRole('button', { name: 'Create Worktree' })).toHaveProperty('disabled', true)

    fireEvent.change(existingBranchPicker(), { target: { value: 'feat/existing' } })
    expect(screen.getByRole('button', { name: 'Create Worktree' })).toHaveProperty('disabled', false)
  })
})
