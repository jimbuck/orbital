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
  /**
   * Bytes this entry is charged against {@link cacheBytes}. Zero until the read
   * settles (the size isn't knowable before then) and zero forever for a failed
   * read, which retains nothing but a null.
   */
  bytes: number
  /** The {@link pass} that last asked for this entry — see {@link evict}. */
  pass: number
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
 *
 * Eviction is LRU over a *byte* budget — see {@link cacheMaxBytes} and
 * {@link touch} for why both halves of that sentence had to change.
 */
const cache = new Map<string, CacheEntry>()

/** Sum of every live entry's `bytes`, kept in step by {@link drop} and {@link charge}. */
let cacheBytes = 0

/**
 * Which render of which document is asking. Bumped once per
 * {@link resolveMarkdownImages} call that has images to resolve, and stamped on
 * every entry that call inserts or hits, so {@link evict} can tell "part of the
 * document on screen right now" from "left over from an earlier one". A number
 * rather than a set of keys because that is all eviction needs to ask: is this
 * entry's pass the latest?
 */
let pass = 0

/** Roughly how long a decoded image stays good for. */
let cacheTtlMs = 30_000

/**
 * Memory budget for cached images.
 *
 * Counting entries (the old `CACHE_MAX = 64`) budgets the wrong thing: 64 README
 * icons are a rounding error, while 64 full-page screenshots are several hundred
 * megabytes of base64 pinned in the renderer heap for the whole TTL. What an
 * entry actually retains is one ASCII `data:` string, and V8 stores those one
 * byte per character, so the string's length is a close enough stand-in for its
 * cost — closer than the decoded image size, which is what the *iframe* holds,
 * not us.
 *
 * 64 MiB is chosen against what the preview already costs: to display an
 * image-heavy document the `srcDoc` itself holds an inlined copy of every image
 * on screen, so a cache of the same order as one such document never more than
 * roughly doubles the memory that document was always going to need. In practice
 * it also means the case the cache exists for — a README with a handful of
 * screenshots, a few MiB inlined — never evicts mid-session, while the
 * pathological case is bounded by a number instead of by nothing.
 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
let cacheMaxBytes = DEFAULT_MAX_BYTES

/**
 * Secondary ceiling on entry *count*. A byte budget alone cannot bound the map:
 * a failed read is cached deliberately (so a missing image doesn't fire an IPC
 * call per keystroke) and costs zero bytes, so a document referencing thousands
 * of broken paths would grow the map without ever tripping the byte check. This
 * is a backstop, not the policy — it sits far above any real document, so
 * ordinary use is governed by {@link cacheMaxBytes}.
 */
const DEFAULT_MAX_ENTRIES = 512
let cacheMaxEntries = DEFAULT_MAX_ENTRIES

/** Remove an entry, if present, keeping the byte total honest. */
function drop(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  cacheBytes -= entry.bytes
  cache.delete(key)
}

/**
 * Attribute a settled read's size to its entry — but only while that entry is
 * still the live one for its key. A read that resolves after its entry expired,
 * was evicted, or was replaced by a fresher read must not add bytes the map no
 * longer holds; without the identity check every such straggler would leak into
 * `cacheBytes` and start evicting live entries to pay for memory nobody holds.
 */
function charge(key: string, entry: CacheEntry, bytes: number): void {
  if (cache.get(key) !== entry) return
  entry.bytes = bytes
  cacheBytes += bytes
  // A read that just landed is the most recent use of its key: move it to the
  // recently-used end so LRU order reflects that, then settle the budget.
  touch(key, entry)
  evict()
}

/**
 * Evict least-recently-used entries until both budgets are satisfied — never
 * evicting anything the current {@link pass} asked for.
 *
 * Why the pass rule exists. Plain LRU has a cliff: when one document's images
 * exceed the budget, every render walks them in the same order, so each image
 * loaded evicts one loaded earlier in the same render, and the next render
 * re-reads all of them. The hit rate does not degrade, it drops to ZERO — and
 * with a byte budget that regime is reachable by one README with twenty 5 MiB
 * screenshots, which the old entry-count cap cached in full. Sparing the
 * current pass turns the cliff back into a slope: the document on screen stays
 * resident whatever its size, and only what an *earlier* document left behind
 * is reclaimed, oldest first.
 *
 * What that costs: the cache can overshoot the budget by one document's working
 * set. That is memory the visible `srcDoc` is holding a copy of anyway, so the
 * overshoot never more than roughly doubles what the preview already costs, and
 * it lasts only until the next document renders. An image on its own larger
 * than the whole budget is the one-image case of the same rule, which is why
 * there is no separate "spare the tail" special case any more.
 *
 * When it runs matters as much as what it spares: only once every image in the
 * pass has been asked for (and so stamped), and then as each read's charge
 * lands. Never on the insert or hit path — see cachedDataUrl.
 *
 * Deleting during `for..of` over a Map is defined behaviour — entries removed
 * ahead of the iterator are simply not visited.
 */
function evict(): void {
  for (const [key, entry] of cache) {
    if (cacheBytes <= cacheMaxBytes && cache.size <= cacheMaxEntries) return
    if (entry.pass === pass) continue
    drop(key)
  }
}

