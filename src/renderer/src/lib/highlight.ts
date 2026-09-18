import type { HighlighterCore, ThemedToken } from 'shiki/core'
import { themeById, type ThemeId } from '@shared/themes'
import { extOf } from './markdownAssets'

/**
 * Shiki grammar lookup shared by the editor's source view and every diff
 * renderer (the editor tab's and the commit-history modal's), so a file
 * highlights the same way wherever it is shown.
 */

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

/** Fence tags people write that are neither an extension nor a shiki id. */
const FENCE_ALIASES: Record<string, string> = {
  shell: 'bash',
  console: 'bash',
  pwsh: 'powershell',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  dockerfile: 'docker',
  jsonl: 'json',
  node: 'javascript'
}

/**
 * The shiki grammar for a markdown fence tag (```ts, ```sh, ```c++ …), or null
 * for an unknown tag and the plain-text ones (```text, ```txt).
 */
export function langForFence(tag: string): string | null {
  const t = tag.trim().toLowerCase()
  if (!t) return null
  if (FENCE_ALIASES[t]) return FENCE_ALIASES[t]
  if (EXT_LANG[t]) return EXT_LANG[t]
  if (SELF_LANGS.has(t)) return t
  return null
}

/** Above this size highlighting is skipped — a plain <pre> keeps huge files snappy. */
export const HIGHLIGHT_MAX = 300_000

/* ---- The highlighter ------------------------------------------------------
 *
 * One core highlighter with the two app themes, the JavaScript regex engine
 * (no Oniguruma WASM to ship or boot), and grammars loaded on first use from
 * the explicit list below. `import('shiki')` pulled the full bundle: every
 * grammar shiki knows plus the WASM engine, ~10 MB of chunks in the installer
 * for the forty-odd languages the extension map above can ever ask for.
 * Static import paths keep the bundler able to see exactly those.
 */

type LangModule = { default: Parameters<HighlighterCore['loadLanguage']>[0] }

const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
  bash: () => import('shiki/dist/langs/bash.mjs'),
  powershell: () => import('shiki/dist/langs/powershell.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  ruby: () => import('shiki/dist/langs/ruby.mjs'),
  rust: () => import('shiki/dist/langs/rust.mjs'),
  kotlin: () => import('shiki/dist/langs/kotlin.mjs'),
  csharp: () => import('shiki/dist/langs/csharp.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  xml: () => import('shiki/dist/langs/xml.mjs'),
  diff: () => import('shiki/dist/langs/diff.mjs'),
  ini: () => import('shiki/dist/langs/ini.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  jsonc: () => import('shiki/dist/langs/jsonc.mjs'),
  json5: () => import('shiki/dist/langs/json5.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  scss: () => import('shiki/dist/langs/scss.mjs'),
  less: () => import('shiki/dist/langs/less.mjs'),
  vue: () => import('shiki/dist/langs/vue.mjs'),
  svelte: () => import('shiki/dist/langs/svelte.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  bat: () => import('shiki/dist/langs/bat.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  java: () => import('shiki/dist/langs/java.mjs'),
  swift: () => import('shiki/dist/langs/swift.mjs'),
  c: () => import('shiki/dist/langs/c.mjs'),
  cpp: () => import('shiki/dist/langs/cpp.mjs'),
  php: () => import('shiki/dist/langs/php.mjs'),
  lua: () => import('shiki/dist/langs/lua.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
  graphql: () => import('shiki/dist/langs/graphql.mjs'),
  docker: () => import('shiki/dist/langs/docker.mjs'),
  mdx: () => import('shiki/dist/langs/mdx.mjs')
}

/**
 * Syntax themes, loaded on demand exactly like the grammars above and for the
 * same reason: an app theme names the shiki theme that matches it (see
 * shared/themes.ts), and shipping twenty theme JSONs in the boot chunk to use
 * one of them would be the bundle mistake the grammar list already avoids. The
 * two GitHub themes are the exception — the highlighter has to be created with
 * a theme, and they are what the built-ins use.
 */
type ThemeModule = { default: Parameters<HighlighterCore['loadTheme']>[0] }

const BUILTIN_THEMES = { dark: 'github-dark-default', light: 'github-light-default' } as const

const THEME_LOADERS: Record<string, () => Promise<ThemeModule>> = {
  'dark-plus': () => import('shiki/dist/themes/dark-plus.mjs'),
  'light-plus': () => import('shiki/dist/themes/light-plus.mjs'),
  'one-dark-pro': () => import('shiki/dist/themes/one-dark-pro.mjs'),
  'one-light': () => import('shiki/dist/themes/one-light.mjs'),
  dracula: () => import('shiki/dist/themes/dracula.mjs'),
  nord: () => import('shiki/dist/themes/nord.mjs'),
  'tokyo-night': () => import('shiki/dist/themes/tokyo-night.mjs'),
  'catppuccin-mocha': () => import('shiki/dist/themes/catppuccin-mocha.mjs'),
  'catppuccin-latte': () => import('shiki/dist/themes/catppuccin-latte.mjs'),
  'gruvbox-dark-medium': () => import('shiki/dist/themes/gruvbox-dark-medium.mjs'),
  'gruvbox-light-medium': () => import('shiki/dist/themes/gruvbox-light-medium.mjs'),
  'solarized-dark': () => import('shiki/dist/themes/solarized-dark.mjs'),
  'solarized-light': () => import('shiki/dist/themes/solarized-light.mjs'),
  monokai: () => import('shiki/dist/themes/monokai.mjs')
}

/**
 * The syntax themes this build can actually produce. Exported so a theme added
 * to the registry with a shiki name that is not here fails a test rather than
 * silently falling back to GitHub at runtime.
 */
export const SYNTAX_THEMES: ReadonlySet<string> = new Set([
  ...Object.values(BUILTIN_THEMES),
  ...Object.keys(THEME_LOADERS)
])

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/dist/themes/github-dark-default.mjs'),
      import('shiki/dist/themes/github-light-default.mjs')
    ]).then(([core, engine, dark, light]) =>
      core.createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [],
        // `forgiving` lets a grammar with a construct the JS engine cannot
        // translate load with that rule skipped rather than fail outright.
        engine: engine.createJavaScriptRegexEngine({ forgiving: true })
      })
    )
    // A failed boot (a broken chunk load, say) must not poison every later
    // call — drop the memo so the next request tries again.
    highlighterPromise.catch(() => {
      highlighterPromise = null
    })
  }
  return highlighterPromise
}

