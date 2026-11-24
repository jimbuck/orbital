// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { branchSlug, cleanBranchPrefix, prefixedBranch, WORKTREE_BRANCH_PREFIX_MAX } from './worktree-branch'

describe('branchSlug', () => {
  it('turns a name into a branch, and lets a ref through', () => {
    expect(branchSlug('Login flow')).toBe('login-flow')
    expect(branchSlug('  Fix: the  CLI flags!  ')).toBe('fix-the-cli-flags')
    expect(branchSlug('feat/login')).toBe('feat/login')
    expect(branchSlug('/-odd-/')).toBe('odd')
    expect(branchSlug('!!!')).toBe('')
  })
})

describe('cleanBranchPrefix', () => {
  it('keeps the separator a prefix ends in, whichever it is', () => {
    expect(cleanBranchPrefix('feature/')).toBe('feature/')
    expect(cleanBranchPrefix('jb-')).toBe('jb-')
    expect(cleanBranchPrefix('users/jim/')).toBe('users/jim/')
    expect(cleanBranchPrefix('wip_')).toBe('wip_')
  })

  it('tidies what a branch name could not carry', () => {
    expect(cleanBranchPrefix('  Feature/ ')).toBe('feature/')
    expect(cleanBranchPrefix('/feature//')).toBe('feature/')
    expect(cleanBranchPrefix('my team/')).toBe('my-team/')
    expect(cleanBranchPrefix('--x')).toBe('x')
    expect(cleanBranchPrefix('')).toBe('')
    expect(cleanBranchPrefix('   ')).toBe('')
    expect(cleanBranchPrefix('x'.repeat(90)).length).toBe(WORKTREE_BRANCH_PREFIX_MAX)
  })
})

describe('prefixedBranch', () => {
  it('puts the prefix in front of the slug', () => {
    expect(prefixedBranch('feature/', 'login-flow')).toBe('feature/login-flow')
    expect(prefixedBranch('jb-', 'login-flow')).toBe('jb-login-flow')
  })

  it('does not double a prefix the name already has', () => {
    expect(prefixedBranch('feature/', 'feature/login-flow')).toBe('feature/login-flow')
  })

  it('is the slug alone with no prefix, and nothing at all with no slug', () => {
    expect(prefixedBranch('', 'login-flow')).toBe('login-flow')
    expect(prefixedBranch('feature/', '')).toBe('')
  })
})
