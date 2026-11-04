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
  // JavaScript / TypeScript
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Docs and markup
  md: 'markdown',
  markdown: 'markdown',
  htm: 'html',
  svg: 'xml',
  xaml: 'xml',
  csproj: 'xml',
  fsproj: 'xml',
  vbproj: 'xml',
  props: 'xml',
  targets: 'xml',
  plist: 'xml',
  xsd: 'xml',
  mmd: 'mermaid',
  typ: 'typst',
  // Shells and scripts
  sh: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  cmd: 'bat',
  nu: 'nushell',
  // Languages
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  csx: 'csharp',
  cshtml: 'razor',
  h: 'c',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  sc: 'scala',
  sbt: 'scala',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  ml: 'ocaml',
  mli: 'ocaml',
  fs: 'fsharp',
  fsi: 'fsharp',
  fsx: 'fsharp',
  pl: 'perl',
  pm: 'perl',
  jl: 'julia',
  cr: 'crystal',
  sol: 'solidity',
  vert: 'glsl',
  frag: 'glsl',
  vim: 'viml',
  gql: 'graphql',
  // Templates
  hbs: 'handlebars',
  j2: 'jinja',
  jinja2: 'jinja',
  jade: 'pug',
  styl: 'stylus',
  // Infrastructure and config
  tf: 'terraform',
  tfvars: 'terraform',
  nomad: 'hcl',
  bicepparam: 'bicep',
  gradle: 'groovy',
  mk: 'make',
  service: 'systemd',
  socket: 'systemd',
  timer: 'systemd',
  mount: 'systemd',
  rest: 'http',
  libsonnet: 'jsonnet',
  ndjson: 'jsonl',
  pp: 'puppet',
  feature: 'gherkin',
  patch: 'diff',
  gitignore: 'ini',
  editorconfig: 'ini',
  npmrc: 'ini',
  gitconfig: 'ini',
  cfg: 'ini',
  env: 'dotenv',
  conf: 'ini'
}

/**
 * Whole file names (lowercased) that say what a file is when the extension
 * does not: build files, dotfiles and the like.
 */
const NAME_LANG: Record<string, string> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  'cmakelists.txt': 'cmake',
  jenkinsfile: 'groovy',
  vagrantfile: 'ruby',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  brewfile: 'ruby',
  justfile: 'just',
  '.justfile': 'just',
  codeowners: 'codeowners',
  commit_editmsg: 'git-commit',
  'git-rebase-todo': 'git-rebase',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.zshrc': 'bash',
  '.zprofile': 'bash',
  '.profile': 'bash',
  'nginx.conf': 'nginx',
  '.htaccess': 'apache',
  'httpd.conf': 'apache'
}