async function withLang(lang: string): Promise<HighlighterCore> {
  const loader = LANG_LOADERS[lang]
  if (!loader) throw new Error(`no grammar for ${lang}`)
  const h = await getHighlighter()
  // loadLanguage registers the grammar only after its own await: without
  // awaiting it here the first codeToHtml for a language throws "not found"
  // and only a retry (the editor's next keystroke) ever sees it.
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage((await loader()).default)
  return h
}

/**
 * The loaded shiki theme to colour code with for an app theme, loading it on
 * first use. Falls back to the GitHub theme for the app theme's appearance:
 * code in a dark window stays dark even if that one chunk fails to arrive,
 * which is a far better outcome than no highlighting at all.
 */
async function withTheme(h: HighlighterCore, theme: ThemeId): Promise<string> {
  const spec = themeById(theme)
  const fallback = BUILTIN_THEMES[spec.appearance]
  // No loader means one of the two themes the highlighter booted with.
  const loader = THEME_LOADERS[spec.code]
  if (!loader) return fallback
  try {
    // Same await-before-use rule as the grammars: loadTheme registers the theme
    // only after its own await resolves.
    if (!h.getLoadedThemes().includes(spec.code)) await h.loadTheme((await loader()).default)
    return spec.code
  } catch (err) {
    console.warn(`shiki theme ${spec.code} failed to load:`, err)
    return fallback
  }
}

/** Highlighted HTML (shiki's <pre><code> markup) for a whole file. */
export async function highlightHtml(code: string, lang: string, theme: ThemeId): Promise<string> {
  const h = await withLang(lang)
  return h.codeToHtml(code, { lang, theme: await withTheme(h, theme) })
}

/** Themed token lines for a diff renderer to reassemble per line. */
export async function highlightTokens(code: string, lang: string, theme: ThemeId): Promise<ThemedToken[][]> {
  const h = await withLang(lang)
  return h.codeToTokens(code, { lang, theme: await withTheme(h, theme) }).tokens
}
