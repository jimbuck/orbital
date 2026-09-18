import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { SearchQuery } from '@shared/types'

/**
 * ripgrep, as content search's fast path.
 *
 * `git grep` still works and is still here (see ./search): every Worktree is a
 * git checkout, so it needs nothing installed and it defines the file set. What
 * it does not do is stay quick on a repo of any size, and the search box runs on
 * every keystroke. ripgrep is the same search a few times faster, at the cost of
 * a ~5 MB binary per platform, and the query and result shapes never said
 * anything about git — so the swap is confined to which argv gets spawned and
 * how its output is read.
 *
 * The binary is resolved rather than imported. `@vscode/ripgrep` is ESM-only,
 * and its fifteen-line shim THROWS at import time when the per-platform
 * optional dependency is missing — which is precisely the case that has to
 * degrade to `git grep` rather than take the module down with it. Resolving the
 * platform package ourselves is the same lookup with a `null` instead of a
 * throw.
 */

// `__filename` rather than `import.meta.url`: electron-vite bundles main as
// CommonJS, where the latter does not exist. Resolution starts from the bundle
// (out/main/), which walks up to the app's node_modules in dev and to the one
// inside the asar when packaged.
const require_ = createRequire(__filename)

/** Resolved once. `undefined` means "not looked for yet"; `null`, "not here". */
let cached: string | null | undefined

/**
 * The ripgrep binary for this platform, or null when it is not available.
 *
 * Two ways it can be absent, both legitimate: an architecture
 * `@vscode/ripgrep` publishes no binary for, and a packaged app whose asar did
 * not unpack it (a binary inside an asar cannot be executed, hence the
 * `asarUnpack` entry in electron-builder.yml). Either way search still works —
 * it just goes back to `git grep`.
 */
export function rgPath(): string | null {
  if (cached !== undefined) return cached
  cached = resolveRg()
  return cached
}

/** Test seam: forget the resolution so a test can pin a path (or its absence). */
export function __setRgPath(path: string | null | undefined): void {
  cached = path
}

function resolveRg(): string | null {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  try {
    const resolved = require_.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${binary}`)
    // Inside a packaged app the module graph reports the path in the asar; the
    // executable itself is beside it in app.asar.unpacked.
    const unpacked = resolved.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
    if (existsSync(unpacked)) return unpacked
    return existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}

/**
 * The ripgrep argv for a query, matching `git grep --untracked`'s file set.
 *
 * Two flags carry that last part. `--hidden` puts dotfiles back in — ripgrep
 * skips them by default while git happily tracks `.github/workflows/*.yml` —
 * and the `!.git/` glob then keeps the repository's own object database out,
 * which `--hidden` would otherwise walk. .gitignore is respected by default, so
 * ignored files stay out without being asked.
 *
 * `--no-config` because ripgrep reads RIPGREP_CONFIG_PATH: a user's personal
 * defaults are theirs to set for their shell, not something that should quietly
 * change what this window finds.
 */
export function rgArgs(q: SearchQuery, perFileCap: number): string[] {
  const args = [
    '--json',
    '--no-config',
    '--no-messages',
    '--hidden',
    '--glob',
    '!.git/',
    '--max-count',
    String(perFileCap)
  ]
  if (!q.caseSensitive) args.push('--ignore-case')
  if (q.wholeWord) args.push('--word-regexp')
  if (!q.regex) args.push('--fixed-strings')
  for (const glob of (q.include ?? '').split(',').map((g) => g.trim()).filter(Boolean)) {
    args.push('--glob', glob)
  }
  // The `.` is not optional, however much it looks it. Given no path at all,
  // ripgrep searches the current directory ONLY when stdin is a terminal;
  // spawned from Electron it is a pipe, so rg reads that instead, finds nothing
  // in it and exits 1 — a search that silently returns no results, everywhere,
  // always. Naming the directory costs a `./` on every path, which parseRg
  // takes back off.
  //
  // `--` closes the flags first, so a query of `--help` is a query.
  args.push('--regexp', q.query, '--', '.')
  return args
}

/** One `--json` event, narrowed to the fields this reads. */
interface RgMatch {
  type: string
  data?: {
    path?: { text?: string; bytes?: string }
    lines?: { text?: string; bytes?: string }
    line_number?: number
  }
}

/** A `{ text }` / `{ bytes }` pair as a string, or null when it is neither. */
function textOf(value: { text?: string; bytes?: string } | undefined): string | null {
  if (typeof value?.text === 'string') return value.text
  // ripgrep falls back to base64 for anything that is not valid UTF-8. Decoding
  // it lossily is better than dropping the hit: the path still opens, and the
  // line still shows what it can.
  if (typeof value?.bytes === 'string') return Buffer.from(value.bytes, 'base64').toString('utf8')
  return null
}

/** A hit, in the shape ./search turns into a SearchFileResult. */
export interface RgHit {
  path: string
  line: number
  text: string
}

/**
 * Read `rg --json` output into hits.
 *
 * Only `match` events are of interest; `begin`, `end` and `summary` carry
 * nothing the result shape asks for. A line arriving as anything other than a
 * match event — including the empty trailing one, and any JSON this build does
 * not recognise — is skipped rather than failing the search.
 *
 * Paths come back in the platform's own separator; everything downstream (the
 * editor, the file index, the git panel) speaks POSIX, so they are normalised
 * here at the boundary.
 */
export function parseRg(stdout: string): RgHit[] {
  const out: RgHit[] = []
  for (const record of stdout.split('\n')) {
    if (!record) continue
    let event: RgMatch
    try {
      event = JSON.parse(record) as RgMatch
    } catch {
      continue
    }
    if (event.type !== 'match') continue
    const path = textOf(event.data?.path)
    const text = textOf(event.data?.lines)
    const line = event.data?.line_number
    if (path === null || text === null || typeof line !== 'number') continue
    // `lines.text` keeps the file's own terminator; a CRLF checkout leaves the
    // carriage return behind as well.
    out.push({
      // Belt and braces on the path argument above: a `./` prefix would follow
      // a hit all the way into "open this file", where it is not the path.
      path: path.replace(/\\/g, '/').replace(/^\.\//, ''),
      line,
      text: text.replace(/\r?\n$/, '')
    })
  }
  return out
}
