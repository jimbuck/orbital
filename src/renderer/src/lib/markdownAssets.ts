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
 * The fix is to inline the bytes: every `<img>` whose `src` is a *local* path is
 * resolved to a repo-relative path, read through the same `readFileBase64`
 * bridge the image viewer already uses, and rewritten to a `data:` URL. Remote
 * (`http(s):`, protocol-relative) and already-inline (`data:`) sources are left
 * exactly as the author wrote them.
 *
 * Two properties this module is deliberately careful about:
 *
 *  - **Containment.** A resolved path is normalised segment by segment and any
 *    `../` that would climb above the worktree root rejects the image outright
 *    rather than reading it. Percent-encoded separators (`%2F`, `%5C`) are
 *    decoded *before* normalisation so they can't smuggle a traversal past it.
 *  - **No HTML injection.** Rewriting happens on a parsed DOM (`DOMParser` +
 *    `setAttribute`), never by string surgery on the HTML. Re-serialising via
 *    `innerHTML` escapes attribute values for us, so a crafted file name can't
 *    break out of the `src="…"` it lands in. The parsed document is inert — it
 *    fetches nothing and runs nothing — and the iframe sandbox is untouched.
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

/** Anything with a `scheme:` prefix (http:, data:, mailto:, and `C:/…`) is not ours. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Resolve an `<img src>` from a markdown file to a repo-relative path, or null
 * when it isn't a local file we may read.
 *
 * `mdPath` is the repo-relative path of the markdown file being previewed;
 * relative sources resolve against its directory, `/`-rooted ones against the
 * worktree root. The result uses forward slashes and contains no `.`/`..`
 * segments, so it can be handed straight to the readFile bridge.
 *
 * Returns null for: empty sources, anything with a URL scheme, protocol-relative
 * `//host/x.png`, and any path that climbs out of the worktree.
 */
export function resolveMarkdownAssetPath(mdPath: string, src: string): string | null {
  const raw = src.trim()
  if (!raw) return null
  // Protocol-relative (`//cdn/x.png`) is a *remote* URL, not a rooted path.
  if (raw.startsWith('//')) return null
  if (HAS_SCHEME.test(raw)) return null

  // Strip a query string / fragment the way a URL would. Cache-busting suffixes
  // (`logo.png?v=2`) show up in markdown far more often than file names that
  // genuinely contain `?` or `#` — and `?` isn't even legal in a Windows name.
  const cut = raw.search(/[?#]/)
  const pathPart = cut === -1 ? raw : raw.slice(0, cut)
  if (!pathPart) return null

  // A leading slash means "worktree root"; otherwise start from the markdown
  // file's own directory. Backslashes are normalised early so a Windows-style
  // `images\foo.png` resolves the same way it would on disk.
  const rooted = pathPart.startsWith('/') || pathPart.startsWith('\\')
  const baseDir = rooted ? '' : mdPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')

  const stack: string[] = baseDir ? baseDir.split('/').filter(Boolean) : []
  for (const part of splitSegments(pathPart)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // Escaping the worktree root is a hard reject, not a clamp: silently
      // reading `../../../secrets.png` would be exactly the bug to avoid.
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length > 0 ? stack.join('/') : null
}

/**
 * Split a source into path segments, decoding percent-escapes as we go.
 * Decoding happens per raw segment and any separator it *decodes into* is split
 * again, so `a%2F..%2F..%2Fetc` can't slip a traversal past the `..` handling
 * above. Malformed escapes (a lone `%`) are kept literally rather than throwing.
 */
function splitSegments(pathPart: string): string[] {
  const out: string[] = []
  for (const rawSeg of pathPart.split(/[/\\]/)) {
    let decoded: string
    try {
      decoded = decodeURIComponent(rawSeg)
    } catch {
      decoded = rawSeg
    }
    for (const seg of decoded.split(/[/\\]/)) out.push(seg)
  }
  return out
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
 * Rewrite every local `<img src>` in a marked-produced HTML body to a `data:`
 * URL, returning the new body HTML. Remote and `data:` sources, paths that
 * escape the worktree, unsupported extensions, and images that simply fail to
 * read are all left with their original `src` — a single bad image degrades to a
 * broken-image glyph, it never takes the preview down.
 */
export async function resolveMarkdownImages(html: string, ctx: MarkdownAssetContext): Promise<string> {
  // Parsed documents from DOMParser are inert: no subresource fetches, no script
  // execution. Parsing (rather than regexing the string) is also what makes the
  // rewrite injection-safe — see the module comment.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const imgs = Array.from(doc.querySelectorAll('img'))

  const jobs: Promise<void>[] = []
  for (const img of imgs) {
    const src = img.getAttribute('src')
    if (!src) continue
    const path = resolveMarkdownAssetPath(ctx.mdPath, src)
    if (!path) continue
    const mime = previewImageMime(path)
    if (!mime) continue
    // Repeated references to one path share a single cache entry, so N copies of
    // the same logo cost one read.
    jobs.push(
      cachedDataUrl(ctx.worktreeId, path, mime).then((dataUrl) => {
        if (dataUrl) img.setAttribute('src', dataUrl)
      })
    )
  }
  if (jobs.length > 0) await Promise.all(jobs)

  // Serialising through innerHTML escapes attribute values, so nothing in a file
  // name can break out of the src it was written into.
  return doc.body.innerHTML
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
