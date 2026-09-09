import type { ResolvedTheme } from './theme'
import { extOf } from './markdownAssets'

/**
 * Shiki grammar lookup shared by the editor's source view and every diff
 * renderer (the editor tab's and the commit-history modal's), so a file
 * highlights the same way wherever it is shown.
 */

/** Shiki bundled theme id for each resolved app theme. */
export function shikiTheme(theme: ResolvedTheme): 'github-light-default' | 'github-dark-default' {
  return theme === 'light' ? 'github-light-default' : 'github-dark-default'
}

/** Extension -> shiki grammar id, for the cases where they differ. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  sh: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  htm: 'html',
  svg: 'xml',
  patch: 'diff',
  gitignore: 'ini',
  env: 'ini',
  conf: 'ini'
}

/** Grammars we accept by their own name (extension === shiki id). */
const SELF_LANGS = new Set([
  'tsx', 'jsx', 'json', 'jsonc', 'json5', 'css', 'scss', 'less', 'html', 'xml', 'vue', 'svelte',
  'yaml', 'toml', 'ini', 'bash', 'bat', 'powershell', 'python', 'ruby', 'go', 'rust', 'java',
  'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'lua', 'sql', 'graphql', 'diff', 'docker',
  'markdown', 'mdx', 'typescript', 'javascript'
])

/** The shiki grammar for a path, or null when we have none (plain text). */
export function langFor(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (name === 'dockerfile') return 'docker'
  const ext = extOf(path)
  if (EXT_LANG[ext]) return EXT_LANG[ext]
  if (SELF_LANGS.has(ext)) return ext
  return null
}

/** Above this size highlighting is skipped — a plain <pre> keeps huge files snappy. */
export const HIGHLIGHT_MAX = 300_000