/** The shiki grammar for a path, or null when we have none (plain text). */
export function langFor(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (NAME_LANG[name]) return NAME_LANG[name]
  // .env.local, .env.production …: the extension is the environment name.
  if (name.startsWith('.env.')) return 'dotenv'
  // Dockerfile.dev, api.Dockerfile
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'docker'
  // ~/.ssh/config and its includes
  if (/(^|[\\/])\.ssh[\\/]/.test(path) && !name.includes('.')) return 'ssh-config'
  const ext = extOf(path)
  if (EXT_LANG[ext]) return EXT_LANG[ext]
  if (ext in LANG_LOADERS) return ext
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
  'f#': 'fsharp',
  dockerfile: 'docker',
  node: 'javascript',
  hcl2: 'hcl',
  makefile: 'make',
  protobuf: 'proto',
  jinja2: 'jinja',
  ssh: 'ssh-config'
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
  if (t in LANG_LOADERS) return t
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
 * for the languages the maps above can ever ask for.
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
  mdx: () => import('shiki/dist/langs/mdx.mjs'),
  // Infrastructure, build and config formats
  terraform: () => import('shiki/dist/langs/terraform.mjs'),
  hcl: () => import('shiki/dist/langs/hcl.mjs'),
  bicep: () => import('shiki/dist/langs/bicep.mjs'),
  nix: () => import('shiki/dist/langs/nix.mjs'),
  puppet: () => import('shiki/dist/langs/puppet.mjs'),
  nginx: () => import('shiki/dist/langs/nginx.mjs'),
  apache: () => import('shiki/dist/langs/apache.mjs'),
  systemd: () => import('shiki/dist/langs/systemd.mjs'),
  'ssh-config': () => import('shiki/dist/langs/ssh-config.mjs'),
  dotenv: () => import('shiki/dist/langs/dotenv.mjs'),
  properties: () => import('shiki/dist/langs/properties.mjs'),
  make: () => import('shiki/dist/langs/make.mjs'),
  cmake: () => import('shiki/dist/langs/cmake.mjs'),
  just: () => import('shiki/dist/langs/just.mjs'),
  groovy: () => import('shiki/dist/langs/groovy.mjs'),
  proto: () => import('shiki/dist/langs/proto.mjs'),
  prisma: () => import('shiki/dist/langs/prisma.mjs'),
  cue: () => import('shiki/dist/langs/cue.mjs'),
  jsonnet: () => import('shiki/dist/langs/jsonnet.mjs'),
  jsonl: () => import('shiki/dist/langs/jsonl.mjs'),
  hjson: () => import('shiki/dist/langs/hjson.mjs'),
  kdl: () => import('shiki/dist/langs/kdl.mjs'),
  http: () => import('shiki/dist/langs/http.mjs'),
  csv: () => import('shiki/dist/langs/csv.mjs'),
  tsv: () => import('shiki/dist/langs/tsv.mjs'),
  log: () => import('shiki/dist/langs/log.mjs'),
  reg: () => import('shiki/dist/langs/reg.mjs'),
  desktop: () => import('shiki/dist/langs/desktop.mjs'),
  codeowners: () => import('shiki/dist/langs/codeowners.mjs'),
  'git-commit': () => import('shiki/dist/langs/git-commit.mjs'),
  'git-rebase': () => import('shiki/dist/langs/git-rebase.mjs'),
  gherkin: () => import('shiki/dist/langs/gherkin.mjs'),
  mermaid: () => import('shiki/dist/langs/mermaid.mjs'),
  rst: () => import('shiki/dist/langs/rst.mjs'),
  typst: () => import('shiki/dist/langs/typst.mjs'),
  // Templates and stylesheets
  sass: () => import('shiki/dist/langs/sass.mjs'),
  stylus: () => import('shiki/dist/langs/stylus.mjs'),
  astro: () => import('shiki/dist/langs/astro.mjs'),
  handlebars: () => import('shiki/dist/langs/handlebars.mjs'),
  jinja: () => import('shiki/dist/langs/jinja.mjs'),
  twig: () => import('shiki/dist/langs/twig.mjs'),
  liquid: () => import('shiki/dist/langs/liquid.mjs'),
  erb: () => import('shiki/dist/langs/erb.mjs'),
  pug: () => import('shiki/dist/langs/pug.mjs'),
  razor: () => import('shiki/dist/langs/razor.mjs'),
  // Shells
  fish: () => import('shiki/dist/langs/fish.mjs'),
  nushell: () => import('shiki/dist/langs/nushell.mjs'),
  awk: () => import('shiki/dist/langs/awk.mjs'),
  viml: () => import('shiki/dist/langs/viml.mjs'),
  // More languages
  zig: () => import('shiki/dist/langs/zig.mjs'),
  dart: () => import('shiki/dist/langs/dart.mjs'),
  elixir: () => import('shiki/dist/langs/elixir.mjs'),
  erlang: () => import('shiki/dist/langs/erlang.mjs'),
  gleam: () => import('shiki/dist/langs/gleam.mjs'),
  haskell: () => import('shiki/dist/langs/haskell.mjs'),
  elm: () => import('shiki/dist/langs/elm.mjs'),
  scala: () => import('shiki/dist/langs/scala.mjs'),
  clojure: () => import('shiki/dist/langs/clojure.mjs'),
  ocaml: () => import('shiki/dist/langs/ocaml.mjs'),
  fsharp: () => import('shiki/dist/langs/fsharp.mjs'),
  r: () => import('shiki/dist/langs/r.mjs'),
  perl: () => import('shiki/dist/langs/perl.mjs'),
  julia: () => import('shiki/dist/langs/julia.mjs'),
  vb: () => import('shiki/dist/langs/vb.mjs'),
  nim: () => import('shiki/dist/langs/nim.mjs'),
  crystal: () => import('shiki/dist/langs/crystal.mjs'),
  solidity: () => import('shiki/dist/langs/solidity.mjs'),
  glsl: () => import('shiki/dist/langs/glsl.mjs'),
  hlsl: () => import('shiki/dist/langs/hlsl.mjs'),
  wgsl: () => import('shiki/dist/langs/wgsl.mjs')
}

/** Every grammar this build can load, exported so a test can check the maps above only name these. */
export const HIGHLIGHT_LANGS: ReadonlySet<string> = new Set(Object.keys(LANG_LOADERS))

/** Every grammar the lookup tables can produce, for the same test. */
export const MAPPED_LANGS: ReadonlySet<string> = new Set([
  ...Object.values(EXT_LANG),
  ...Object.values(NAME_LANG),
  ...Object.values(FENCE_ALIASES),
  'dotenv',
  'docker',
  'ssh-config'
])

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
