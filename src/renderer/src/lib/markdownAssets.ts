/**
 * Local image resolution for the markdown preview.
 *
 * The preview renders `marked` output inside a sandboxed `srcDoc` iframe. A
 * `srcDoc` document inherits no meaningful base URL, and the app itself is
 * served from `file://` (packaged) or the vite dev server (dev) — neither of
 * which points anywhere near the worktree on disk. So a perfectly ordinary
 * `![diagram](./docs/diagram.png)` has nothing to resolve against and renders
 * as a broken image.
 *
 * The fix is to inline the bytes: every local image URL — `<img src>`, and every
 * candidate in an `<img srcset>` or `<source srcset>` — is resolved to a
 * repo-relative path, read through the same `readFileBase64` bridge the image
 * viewer already uses, and rewritten to a `data:` URL. Remote (`http(s):`,
 * protocol-relative, UNC) and already-inline (`data:`) sources are left exactly
 * as the author wrote them. `srcset` matters as much as `src`: the standard
 * dark/light-logo README idiom puts the real image on a `<source srcset>` and
 * only a fallback on the `<img>`, and the browser prefers the `<source>` — so
 * rewriting `src` alone still renders a broken image.
 *
 * Three properties this module is deliberately careful about:
 *
 *  - **Containment.** *Both* halves of the join — the markdown file's own
 *    directory and the source URL — are percent-decoded and then normalised
 *    segment by segment, and any `../` that would climb above the worktree root
 *    rejects the image outright rather than reading it. Main checks containment
 *    as well — `readFileBase64` resolves through the git service's lexical gate,
 *    which refuses `..` and rooted paths — so this is not the last line of
 *    defence. It is the layer that decides WHAT gets asked for: it turns the
 *    author's URL into the repo-relative path main is then handed, and a
 *    rejection here means a broken-image placeholder rather than a round trip
 *    that comes back as an error.
 *  - **Decode first, then check.** Every structural guard (remote root, URL
 *    scheme, `..`) runs on the *decoded* path, because an escape otherwise walks
 *    straight past it: `%2F%2Fhost/x.png` used to survive the protocol-relative
 *    check and then collapse to `host/x.png`. Nothing there escaped the
 *    worktree, but it did resolve to a path the author never wrote.
 *  - **No HTML injection.** Rewriting happens on parsed DOM (a detached
 *    `<template>` + `setAttribute`), never by string surgery on the HTML.
 *    Re-serialising via `innerHTML` escapes attribute values for us, so a
 *    crafted file name can't break out of the `src="…"` it lands in. A
 *    template's contents are inert — they fetch nothing and run nothing — and
 *    the iframe sandbox is untouched.
 */

/* ---- Extensions ---------------------------------------------------------- */

/** Lowercased extension of a path (no dot); '' when there isn't one. */
export function extOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Binary image formats rendered directly in File mode (SVG stays text + Preview). */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

/** MIME type for the binary image formats the editor renders itself, else null. */
export function imageMime(path: string): string | null {
  return IMAGE_MIME[extOf(path)] ?? null
}

/**
 * MIME type for anything the preview can inline into an `<img>`. This is
 * `imageMime` plus SVG: the editor deliberately treats a *selected* `.svg` as
 * text (so you can edit it) but an SVG referenced *from* markdown is just an
 * image. Serving it as `data:image/svg+xml;base64,…` inside an `<img>` is safe —
 * scripts in an SVG loaded through `<img>` never execute.
 */
export function previewImageMime(path: string): string | null {
  return extOf(path) === 'svg' ? 'image/svg+xml' : imageMime(path)
}

/* ---- Path resolution ----------------------------------------------------- */

/**
 * Anything with a `scheme:` prefix is not ours: `http:`, `data:`, `mailto:`, and
 * — because a single letter is a legal scheme as far as this pattern cares — a
 * Windows drive-absolute path in either slash flavour (`C:/foo.png`, `C:\foo.png`).
 * Rejecting drive letters here is deliberate: `join(repoRoot, 'C:/foo.png')` is
 * not a path anyone meant to write, so it must never reach the bridge.
 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Two leading separators, in any mix of slashes: a protocol-relative URL
 * (`//cdn/x.png`) or a Windows UNC share (`\\server\share\x.png`). Both name a
 * *remote host*, not a location in the worktree. Left to the segment walker they
 * would collapse to the innocuous-looking `server/share/x.png` and trigger a
 * pointless read — or, worse, silently render an unrelated repo file that
 * happens to sit at that path. Neither is what the author wrote, so both are
 * rejected outright and the source is left exactly as-is.
 *
 * Both this and {@link HAS_SCHEME} are applied to the *decoded* path — see
 * {@link decodePath}.
 */
const REMOTE_ROOT = /^[/\\]{2}/

