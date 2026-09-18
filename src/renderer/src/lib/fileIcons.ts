import {
  Binary,
  BookText,
  Coffee,
  Container,
  Database,
  FileArchive,
  FileAudio2,
  FileCode2,
  FileDiff,
  FileImage,
  FileJson2,
  FileKey2,
  FileLock2,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType2,
  FileVideo2,
  GitBranch,
  Package,
  Palette,
  Settings2,
  Type,
  type LucideIcon
} from 'lucide-react'
import { extOf } from './markdownAssets'

/**
 * The icon for a file, wherever Orbital lists one: the editor's tree and its
 * open-file pills, and the command palette's file results.
 *
 * Every row used to be the same grey `FileText`, which made a directory listing
 * a column of identical marks you had to read word by word. A file's *kind* is
 * the thing the eye can pick up without reading, so it gets both axes: a glyph
 * for the family (code, config, archive, media) and a hue for the language
 * within it. Neither is decoration — scanning for "the yaml one" or "the test
 * fixture" in a folder of thirty files is the whole job of a file tree.
 *
 * Hues are TOKENS, not the brand colours a devicon set would use. Orbital ships
 * twenty themes (shared/themes.ts) and a per-workspace accent; a baked-in
 * TypeScript blue would fight Gruvbox and vanish into Nord, while `text-blue`
 * is whatever blue the current theme means. It costs some fidelity — Go and
 * Python share a cyan here — and buys an icon set that cannot clash.
 */

export interface FileIcon {
  Icon: LucideIcon
  /** Tailwind text colour for the glyph — a theme token, never a literal. */
  className: string
}

const icon = (Icon: LucideIcon, className: string): FileIcon => ({ Icon, className })

/* ---- Families ------------------------------------------------------------- */

const CODE = {
  ts: icon(FileCode2, 'text-blue'),
  js: icon(FileCode2, 'text-amber'),
  python: icon(FileCode2, 'text-cyan'),
  go: icon(FileCode2, 'text-cyan'),
  rust: icon(FileCode2, 'text-amber-2'),
  jvm: icon(Coffee, 'text-red-2'),
  ruby: icon(FileCode2, 'text-red'),
  systems: icon(FileCode2, 'text-purple'),
  php: icon(FileCode2, 'text-purple-2'),
  lua: icon(FileCode2, 'text-blue')
}

const MARKUP = icon(FileCode2, 'text-amber-2')
const STYLE = icon(Palette, 'text-purple')
const JSON_LIKE = icon(FileJson2, 'text-amber')
const DOC = icon(BookText, 'text-blue')
const CONFIG = icon(Settings2, 'text-muted')
const SECRET = icon(FileKey2, 'text-amber-2')
const SHELL = icon(FileTerminal, 'text-green')
const IMAGE = icon(FileImage, 'text-purple-2')
const ARCHIVE = icon(FileArchive, 'text-amber')
const DATA = icon(Database, 'text-blue')
const SHEET = icon(FileSpreadsheet, 'text-green')
const LOCKED = icon(FileLock2, 'text-faint')
const BINARY = icon(Binary, 'text-faint')
const GIT = icon(GitBranch, 'text-amber-2')
const DOCKER = icon(Container, 'text-blue')
const PLAIN = icon(FileText, 'text-muted')

/** The fallback: a file whose extension says nothing this build recognizes. */
const UNKNOWN = icon(FileText, 'text-faint')

/* ---- Lookups -------------------------------------------------------------- */

