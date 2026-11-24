/**
 * Naming the branch of a new Worktree: the slug made from its name, and the
 * prefix a workspace puts in front of it (the `worktreeBranchPrefix` setting).
 *
 * Shared so the New Worktree form shows the branch main will create. The form
 * suggests it, main makes it for a Worktree started without a form (the CLI, a
 * task's play button), and both go through here.
 */

/** What a workspace prefixes new Worktree branches with until it says otherwise. */
export const DEFAULT_WORKTREE_BRANCH_PREFIX = 'feature/'

/** Long enough for `users/first.last/`-style namespaces, short enough to stay a prefix. */
export const WORKTREE_BRANCH_PREFIX_MAX = 40

/**
 * Free text as a git-safe branch name: "Login flow" becomes `login-flow`, and
 * a ref typed as one (`feat/login`) passes through. Empty when nothing usable
 * is left.
 */
export function branchSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}

/**
 * A prefix as it is stored and used: the same characters a slug keeps, with
 * the separator on its end left alone, since `feature/` and `jb-` are both
 * prefixes and the separator is part of each. Empty means no prefix.
 */
export function cleanBranchPrefix(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[-/]+/, '')
    .slice(0, WORKTREE_BRANCH_PREFIX_MAX)
}

/**
 * `slug` behind `prefix`. A slug that already starts with the prefix is left
 * as it is (a name typed as `feature/login` is not `feature/feature/login`),
 * and no slug is no branch, not a bare prefix.
 */
export function prefixedBranch(prefix: string, slug: string): string {
  if (!slug || !prefix || slug.startsWith(prefix)) return slug
  return `${prefix}${slug}`
}