/**
 * Resolve an `<img src>` from a markdown file to a repo-relative path, or null
 * when it isn't a local file we may read.
 *
 * `mdPath` is the repo-relative path of the markdown file being previewed;
 * relative sources resolve against its directory, `/`-rooted ones against the
 * worktree root. The result uses forward slashes and contains no `.`/`..`
 * segments, so it can be handed straight to the readFile bridge.
 *
 * Returns null for: empty sources, anything with a URL scheme (including
 * drive-absolute paths), protocol-relative and UNC roots, any path that climbs
 * out of the worktree, and any `mdPath` that isn't itself a contained
 * repo-relative path.
 */
export function resolveMarkdownAssetPath(mdPath: string, src: string): string | null {
  const raw = src.trim()
  if (!raw) return null

  // Strip a query string / fragment the way a URL would. Cache-busting suffixes
  // (`logo.png?v=2`) show up in markdown far more often than file names that
  // genuinely contain `?` or `#` — and `?` isn't even legal in a Windows name.
  const cut = raw.search(/[?#]/)
  const pathPart = cut === -1 ? raw : raw.slice(0, cut)
  if (!pathPart) return null

  // Decode *before* the structural checks, not after: run against the raw text,
  // they are trivially bypassable. `%2F%2Fhost/x.png` sailed past REMOTE_ROOT
  // and then decoded into `//host/x.png`, collapsing to `host/x.png`;
  // `%43%3A%2Fx.png` sailed past HAS_SCHEME and became `C:/x.png`. Neither
  // escaped the worktree — the segment walk below is what guarantees that — but
  // both resolved to a path the author never wrote, which is the exact
  // collapse these two guards exist to prevent.
  const decoded = decodePath(pathPart)
  if (REMOTE_ROOT.test(decoded)) return null
  if (HAS_SCHEME.test(decoded)) return null

  // A leading slash means "worktree root"; otherwise start from the markdown
  // file's own directory. Backslashes are normalised early so a Windows-style
  // `images\foo.png` resolves the same way it would on disk.
  const rooted = decoded.startsWith('/') || decoded.startsWith('\\')

  const stack: string[] = []
  if (!rooted) {
    // The markdown file's directory is the base every relative source resolves
    // against, so it has to satisfy the same containment rule as the source
    // itself — it can't be assumed canonical just because the app usually passes
    // a clean tree path. Seeding `stack` with raw segments would let a caller
    // supplying `../guide.md` produce `../logo.png`, or `docs/../../guide.md`
    // produce `docs/../../logo.png`: paths that escape the worktree while never
    // touching the `..` branch below, because the `..` is already *inside* the
    // stack rather than arriving from the source. Normalising the directory
    // first makes the guard cover both halves of the join. (Main is no longer
    // taking this on trust — `readFileBase64` resolves through its own lexical
    // containment gate, so an escape that slipped past here would be refused
    // there too. Normalising both halves is what keeps the two layers agreeing:
    // this function's contract is "a repo-relative path or nothing", and
    // emitting a `../` that main then rejects would break that contract while
    // hiding the reason behind an IPC error.) The md path goes through the
    // *same* decode as the source rather than a bare backslash swap, so "one
    // normaliser for both halves" is literally true — it's unreachable in
    // practice (the path comes from the app's own file tree) but a guard that
    // only half-applies is a guard nobody can reason about.
    const mdDecoded = decodePath(mdPath)
    if (REMOTE_ROOT.test(mdDecoded) || HAS_SCHEME.test(mdDecoded)) return null
    if (!applySegments(stack, splitSegments(mdDecoded).slice(0, -1))) return null
  }

  if (!applySegments(stack, splitSegments(decoded))) return null
  return stack.length > 0 ? stack.join('/') : null
}

/**
 * Fold `segments` onto `stack`, collapsing `.` and `..` as a path join would.
 * Returns false — and leaves `stack` in whatever state it reached — when a `..`
 * would climb above the worktree root. Escaping is a hard reject, not a clamp:
 * silently reading `../../../secrets.png` would be exactly the bug to avoid.
 */
function applySegments(stack: string[], segments: readonly string[]): boolean {
  for (const part of segments) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length === 0) return false
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return true
}

/**
 * Percent-decode a path *segment by segment*, keeping its separators.
 *
 * Decoding per segment rather than in one pass is what makes an escaped
 * separator become a real one: `a%2F..%2F..%2Fetc` decodes to `a/../../etc`,
 * which the `..` handling above then sees and rejects. Separators are
 * normalised to `/` on the way through, so a Windows-style `images\foo.png`
 * reads the same as `images/foo.png` — a `\` that arrives *from* a decode is
 * left in place and split out later by {@link splitSegments}, which is why the
 * remote-root check accepts either slash. Malformed escapes (a lone `%`, as in
 * `100%.png`) are kept literally rather than throwing.
 */
function decodePath(path: string): string {
  return path
    .split(/[/\\]/)
    .map((seg) => {
      try {
        return decodeURIComponent(seg)
      } catch {
        return seg
      }
    })
    .join('/')
}

/** Split an already-{@link decodePath}ed path into segments. */
function splitSegments(decoded: string): string[] {
  return decoded.split(/[/\\]/)
}

/* ---- Bridge + cache ------------------------------------------------------ */

export interface MarkdownAssetBridge {
  readFileBase64: (worktreeId: string, path: string) => Promise<string>
}

/** Lazily bound so importing this module never touches `window.orbital`. */
function defaultBridge(): MarkdownAssetBridge {
  return { readFileBase64: (id, path) => window.orbital.readFileBase64(id, path) }
}

let bridgeOverride: MarkdownAssetBridge | null = null
function bridge(): MarkdownAssetBridge {
  return bridgeOverride ?? defaultBridge()
}

interface CacheEntry {
  /** In-flight or settled load. Null resolves mean "couldn't read it". */
  value: Promise<string | null>
  loadedAt: number
}

/**
 * Resolved data URLs, keyed by worktree id *and* path so two worktrees of the
 * same repo never serve each other's bytes.
 *
 * Staleness: entries expire after {@link cacheTtlMs}. The cache exists to stop a
 * cheap re-render (a theme flip rebuilds the whole document, and every keystroke
 * in the editor re-renders the preview) from re-reading every image over IPC;
 * it is not meant to pin an image for the session. A short TTL keeps that win
 * while guaranteeing an image edited on disk shows up within seconds instead of
 * until the app restarts. Failures are cached too, so a markdown file pointing
 * at a missing image doesn't fire an IPC call per keystroke.
 */
const cache = new Map<string, CacheEntry>()

/** Roughly how long a decoded image stays good for. */
let cacheTtlMs = 30_000

/** Cap on cached images — base64 blobs are large, so the map can't grow forever. */
const CACHE_MAX = 64

function cachedDataUrl(worktreeId: string, path: string, mime: string): Promise<string | null> {
  const key = `${worktreeId}\u0000${path}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.loadedAt < cacheTtlMs) return hit.value

  const value = bridge()
    .readFileBase64(worktreeId, path)
    .then((b64) => `data:${mime};base64,${b64}`)
    .catch(() => null)
  cache.set(key, { value, loadedAt: now })
  // Oldest-inserted eviction (Map preserves insertion order) — good enough for a
  // preview, and a re-read of an evicted image is a single cheap IPC call.
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
  return value
}

/* ---- Rewriting ----------------------------------------------------------- */

export interface MarkdownAssetContext {
  worktreeId: string
  /** Repo-relative path of the markdown file being previewed. */
  mdPath: string
}

/**
 * Every element this function touches: `img`/`source` carry the URLs it
 * rewrites, `script` is the one thing it removes. A document containing none of
 * them would come back from the parse/serialise round trip unchanged, so the
 * round trip is skipped entirely — see {@link resolveMarkdownImages}.
 */
const REWRITABLE = /<(?:img|source|script)[\s/>]/i

/**
 * Start (or join) the read for one candidate image URL. Null when the URL isn't
 * a local image we may inline — remote, `data:`, escaping the worktree, or an
 * extension we can't serve — in which case the caller leaves it untouched.
 *
 * Repeated references to one path share a single cache entry, so N copies of the
 * same logo cost one read.
 */
function loadAsset(ctx: MarkdownAssetContext, url: string): Promise<string | null> | null {
  const path = resolveMarkdownAssetPath(ctx.mdPath, url)
  if (!path) return null
  const mime = previewImageMime(path)
  if (!mime) return null
  return cachedDataUrl(ctx.worktreeId, path, mime)
}

/**
 * Locate the URLs in a `srcset`, as `[start, end)` offsets into the attribute.
 *
 * A `srcset` is a comma-separated list of `<url> [descriptor]` entries, but the
 * separator is not simply a comma: per the HTML parsing rules a candidate's URL
 * is a run of *non-whitespace*, and only commas that trail it terminate the
 * entry. That is why `data:image/png;base64,AAA 1x` is one candidate rather than
 * two — and why we must inline as data URLs without fear of splitting them.
 * Descriptors (`1x`, `640w`) run from there to the next top-level comma.
 *
 * Offsets rather than parsed entries so the caller can splice replacements in
 * and leave every comma, descriptor and run of whitespace exactly as written —
 * an entry that fails to resolve is untouched by construction rather than
 * re-serialised or dropped.
 */
function srcsetUrlRanges(value: string): [number, number][] {
  const out: [number, number][] = []
  const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r'
  let i = 0
  while (i < value.length) {
    while (i < value.length && (isSpace(value[i]) || value[i] === ',')) i++
    if (i >= value.length) break
    const start = i
    while (i < value.length && !isSpace(value[i])) i++
    let end = i
    // Trailing commas belong to the separator, not the URL — and their presence
    // means this candidate has no descriptor.
    while (end > start && value[end - 1] === ',') end--
    if (end > start) out.push([start, end])
    if (end !== i) continue
    // Descriptor run: up to the next comma. Parens are tracked because the
    // (never-shipped) `(max-width: …)` descriptor form may contain one.
    let depth = 0
    while (i < value.length) {
      const c = value[i]
      if (c === '(') depth++
      else if (c === ')') depth = Math.max(0, depth - 1)
      else if (c === ',' && depth === 0) break
      i++
    }
  }
  return out
}

/**
 * Rewrite every local image URL in a marked-produced HTML body to a `data:` URL,
 * returning the new HTML. Remote and `data:` sources, paths that escape the
 * worktree, unsupported extensions, and images that simply fail to read are all
 * left exactly as written — a single bad image degrades to a broken-image glyph,
 * it never takes the preview down.
 */
export async function resolveMarkdownImages(html: string, ctx: MarkdownAssetContext): Promise<string> {
  // Nothing here to rewrite: hand back the *original* string rather than a
  // re-serialised copy of it. This is both the common case — most markdown has
  // no images, and the preview re-renders on every keystroke — and a
  // correctness fix. A round trip is never free: it re-serialises whatever the
  // parser decided the markup meant, and the previous document-based version
  // silently lost anything the parser hoisted out of `<body>` (a leading
  // `<style>` block, `<meta>`/`<link>`/`<title>`/`<base>`) or above `<html>`
  // (comments, including the common `<!-- omit in toc -->` marker).
  if (!REWRITABLE.test(html)) return html

  // Fragment parsing via a detached `<template>`, not document parsing. A
  // template's contents live in an inert document — nothing is fetched, nothing
  // runs — and, unlike `DOMParser`, fragment parsing has no `<head>` to hoist
  // into, so `<style>`, `<meta>` and comments stay exactly where the author put
  // them. Parsing (rather than regexing the string) is also what makes the
  // rewrite injection-safe — see the module comment.
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const frag = tpl.content

  // `marked` passes raw HTML through, so a markdown file can carry a `<script>`.
  // The preview iframe is sandboxed *without* `allow-scripts`, and that sandbox
  // is the load-bearing control here — but the document round trip this replaces
  // happened to drop a leading `<script>` (the parser hoisted it into the
  // `<head>` we never serialised), and there is no reason to start emitting one
  // into the frame again.
  for (const script of Array.from(frag.querySelectorAll('script'))) script.remove()

  const jobs: Promise<void>[] = []

  for (const img of Array.from(frag.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    const load = src ? loadAsset(ctx, src) : null
    if (!load) continue
    jobs.push(
      load.then((dataUrl) => {
        if (dataUrl) img.setAttribute('src', dataUrl)
      })
    )
  }

  // `srcset` on either element. `<source srcset>` is not optional extra credit:
  // in a `<picture>` the browser *prefers* it over the `<img>` fallback, so
  // leaving it relative renders a broken image no matter what `src` says.
  for (const el of Array.from(frag.querySelectorAll('img[srcset], source[srcset]'))) {
    const value = el.getAttribute('srcset') ?? ''
    const ranges = srcsetUrlRanges(value)
    const loads = ranges.map(([start, end]) => loadAsset(ctx, value.slice(start, end)))
    if (!loads.some((load) => load !== null)) continue
    jobs.push(
      Promise.all(loads.map((load) => load ?? Promise.resolve(null))).then((dataUrls) => {
        let out = ''
        let cursor = 0
        dataUrls.forEach((dataUrl, k) => {
          if (!dataUrl) return
          out += value.slice(cursor, ranges[k][0]) + dataUrl
          cursor = ranges[k][1]
        })
        if (cursor === 0) return // every candidate failed to read
        el.setAttribute('srcset', out + value.slice(cursor))
      })
    )
  }

  if (jobs.length > 0) await Promise.all(jobs)

  // Serialising through innerHTML escapes attribute values, so nothing in a file
  // name can break out of the attribute it was written into.
  return tpl.innerHTML
}

/* ---- Test hooks ---------------------------------------------------------- */

/** Swap the IPC bridge (tests). Pass null to restore the real `window.orbital`. */
export function __setMarkdownAssetBridge(b: MarkdownAssetBridge | null): void {
  bridgeOverride = b
}

/** Override the resolved-image cache TTL (tests). */
export function __setMarkdownAssetCacheTtl(ms: number): void {
  cacheTtlMs = ms
}

/** Drop every cached image (tests). */
export function __resetMarkdownAssetCache(): void {
  cache.clear()
}