/**
 * Move a key to the back of the Map's insertion order — the recently-used end.
 *
 * `Map.set` on a key that is *already present* updates the value in place and
 * leaves the key where it first landed. So an entry read (or re-read) on every
 * keystroke stayed pinned at the front and was the first thing evicted:
 * precisely backwards. Delete-then-set is the only way to reorder a Map, and it
 * is what turns eviction from FIFO into LRU.
 */
function touch(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
}

function cachedDataUrl(worktreeId: string, path: string, mime: string): Promise<string | null> {
  const key = `${worktreeId}\u0000${path}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.loadedAt < cacheTtlMs) {
    hit.pass = pass
    touch(key, hit)
    return hit.value
  }

  // A stale entry is dropped rather than overwritten: `drop` is what hands its
  // bytes back to the budget, and the plain `set` below is then a genuine
  // insertion, landing the refreshed entry at the recently-used end.
  drop(key)

  const value = bridge()
    .readFileBase64(worktreeId, path)
    .then((b64) => `data:${mime};base64,${b64}`)
    .catch(() => null)
  const entry: CacheEntry = { value, loadedAt: now, bytes: 0, pass }
  cache.set(key, entry)

  // Size is only knowable once the read lands, so the charge is a SECOND
  // continuation on the same promise, attached after the entry exists — that
  // way neither the entry nor the read has to be back-patched into the other.
  // It is a side branch: `value` is what every caller already holds, so nothing
  // here can change what they see. A failed read charges nothing (it retains a
  // null) but still occupies an entry — see cacheMaxEntries.
  void value.then((url) => {
    if (url !== null) charge(key, entry, url.length)
  })

  // No eviction here, deliberately. Entries this pass has not reached yet
  // still carry the previous pass's stamp, so evicting mid-pass would drop
  // images the document is about to ask for. The pass evicts once, after every
  // image has been asked for — see resolveMarkdownImages — and again as each
  // charge lands, by which point the whole pass is stamped.
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

  // One render of one document, for the cache's eviction rule: every image
  // asked for below is stamped with this pass and spared until the next one.
  pass++

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

  // Every image this pass wants has been asked for and stamped, so this is the
  // first moment eviction can run without touching one of them. It settles the
  // entry ceiling now and whatever bytes are already known; the bytes of reads
  // still in flight are settled as each one lands (see charge). A pass made
  // entirely of hits — switching back to a small, cached document — is also
  // the moment an earlier document's overshoot stops being protected.
  evict()

  if (jobs.length > 0) await Promise.all(jobs)

  // Serialising through innerHTML escapes attribute values, so nothing in a file
  // name can break out of the attribute it was written into.
  return tpl.innerHTML
}

/* ---- Test hooks ---------------------------------------------------------- */

/**
 * Swap the IPC bridge (tests). Pass null to restore the real `window.orbital`.
 *
 * Swapping also drops every cached image, because a cache entry is nothing but
 * an answer the *previous* bridge gave: keys are worktree id + path and carry no
 * notion of who read them, so any key still resident would keep being served
 * from the old bridge and the new one would never see the read at all. Every
 * caller happens to reset the cache itself today — which is exactly the kind of
 * discipline that holds until the one test that forgets, and that test would
 * then quietly assert on reads that never happened. Making the swap self-
 * sufficient is what lets the hook's name be the whole story.
 */
export function __setMarkdownAssetBridge(b: MarkdownAssetBridge | null): void {
  bridgeOverride = b
  __resetMarkdownAssetCache()
}

/** Override the resolved-image cache TTL (tests). */
export function __setMarkdownAssetCacheTtl(ms: number): void {
  cacheTtlMs = ms
}

/**
 * Shrink the cache budgets so eviction is observable (tests) — proving the byte
 * policy for real would otherwise mean allocating 64 MiB of base64. Pass null to
 * restore the shipping values.
 *
 * Applying a budget *includes* enforcing it, hence the {@link evict} call:
 * without it a hook whose entire purpose is to make eviction observable would
 * leave the cache sitting visibly over its own stated limit until some unrelated
 * read wandered past and noticed. A test that lowered the budget and then
 * measured the cache would really be measuring whether it got that incidental
 * read — which is how a test ends up passing for a reason nobody wrote down.
 * This is the same {@link evict} the production path calls, deliberately, so the
 * LRU policy has exactly one implementation and cannot drift: entries still go
 * oldest-first, and the newest one still survives a budget it cannot fit under.
 */
export function __setMarkdownAssetCacheLimits(limits: { maxBytes?: number; maxEntries?: number } | null): void {
  cacheMaxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES
  cacheMaxEntries = limits?.maxEntries ?? DEFAULT_MAX_ENTRIES
  evict()
}

/**
 * Drop every cached image (tests) — and only that. The TTL and the budgets are
 * configuration rather than cache contents, so they survive; a test that changed
 * them restores them itself, which keeps this from being a hook whose effect you
 * have to read the source to predict.
 */
export function __resetMarkdownAssetCache(): void {
  cache.clear()
  cacheBytes = 0
}
