import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FileNode } from '@shared/types'
import { git } from './git'

/**
 * The editor's file tree for a project's folder session: the root folder,
 * which is not a git checkout, with every repo under it listed the way git
 * lists it (tracked and untracked files, ignored entries dimmed, change
 * badges), grafted in under its folder.
 *
 * Outside the repos there is no .gitignore to go by, so a small set of
 * well-known heavy folders is shown dimmed and left unexpanded (they load on
 * expand through `listDir`, like any ignored folder), and the walk stops
 * after a budget of entries so a root that turns out to be a whole drive
 * cannot stall the editor. Whatever the budget leaves unwalked is listed the
 * same lazy way.
 */

/** Folders listed but never walked outside a repo: dependencies, build output, VCS internals. */
const HEAVY = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vs'
])

/** Entries the walk outside the repos visits before it lists the rest lazily. */
const WALK_BUDGET = 4000

function sortNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
}

/** `nodes` with every path moved under `prefix`. */
function underPrefix(nodes: FileNode[], prefix: string): FileNode[] {
  return nodes.map((n) => ({
    ...n,
    path: `${prefix}/${n.path}`,
    children: n.children ? underPrefix(n.children, prefix) : undefined
  }))
}

export async function folderFileTree(rootPath: string): Promise<FileNode[]> {
  // A root that is itself a checkout (repos nested inside one) is git's to list.
  if (existsSync(join(rootPath, '.git'))) return git.fileTree(rootPath)

  let budget = WALK_BUDGET
  async function walk(rel: string): Promise<FileNode[]> {
    const dir = rel ? join(rootPath, rel) : rootPath
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const nodes: FileNode[] = []
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name
      if (!e.isDirectory()) {
        // A link is listed, never followed: what it points at is not in this folder.
        nodes.push({ name: e.name, path, type: 'file' })
        continue
      }
      if (HEAVY.has(e.name) || budget <= 0) {
        nodes.push({ name: e.name, path, type: 'dir', ignored: true })
        continue
      }
      budget -= 1
      if (existsSync(join(rootPath, path, '.git'))) {
        const children = await git.fileTree(join(rootPath, path)).catch(() => null)
        if (children) {
          nodes.push({ name: e.name, path, type: 'dir', children: underPrefix(children, path) })
          continue
        }
      }
      nodes.push({ name: e.name, path, type: 'dir', children: await walk(path) })
    }
    budget -= entries.length
    sortNodes(nodes)
    return nodes
  }
  return walk('')
}