const BY_EXT: Record<string, FileIcon> = {
  ts: CODE.ts, tsx: CODE.ts, mts: CODE.ts, cts: CODE.ts, dts: CODE.ts,
  js: CODE.js, jsx: CODE.js, mjs: CODE.js, cjs: CODE.js,
  json: JSON_LIKE, jsonc: JSON_LIKE, json5: JSON_LIKE, jsonl: JSON_LIKE,
  md: DOC, markdown: DOC, mdx: DOC, rst: DOC, adoc: DOC,
  css: STYLE, scss: STYLE, sass: STYLE, less: STYLE, styl: STYLE,
  html: MARKUP, htm: MARKUP, xml: MARKUP, vue: MARKUP, svelte: MARKUP, astro: MARKUP, hbs: MARKUP, ejs: MARKUP,
  yaml: CONFIG, yml: CONFIG, toml: CONFIG, ini: CONFIG, conf: CONFIG, cfg: CONFIG, properties: CONFIG, editorconfig: CONFIG,
  env: SECRET, pem: SECRET, key: SECRET, crt: SECRET, cer: SECRET, pfx: SECRET,
  sh: SHELL, bash: SHELL, zsh: SHELL, fish: SHELL, ps1: SHELL, psm1: SHELL, psd1: SHELL, bat: SHELL, cmd: SHELL,
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, webp: IMAGE, bmp: IMAGE, ico: IMAGE, avif: IMAGE, svg: IMAGE,
  mp4: icon(FileVideo2, 'text-purple'), webm: icon(FileVideo2, 'text-purple'), mov: icon(FileVideo2, 'text-purple'),
  mkv: icon(FileVideo2, 'text-purple'), avi: icon(FileVideo2, 'text-purple'),
  mp3: icon(FileAudio2, 'text-purple'), wav: icon(FileAudio2, 'text-purple'), ogg: icon(FileAudio2, 'text-purple'),
  flac: icon(FileAudio2, 'text-purple'), m4a: icon(FileAudio2, 'text-purple'),
  zip: ARCHIVE, tar: ARCHIVE, gz: ARCHIVE, tgz: ARCHIVE, bz2: ARCHIVE, xz: ARCHIVE, '7z': ARCHIVE, rar: ARCHIVE,
  sql: DATA, db: DATA, sqlite: DATA, sqlite3: DATA,
  csv: SHEET, tsv: SHEET, xlsx: SHEET, xls: SHEET,
  woff: icon(Type, 'text-text-3'), woff2: icon(Type, 'text-text-3'), ttf: icon(Type, 'text-text-3'), otf: icon(Type, 'text-text-3'),
  pdf: icon(FileType2, 'text-red'),
  exe: BINARY, dll: BINARY, so: BINARY, dylib: BINARY, bin: BINARY, wasm: BINARY, node: BINARY, o: BINARY,
  lock: LOCKED,
  diff: icon(FileDiff, 'text-green-2'), patch: icon(FileDiff, 'text-green-2'),
  txt: PLAIN, log: PLAIN,
  py: CODE.python, pyi: CODE.python, ipynb: CODE.python,
  go: CODE.go,
  rs: CODE.rust,
  java: CODE.jvm, kt: CODE.jvm, kts: CODE.jvm, gradle: CODE.jvm, scala: CODE.jvm,
  rb: CODE.ruby, gemspec: CODE.ruby,
  c: CODE.systems, h: CODE.systems, cpp: CODE.systems, cc: CODE.systems, hpp: CODE.systems, cs: CODE.systems,
  swift: CODE.systems, zig: CODE.systems,
  php: CODE.php,
  lua: CODE.lua,
  gitignore: GIT, gitattributes: GIT, gitmodules: GIT, gitkeep: GIT
}

/**
 * Whole filenames that outrank their extension. `package.json` is the manifest
 * rather than "some JSON", and a lockfile beside it is machine output nobody
 * opens on purpose — both are worth telling apart at a glance in a root
 * listing, which is exactly where they live.
 */
const BY_NAME: Record<string, FileIcon> = {
  'package.json': icon(Package, 'text-red'),
  'package-lock.json': LOCKED,
  'npm-shrinkwrap.json': LOCKED,
  'yarn.lock': LOCKED,
  'pnpm-lock.yaml': LOCKED,
  'bun.lockb': LOCKED,
  'cargo.lock': LOCKED,
  'poetry.lock': LOCKED,
  dockerfile: DOCKER,
  'docker-compose.yml': DOCKER,
  'docker-compose.yaml': DOCKER,
  'compose.yml': DOCKER,
  'compose.yaml': DOCKER,
  '.dockerignore': DOCKER,
  license: icon(FileText, 'text-amber-2'),
  'license.md': icon(FileText, 'text-amber-2'),
  'license.txt': icon(FileText, 'text-amber-2')
}

/**
 * The icon for `path`.
 *
 * Whole-name matches win, then two prefix families that no extension can
 * describe — dotted `.env.local` / `.gitignore`-style names, and README in
 * whatever form a repo spells it — then the extension, then the fallback.
 */
export function fileIcon(path: string): FileIcon {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  const byName = BY_NAME[name]
  if (byName) return byName
  // `.env`, `.env.local`, `.env.production` — extOf sees "local" or nothing.
  if (name === '.env' || name.startsWith('.env.')) return SECRET
  if (name.startsWith('.git')) return GIT
  if (name.startsWith('readme')) return DOC
  return BY_EXT[extOf(path)] ?? UNKNOWN
}
