/**
 * A project's VS Code / Cursor multi-root workspace file.
 *
 * Opt-in per project (`Project.codeWorkspace`). Orbital writes
 * `<project-name-slug>.code-workspace` listing the project's repos: in the
 * home repo when there is one (so it can be committed and shared with it),
 * else in the project's root folder. The home repo comes first as ".", then
 * the other members in the project's order, with paths relative to the file.
 *
 * The file is the user's as much as Orbital's: in one that already exists only
 * the `folders` value is replaced, and every other key (settings, extensions,
 * launch…), comment and formatting outside it is kept. VS Code reads these
 * files as JSONC, so comments and trailing commas are allowed; a file that
 * cannot be parsed even so is logged and left alone. A file whose folders are
 * already right is not rewritten.
 *
 * Turning it off, or the file's name or place changing (rename, home set,
 * cleared or moved), removes the file Orbital wrote, but only while its
 * folders are still what Orbital wrote and it holds nothing else.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, Repo } from '@shared/types'
import { tables } from '../runtime'
import { logger } from './logger'
import { relativePath, samePath } from './project-map'

/** One entry of a workspace file's `folders`. */
export interface WorkspaceFolder {
  path: string
  name: string
}

/** The file name for a project: its name lower-cased, runs of anything else turned into '-'. */
export function workspaceFileName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'project'}.code-workspace`
}

/**
 * Where a project's file goes and what it lists, or null when there is
 * nothing to list. Home first as ".", then the other members in order.
 */
export function workspaceTarget(project: Project, repos: Repo[]): { file: string; folders: WorkspaceFolder[] } | null {
  const byId = new Map(repos.map((r) => [r.id, r]))
  const members = project.repoIds.map((id) => byId.get(id)).filter((r): r is Repo => !!r)
  if (members.length === 0) return null
  const home = project.homeRepoId ? members.find((r) => r.id === project.homeRepoId) : undefined
  const dir = home ? home.repoPath : project.rootPath
  if (!dir) return null
  const ordered = home ? [home, ...members.filter((r) => r.id !== home.id)] : members
  const folders = ordered.map((r) => ({
    path: samePath(r.repoPath, dir) ? '.' : (relativePath(dir, r.repoPath) ?? r.repoPath.replace(/\\/g, '/')),
    name: r.name
  }))
  return { file: join(dir, workspaceFileName(project.name)), folders }
}

/** A new file: `{ "folders": [...] }`, 2-space JSON, trailing line ending. */
export function renderWorkspace(folders: WorkspaceFolder[], eol = '\n'): string {
  return JSON.stringify({ folders }, null, 2).replace(/\n/g, eol) + eol
}

/* ---- JSONC ------------------------------------------------------------------- */

type TokenKind = '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'literal'
interface Token {
  kind: TokenKind
  start: number
  end: number
}

/** The JSONC tokens of `text` (comments and whitespace skipped), or null on an unterminated string or comment. */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close === -1) return null
      i = close + 2
    } else if (c === '"') {
      const start = i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      if (i >= text.length) return null
      tokens.push({ kind: 'string', start, end: ++i })
    } else if ('{}[]:,'.includes(c)) {
      tokens.push({ kind: c as TokenKind, start: i, end: ++i })
    } else if (/\s/.test(c) || c === '﻿') {
      i++
    } else {
      const start = i
      while (i < text.length && !/[\s{}[\]:,"/]/.test(text[i])) i++
      if (i === start) return null
      tokens.push({ kind: 'literal', start, end: i })
    }
  }
  return tokens
}

/** Parse JSONC (comments, trailing commas). Undefined when it is not valid even so. */
export function parseJsonc(text: string): unknown {
  const tokens = tokenize(text)
  if (!tokens) return undefined
  // Rebuild as strict JSON: tokens only, minus commas that close nothing.
  let json = ''
  tokens.forEach((t, k) => {
    if (t.kind === ',' && (tokens[k + 1]?.kind === '}' || tokens[k + 1]?.kind === ']')) return
    json += text.slice(t.start, t.end) + ' '
  })
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Whether a parsed `folders` value is exactly `folders` (same entries, same keys, same order). */
export function sameFolders(value: unknown, folders: WorkspaceFolder[]): boolean {
  return JSON.stringify(value) === JSON.stringify(folders)
}

/** The span of the top-level `folders` value in `text`, the key's token, and the first member's token. */
function locateFolders(
  text: string,
  tokens: Token[]
): {
  key: Token | null
  value: { start: number; end: number } | null
  firstMember: Token | null
  open: Token
} | null {
  if (tokens[0]?.kind !== '{') return null
  let depth = 0
  let key: Token | null = null
  let value: { start: number; end: number } | null = null
  let firstMember: Token | null = null
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.kind === '{' || t.kind === '[') depth++
    else if (t.kind === '}' || t.kind === ']') depth--
    else if (depth === 1 && t.kind === 'string' && tokens[k + 1]?.kind === ':') {
      firstMember ??= t
      if (key || JSON.parse(text.slice(t.start, t.end)) !== 'folders') continue
      key = t
      // The value: one token, or a bracketed run.
      const first = tokens[k + 2]
      if (!first) return null
      let end = first.end
      if (first.kind === '[' || first.kind === '{') {
        let d = 0
        let j = k + 2
        for (; j < tokens.length; j++) {
          const kind = tokens[j].kind
          if (kind === '[' || kind === '{') d++
          else if (kind === ']' || kind === '}') d--
          if (d === 0) break
        }
        if (j >= tokens.length) return null
        end = tokens[j].end
      }
      value = { start: first.start, end }
    }
  }
  return { key, value, firstMember, open: tokens[0] }
}

/** The whitespace a line starts with, for the line holding `at`. */
function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))![0]
}

/**
 * `existing` with its top-level `folders` set to `folders`, everything else
 * kept as written. Returns `existing` itself when its folders already match,
 * and null when it cannot be parsed as a JSONC object (leave it alone).
 */
export function mergeWorkspace(existing: string, folders: WorkspaceFolder[]): string | null {
  const parsed = parseJsonc(existing)
  if (!isPlainObject(parsed)) return null
  if (sameFolders(parsed.folders, folders)) return existing
  const tokens = tokenize(existing)
  const at = tokens && locateFolders(existing, tokens)
  if (!at) return null
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  let out: string
  if (at.key && at.value) {
    const indent = indentAt(existing, at.key.start)
    const value = JSON.stringify(folders, null, 2).replace(/\n/g, eol + indent)
    out = existing.slice(0, at.value.start) + value + existing.slice(at.value.end)
  } else if (at.firstMember) {
    const indent = indentAt(existing, at.firstMember.start)
    const value = JSON.stringify(folders, null, 2).replace(/\n/g, eol + indent)
    out =
      existing.slice(0, at.firstMember.start) +
      `"folders": ${value},${eol}${indent}` +
      existing.slice(at.firstMember.start)
  } else {
    // An empty object: nothing of the user's to keep inside it.
    out =
      existing.slice(0, at.open.start) +
      renderWorkspace(folders, eol).trimEnd() +
      existing.slice(existing.indexOf('}', at.open.end) + 1)
  }
  // Belt and braces: never write something that does not read back as intended.
  const check = parseJsonc(out)
  if (!isPlainObject(check) || !sameFolders(check.folders, folders)) return null
  return out
}

/**
 * Whether a file holding `existing` may be deleted as the one Orbital wrote
 * listing `folders`: it parses, its folders are exactly those, and it has no
 * other key (a setting someone added is theirs to keep).
 */
export function removableWorkspace(existing: string, folders: WorkspaceFolder[]): boolean {
  const parsed = parseJsonc(existing)
  if (!isPlainObject(parsed)) return false
  return Object.keys(parsed).length === 1 && sameFolders(parsed.folders, folders)
}

/* ---- files -------------------------------------------------------------------- */

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.orbital-${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/**
 * Write or update the file. 'written' when it changed, 'unchanged' when it was
 * already right, 'skipped' when an existing file could not be parsed.
 */
export function writeCodeWorkspace(file: string, folders: WorkspaceFolder[]): 'written' | 'unchanged' | 'skipped' {
  const before = readOrNull(file)
  const after = before === null ? renderWorkspace(folders) : mergeWorkspace(before, folders)
  if (after === null) {
    logger.warn('workspace file could not be parsed; leaving it alone', {
      file
    })
    return 'skipped'
  }
  if (after === before) return 'unchanged'
  writeAtomic(file, after)
  return 'written'
}

/** Delete the file if it is still just the `folders` Orbital wrote. True when it went (or was already gone). */
export function eraseCodeWorkspace(file: string, folders: WorkspaceFolder[]): boolean {
  const before = readOrNull(file)
  if (before === null) return true
  if (!removableWorkspace(before, folders)) {
    logger.info('workspace file was changed by hand; leaving it', { file })
    return false
  }
  rmSync(file, { force: true })
  return true
}

/* ---- keeping every project's file in step ------------------------------------- */

/** What this instance wrote, by project: where, and the folders it listed. */
const written = new Map<string, { file: string; folders: WorkspaceFolder[] }>()

/**
 * One pass: write the file for every project with the flag on, and remove
 * the one this instance wrote wherever the flag went off or the file's place
 * changed. Run by the project-pointers scheduler after the managed block, so
 * it fires on the same changes. Never throws.
 */
export async function syncCodeWorkspaces(): Promise<void> {
  const repos = tables.repos.list()
  const want = new Map<string, { project: Project; file: string; folders: WorkspaceFolder[] }>()
  for (const p of tables.projects.list()) {
    if (!p.codeWorkspace) continue
    const target = workspaceTarget(p, repos)
    if (target) want.set(p.id, { project: p, ...target })
  }
  for (const [pid, prev] of [...written]) {
    const now = want.get(pid)
    if (now && samePath(now.file, prev.file)) continue
    written.delete(pid)
    // Another project now owns that path: it is rewritten below, not removed.
    if ([...want.values()].some((w) => samePath(w.file, prev.file))) continue
    try {
      if (existsSync(prev.file) && eraseCodeWorkspace(prev.file, prev.folders)) {
        logger.info('removed workspace file', { file: prev.file })
      }
    } catch (err) {
      logger.warn('could not remove workspace file', {
        file: prev.file,
        error: String(err)
      })
    }
  }
  for (const [pid, { project, file, folders }] of want) {
    try {
      const result = writeCodeWorkspace(file, folders)
      if (result === 'skipped') continue
      written.set(pid, { file, folders })
      if (result === 'written') logger.info('wrote workspace file', { project: project.name, file })
    } catch (err) {
      logger.warn('could not write workspace file', {
        project: project.name,
        file,
        error: String(err)
      })
    }
  }
}

/** Test hook: forget what this instance wrote. */
export function resetCodeWorkspaceMemory(): void {
  written.clear()
}
