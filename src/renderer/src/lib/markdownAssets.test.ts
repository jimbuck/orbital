import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extOf,
  imageMime,
  previewImageMime,
  resolveMarkdownAssetPath,
  resolveMarkdownImages,
  __setMarkdownAssetBridge,
  __setMarkdownAssetCacheLimits,
  __setMarkdownAssetCacheTtl,
  __resetMarkdownAssetCache
} from './markdownAssets'

/** A fake readFileBase64 bridge that records reads and can fail on demand. */
function makeBridge(fail: (path: string) => boolean = () => false) {
  const reads: string[] = []
  return {
    bridge: {
      readFileBase64: async (worktreeId: string, path: string): Promise<string> => {
        reads.push(`${worktreeId}:${path}`)
        if (fail(path)) throw new Error('ENOENT')
        // Deterministic, path-derived "bytes" so tests can assert which file landed where.
        return Buffer.from(path).toString('base64')
      }
    },
    reads
  }
}

const b64 = (s: string): string => Buffer.from(s).toString('base64')

/** Every `src` in a body of HTML, in document order. */
function srcs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '')
}

describe('resolveMarkdownAssetPath', () => {
  it('resolves relative paths against the markdown file directory', () => {
    expect(resolveMarkdownAssetPath('docs/guide.md', './diagram.png')).toBe('docs/diagram.png')
    expect(resolveMarkdownAssetPath('docs/guide.md', 'diagram.png')).toBe('docs/diagram.png')
    expect(resolveMarkdownAssetPath('docs/guide.md', './img/diagram.png')).toBe('docs/img/diagram.png')
    expect(resolveMarkdownAssetPath('README.md', 'assets/logo.png')).toBe('assets/logo.png')
  })

  it('walks ../ segments that stay inside the repo', () => {
    expect(resolveMarkdownAssetPath('docs/deep/guide.md', '../img/a.png')).toBe('docs/img/a.png')
    expect(resolveMarkdownAssetPath('docs/deep/guide.md', '../../a.png')).toBe('a.png')
    expect(resolveMarkdownAssetPath('a/b/c/d.md', '../../x/./y.png')).toBe('a/x/y.png')
  })

  it('rejects paths that escape the worktree root', () => {
    expect(resolveMarkdownAssetPath('docs/guide.md', '../../secrets.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', '../outside.png')).toBeNull()
    expect(resolveMarkdownAssetPath('a/b.md', '../../../../etc/passwd.png')).toBeNull()
    // A traversal hidden in percent-escapes is decoded before normalisation.
    expect(resolveMarkdownAssetPath('a/b.md', '..%2F..%2Fsecrets.png')).toBeNull()
    expect(resolveMarkdownAssetPath('a/b.md', '..%5C..%5Csecrets.png')).toBeNull()
  })

  it('applies the remote-root and scheme guards after decoding too', () => {
    // Checked against the raw text these guards are trivially bypassable: the
    // escape survives them and *then* decodes, collapsing to a path the author
    // never wrote (`docs/host/x.png`, `docs/C:/x.png`).
    expect(resolveMarkdownAssetPath('docs/guide.md', '%2F%2Fhost/x.png')).toBeNull()
    expect(resolveMarkdownAssetPath('docs/guide.md', '/%2Fhost/x.png')).toBeNull()
    expect(resolveMarkdownAssetPath('docs/guide.md', '%5C%5Cserver%5Cshare%5Cx.png')).toBeNull()
    expect(resolveMarkdownAssetPath('docs/guide.md', '%43%3A%2Fx.png')).toBeNull()
    expect(resolveMarkdownAssetPath('docs/guide.md', '%68ttp%3A//x.test/a.png')).toBeNull()
    // A single decoded separator is still just the worktree root.
    expect(resolveMarkdownAssetPath('docs/guide.md', '%2Fassets/logo.png')).toBe('assets/logo.png')
  })

  it('decodes the markdown path with the same normaliser as the source', () => {
    expect(resolveMarkdownAssetPath('docs%2Fdeep/guide.md', 'a.png')).toBe('docs/deep/a.png')
    expect(resolveMarkdownAssetPath('docs/..%2F..%2Fguide.md', 'a.png')).toBeNull()
    expect(resolveMarkdownAssetPath('%2F%2Fhost/guide.md', 'a.png')).toBeNull()
    expect(resolveMarkdownAssetPath('%43%3A%2Frepo%2Fguide.md', 'a.png')).toBeNull()
  })

  it('normalises the markdown file directory before joining', () => {
    // The md path is the base for every relative source, so a non-canonical one
    // must not survive into the result: `..` there escapes just as surely as a
    // `..` in the source, and it never reaches the source-side guard because
    // it's already sitting in the stack.
    expect(resolveMarkdownAssetPath('../guide.md', 'logo.png')).toBeNull()
    expect(resolveMarkdownAssetPath('docs/../../guide.md', 'logo.png')).toBeNull()
    expect(resolveMarkdownAssetPath('a/../../b/guide.md', 'x.png')).toBeNull()
    // A md path that wanders but stays inside still resolves, canonicalised.
    expect(resolveMarkdownAssetPath('docs/../guide.md', 'logo.png')).toBe('logo.png')
    expect(resolveMarkdownAssetPath('./docs/guide.md', 'logo.png')).toBe('docs/logo.png')
    expect(resolveMarkdownAssetPath('a/b/../c/guide.md', './logo.png')).toBe('a/c/logo.png')
    // The md directory and the source are normalised as one join, so a `..` in
    // the source can still walk back through a `.` in the directory.
    expect(resolveMarkdownAssetPath('a/./b/guide.md', '../logo.png')).toBe('a/logo.png')
  })

  it('rejects a markdown path that is remote or drive-absolute', () => {
    expect(resolveMarkdownAssetPath('\\\\server\\share\\guide.md', 'logo.png')).toBeNull()
    expect(resolveMarkdownAssetPath('//host/guide.md', 'logo.png')).toBeNull()
    expect(resolveMarkdownAssetPath('C:\\repo\\guide.md', 'logo.png')).toBeNull()
    expect(resolveMarkdownAssetPath('C:/repo/guide.md', 'logo.png')).toBeNull()
  })

  it('resolves leading-slash paths against the worktree root', () => {
    expect(resolveMarkdownAssetPath('docs/deep/guide.md', '/assets/logo.png')).toBe('assets/logo.png')
    expect(resolveMarkdownAssetPath('docs/guide.md', '/logo.png')).toBe('logo.png')
    // Rooted paths can't climb out either.
    expect(resolveMarkdownAssetPath('docs/guide.md', '/../logo.png')).toBeNull()
    // A rooted source never consults the markdown directory, so an odd md path
    // is irrelevant rather than fatal.
    expect(resolveMarkdownAssetPath('../guide.md', '/logo.png')).toBe('logo.png')
  })

  it('decodes percent-encoded segments', () => {
    expect(resolveMarkdownAssetPath('docs/guide.md', 'my%20image.png')).toBe('docs/my image.png')
    expect(resolveMarkdownAssetPath('README.md', 'a%20b/c%2Bd.png')).toBe('a b/c+d.png')
    // A malformed escape is kept literally rather than throwing.
    expect(resolveMarkdownAssetPath('README.md', '100%.png')).toBe('100%.png')
  })

  it('leaves remote and inline sources alone', () => {
    expect(resolveMarkdownAssetPath('README.md', 'http://x.test/a.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', 'https://x.test/a.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', 'HTTPS://X.test/a.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', 'data:image/png;base64,AAAA')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', '//host/x.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', 'file:///c:/x.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', 'C:/x.png')).toBeNull()
  })

  it('rejects UNC shares and drive-absolute paths', () => {
    // A UNC share names a remote host. Without this it would fold down to
    // `server/share/img.png` and either waste an IPC read or — worse — render an
    // unrelated repo file that happens to live at that path.
    expect(resolveMarkdownAssetPath('README.md', '\\\\server\\share\\img.png')).toBeNull()
    expect(resolveMarkdownAssetPath('docs/guide.md', '\\\\server\\share\\img.png')).toBeNull()
    // Mixed separators are the same thing as far as Windows is concerned.
    expect(resolveMarkdownAssetPath('README.md', '//server/share/img.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', '/\\server/share/img.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', '\\/server/share/img.png')).toBeNull()
    // Drive-absolute paths are already caught as a `scheme:` — in both flavours.
    expect(resolveMarkdownAssetPath('README.md', 'C:\\foo\\bar.png')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', 'c:/foo/bar.png')).toBeNull()
    // A single leading separator is still the worktree root, not a share.
    expect(resolveMarkdownAssetPath('README.md', '\\assets\\logo.png')).toBe('assets/logo.png')
  })

  it('returns null for empty or contentless sources', () => {
    expect(resolveMarkdownAssetPath('README.md', '')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', '   ')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', './')).toBeNull()
    expect(resolveMarkdownAssetPath('README.md', '#anchor')).toBeNull()
  })

  it('drops a query string or fragment', () => {
    expect(resolveMarkdownAssetPath('README.md', 'logo.png?v=2')).toBe('logo.png')
    expect(resolveMarkdownAssetPath('README.md', 'logo.png#frag')).toBe('logo.png')
  })

  it('normalises backslash separators', () => {
    expect(resolveMarkdownAssetPath('docs/guide.md', 'img\\a.png')).toBe('docs/img/a.png')
  })
})

describe('image mime helpers', () => {
  it('maps known extensions', () => {
    expect(extOf('a/b/c.PNG')).toBe('png')
    expect(imageMime('a/b.png')).toBe('image/png')
    expect(imageMime('a/b.jpeg')).toBe('image/jpeg')
    expect(imageMime('a/b.txt')).toBeNull()
  })

  it('treats svg as an image for previews only', () => {
    // File mode keeps .svg as editable text, so imageMime deliberately omits it…
    expect(imageMime('a/b.svg')).toBeNull()
    // …but a markdown-referenced .svg is just an image.
    expect(previewImageMime('a/b.svg')).toBe('image/svg+xml')
    expect(previewImageMime('a/b.png')).toBe('image/png')
    expect(previewImageMime('a/b.txt')).toBeNull()
  })
})

describe('resolveMarkdownImages', () => {
  beforeEach(() => {
    __resetMarkdownAssetCache()
    __setMarkdownAssetCacheTtl(30_000)
  })
  afterEach(() => {
    __setMarkdownAssetBridge(null)
    __resetMarkdownAssetCache()
  })

  it('inlines a relative image as a data URL', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    const out = await resolveMarkdownImages('<p><img src="./diagram.png" alt="d"></p>', {
      worktreeId: 'w1',
      mdPath: 'docs/guide.md'
    })

    expect(srcs(out)).toEqual([`data:image/png;base64,${b64('docs/diagram.png')}`])
    expect(b.reads).toEqual(['w1:docs/diagram.png'])
    // Everything else about the markup survives the round trip.
    expect(out).toContain('alt="d"')
  })

  it('inlines an svg reference', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    const out = await resolveMarkdownImages('<img src="icon.svg">', { worktreeId: 'w1', mdPath: 'a/b.md' })
    expect(srcs(out)).toEqual([`data:image/svg+xml;base64,${b64('a/icon.svg')}`])
  })

  it('leaves remote, inline and escaping sources untouched', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    const html = [
      '<img src="http://x.test/a.png">',
      '<img src="https://x.test/b.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="//host/c.png">',
      '<img src="../../escape.png">',
      '<img src="notes.txt">'
    ].join('')
    const out = await resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'docs/guide.md' })

    expect(srcs(out)).toEqual([
      'http://x.test/a.png',
      'https://x.test/b.png',
      'data:image/png;base64,AAAA',
      '//host/c.png',
      '../../escape.png',
      'notes.txt'
    ])
    expect(b.reads).toEqual([]) // nothing was read from disk
  })

  it('reads nothing for UNC, drive-absolute or traversing md paths', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    const html = [
      '<img src="\\\\server\\share\\img.png">',
      '<img src="C:\\secrets\\img.png">',
      '<img src="//host/share/img.png">'
    ].join('')
    const out = await resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'docs/guide.md' })
    expect(srcs(out)).toEqual(['\\\\server\\share\\img.png', 'C:\\secrets\\img.png', '//host/share/img.png'])

    // Same for a perfectly ordinary source under a non-canonical md path.
    const out2 = await resolveMarkdownImages('<img src="logo.png">', {
      worktreeId: 'w1',
      mdPath: '../guide.md'
    })
    expect(srcs(out2)).toEqual(['logo.png'])

    expect(b.reads).toEqual([]) // nothing was read from disk
  })

  it('degrades gracefully when a read fails', async () => {
    const b = makeBridge((p) => p === 'docs/missing.png')
    __setMarkdownAssetBridge(b.bridge)

    const out = await resolveMarkdownImages('<img src="missing.png"><img src="ok.png">', {
      worktreeId: 'w1',
      mdPath: 'docs/guide.md'
    })

    // The broken one keeps its original src; the good one still resolves.
    expect(srcs(out)).toEqual(['missing.png', `data:image/png;base64,${b64('docs/ok.png')}`])
  })

  it('reads a repeated path once and reuses the cache across renders', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    const html = '<img src="logo.png"><img src="./logo.png"><img src="other.png">'
    const first = await resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'guide.md' })
    expect(srcs(first)).toEqual([
      `data:image/png;base64,${b64('logo.png')}`,
      `data:image/png;base64,${b64('logo.png')}`,
      `data:image/png;base64,${b64('other.png')}`
    ])
    expect(b.reads).toEqual(['w1:logo.png', 'w1:other.png'])

    // A rebuild (theme flip / keystroke) hits the cache instead of re-reading.
    await resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'guide.md' })
    expect(b.reads).toEqual(['w1:logo.png', 'w1:other.png'])
  })

  it('never serves one worktree cached bytes from another', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    await resolveMarkdownImages('<img src="logo.png">', { worktreeId: 'w1', mdPath: 'guide.md' })
    await resolveMarkdownImages('<img src="logo.png">', { worktreeId: 'w2', mdPath: 'guide.md' })

    expect(b.reads).toEqual(['w1:logo.png', 'w2:logo.png'])
  })

  it('re-reads an image once its cache entry expires', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheTtl(0) // everything is immediately stale

    await resolveMarkdownImages('<img src="logo.png">', { worktreeId: 'w1', mdPath: 'guide.md' })
    await resolveMarkdownImages('<img src="logo.png">', { worktreeId: 'w1', mdPath: 'guide.md' })

    expect(b.reads).toEqual(['w1:logo.png', 'w1:logo.png'])
  })

  it('cannot be used to inject markup through a crafted file name', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    // A file name carrying quote + tag characters must end up escaped inside the
    // attribute, never re-serialised as new elements.
    const out = await resolveMarkdownImages('<img src="a%22%3E%3Cscript%3Ex.png">', {
      worktreeId: 'w1',
      mdPath: 'guide.md'
    })

    expect(out).not.toContain('<script')
    expect(srcs(out)).toEqual([`data:image/png;base64,${b64('a"><script>x.png')}`])
  })

  it('returns the html unchanged when there are no images', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    const out = await resolveMarkdownImages('<h1>Hi</h1><p>No pictures.</p>', {
      worktreeId: 'w1',
      mdPath: 'guide.md'
    })
    expect(out).toBe('<h1>Hi</h1><p>No pictures.</p>')
    expect(b.reads).toEqual([])
  })

  it('returns image-free html byte-for-byte, including leading head-ish markup', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    // A document parser hoists all of this out of <body> (or above <html>), so
    // serialising the body alone dropped it — on every preview, images or not.
    const html =
      '<!-- omit in toc -->\n<style>p{color:red}</style>\n<meta name="a" content="b">\n<h1>T</h1>'
    expect(await resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'guide.md' })).toBe(html)
    expect(b.reads).toEqual([])
  })

  it('keeps leading head-ish markup in a document that does have images', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    const out = await resolveMarkdownImages(
      '<!-- omit in toc --><style>p{color:red}</style><p><img src="./a.png"></p>',
      { worktreeId: 'w1', mdPath: 'docs/guide.md' }
    )

    expect(out).toContain('<!-- omit in toc -->')
    expect(out).toContain('<style>p{color:red}</style>')
    expect(srcs(out)).toEqual([`data:image/png;base64,${b64('docs/a.png')}`])
  })

  it('never emits a script into the preview frame', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    // The frame is sandboxed without allow-scripts so this is inert either way,
    // but the rewrite must not become the thing that reintroduces it.
    const withImage = await resolveMarkdownImages('<script>alert(1)</script><p><img src="./a.png"></p>', {
      worktreeId: 'w1',
      mdPath: 'docs/guide.md'
    })
    expect(withImage).not.toContain('<script')
    expect(withImage).toContain('data:image/png;base64,')

    const withoutImage = await resolveMarkdownImages('<script>alert(1)</script><p>x</p>', {
      worktreeId: 'w1',
      mdPath: 'docs/guide.md'
    })
    expect(withoutImage).toBe('<p>x</p>')
  })

  it('inlines srcset candidates on both <img> and <source>', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    // The GitHub dark/light-logo idiom: the browser prefers the <source>, so
    // rewriting only the <img> fallback still renders a broken image.
    const html =
      '<picture><source srcset="./logo-dark.webp">' +
      '<img src="./logo.png" srcset="./logo.png 1x, ./logo@2x.png 2x" alt="l"></picture>'
    const out = await resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'docs/guide.md' })

    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(doc.querySelector('source')?.getAttribute('srcset')).toBe(
      `data:image/webp;base64,${b64('docs/logo-dark.webp')}`
    )
    expect(doc.querySelector('img')?.getAttribute('srcset')).toBe(
      `data:image/png;base64,${b64('docs/logo.png')} 1x, data:image/png;base64,${b64('docs/logo@2x.png')} 2x`
    )
    expect(srcs(out)).toEqual([`data:image/png;base64,${b64('docs/logo.png')}`])
    // The <img> src and its 1x candidate are the same file: one read.
    expect(b.reads).toEqual(['w1:docs/logo.png', 'w1:docs/logo-dark.webp', 'w1:docs/logo@2x.png'])
  })

  it('leaves srcset candidates it cannot resolve exactly as written', async () => {
    const b = makeBridge((p) => p === 'docs/gone.png')
    __setMarkdownAssetBridge(b.bridge)

    const html =
      '<img srcset="https://x.test/a.png 1x,\n  ./b.png 2x,\n  ../../escape.png 3x,\n  ./gone.png 4x">'
    const out = await resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'docs/guide.md' })

    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(doc.querySelector('img')?.getAttribute('srcset')).toBe(
      'https://x.test/a.png 1x,\n  ' +
        `data:image/png;base64,${b64('docs/b.png')} 2x,\n  ` +
        '../../escape.png 3x,\n  ' +
        './gone.png 4x'
    )
  })

  it('does not split a srcset candidate on a comma inside its url', async () => {
    const b = makeBridge()
    __setMarkdownAssetBridge(b.bridge)

    // Per the HTML rules a candidate's URL is a run of non-whitespace, so the
    // commas inside a data: URL are part of it — which is also why inlining as
    // data: URLs is safe here.
    const html = '<img srcset="data:image/png;base64,AAAA 1x, ./b.png 2x">'
    const out = await resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'docs/guide.md' })

    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(doc.querySelector('img')?.getAttribute('srcset')).toBe(
      `data:image/png;base64,AAAA 1x, data:image/png;base64,${b64('docs/b.png')} 2x`
    )
    expect(b.reads).toEqual(['w1:docs/b.png'])
  })
})

/* ---- Cache policy --------------------------------------------------------- */

/** Base64 payload length every read in these tests returns. */
const IMG_B64 = 1_000

/** What one cached image costs the budget: the data URL, prefix included. */
const ENTRY_BYTES = `data:image/png;base64,${'A'.repeat(IMG_B64)}`.length

/**
 * A bridge whose reads return `units(path)` whole images' worth of payload, so a
 * budget can be expressed in whole images ("two fit") rather than in the
 * incidental length of whichever path the test happened to pick. `units` is what
 * lets a test build an image bigger than the entire budget, which is the one
 * shape the eviction rule has a special case for.
 */
function makeSizedBridge(
  fail: (path: string) => boolean = () => false,
  units: (path: string) => number = () => 1
): {
  bridge: { readFileBase64: (worktreeId: string, path: string) => Promise<string> }
  reads: string[]
} {
  const reads: string[] = []
  return {
    bridge: {
      readFileBase64: async (worktreeId: string, path: string): Promise<string> => {
        reads.push(`${worktreeId}:${path}`)
        if (fail(path)) throw new Error('ENOENT')
        return 'A'.repeat(IMG_B64 * units(path))
      }
    },
    reads
  }
}

/**
 * Resolve a document listing `paths` as images, in that order.
 *
 * Document order is load-bearing for eviction, which is why these tests can't
 * all be one image at a time: reads are charged in the order they settle, and
 * the entry the budget spares is the most recently used one. A one-image
 * document is the single shape where "the entry being charged" and "the last
 * entry in the map" cannot come apart.
 *
 * Every assertion below is made on the bridge's read log: a path that is still
 * cached is never read again, and one that was evicted is — which is the only
 * externally visible consequence of the cache's policy, and the one that
 * actually costs IPC.
 */
function loadDoc(paths: readonly string[]): Promise<string> {
  const html = paths.map((path) => `<img src="${path}">`).join('')
  return resolveMarkdownImages(html, { worktreeId: 'w1', mdPath: 'guide.md' })
}

/** Resolve a one-image document. */
function load(path: string): Promise<string> {
  return loadDoc([path])
}

describe('markdown asset cache policy', () => {
  beforeEach(() => {
    __resetMarkdownAssetCache()
    __setMarkdownAssetCacheTtl(30_000)
  })
  afterEach(() => {
    __setMarkdownAssetBridge(null)
    __setMarkdownAssetCacheTtl(30_000)
    __setMarkdownAssetCacheLimits(null)
    __resetMarkdownAssetCache()
  })

  it('evicts by stored bytes rather than by entry count', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    // A budget of two images — far below the old 64-entry cap, which would have
    // held all three regardless of how many megabytes that came to.
    __setMarkdownAssetCacheLimits({ maxBytes: 2 * ENTRY_BYTES })

    await load('a.png')
    await load('b.png')
    await load('c.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png'])

    // The two newest are still resident…
    await load('c.png')
    await load('b.png')
    expect(b.reads).toHaveLength(3)

    // …and the oldest was pushed out to stay inside the budget.
    await load('a.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png', 'w1:a.png'])
  })

  it('keeps a lone image that by itself exceeds the budget', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 1 })

    // Evicting the entry whose read just landed would mean re-reading the image
    // over IPC on every keystroke — the exact cost the cache exists to avoid,
    // and worst on the very file that triggers it.
    //
    // This is only the easy half of that claim, and for a long time it was the
    // whole of what was tested: in a one-image document the entry being charged
    // is also the last entry in the map, so a rule that spares either one looks
    // identical. The two tests below are the ones that can tell them apart.
    await load('huge.png')
    await load('huge.png')
    expect(b.reads).toEqual(['w1:huge.png'])
  })

  it('keeps an oversized image charged before a smaller one in the same document', async () => {
    const b = makeSizedBridge(
      () => false,
      (path) => (path === 'huge.png' ? 3 : 1)
    )
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 2 * ENTRY_BYTES })

    await loadDoc(['huge.png', 'small.png'])
    expect(b.reads).toEqual(['w1:huge.png', 'w1:small.png'])

    // `huge` settles first and overshoots the budget on its own, so its charge is
    // the one that has to evict. The entry spared used to be the map tail —
    // `small`, purely because the author listed it second — which left `huge`
    // evicting *itself* the instant its read landed, and the next render reading
    // the largest image in the document all over again.
    await load('huge.png')
    expect(b.reads).toEqual(['w1:huge.png', 'w1:small.png'])
  })

  it('keeps an oversized image charged after a smaller one in the same document', async () => {
    const b = makeSizedBridge(
      () => false,
      (path) => (path === 'huge.png' ? 3 : 1)
    )
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 2 * ENTRY_BYTES })

    // The mirror image of the case above: same two images, opposite order, so the
    // oversized charge arrives last instead of first. The guarantee is about the
    // entry being charged, so it must not depend on where in the document it sat.
    await loadDoc(['small.png', 'huge.png'])
    expect(b.reads).toEqual(['w1:small.png', 'w1:huge.png'])

    await load('huge.png')
    expect(b.reads).toHaveLength(2)

    // Where the overshoot goes: the two-image document was four images' worth
    // against a two-image budget and stayed resident as a whole while it was
    // the document on screen. The `load('huge.png')` above was a *different*
    // document (one image), so `small` stopped being protected and was
    // reclaimed to bring the total back under budget; the next reference to
    // it costs a read.
    await load('small.png')
    expect(b.reads).toEqual(['w1:small.png', 'w1:huge.png', 'w1:small.png'])

    // With only two images the assertions above hold under the old rule too:
    // the entry charged last is also the map tail, so sparing either spares the
    // same one. Give the oversized image a neighbour on each side and the two
    // rules come apart again: `tiny` is the map tail, while `huge` is the entry
    // whose charge does the evicting and so the one that has to survive.
    __resetMarkdownAssetCache()
    b.reads.length = 0
    await loadDoc(['small.png', 'huge.png', 'tiny.png'])
    expect(b.reads).toEqual(['w1:small.png', 'w1:huge.png', 'w1:tiny.png'])

    await load('huge.png')
    expect(b.reads).toHaveLength(3)
  })

  it('bounds the map by entry count too, so cached failures cannot pile up', async () => {
    const b = makeSizedBridge(() => true)
    __setMarkdownAssetBridge(b.bridge)
    // Failures retain nothing, so they never trip a byte budget — only the
    // entry ceiling can bound a document full of broken image paths.
    __setMarkdownAssetCacheLimits({ maxEntries: 2 })

    await load('x.png')
    await load('x.png')
    expect(b.reads).toEqual(['w1:x.png']) // a failure is cached, per the module's decision

    await load('y.png')
    await load('z.png')
    await load('x.png')
    expect(b.reads).toEqual(['w1:x.png', 'w1:y.png', 'w1:z.png', 'w1:x.png'])
  })

  it('makes a cache hit the most recently used entry', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 2 * ENTRY_BYTES })

    await load('a.png')
    await load('b.png')
    await load('a.png') // a hit — this is what has to move `a` to the recent end

    await load('c.png') // over budget: the least recently used must go, i.e. b
    await load('a.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png'])

    await load('b.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png', 'w1:b.png'])
  })

  it('makes a refreshed entry the most recently used one', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 2 * ENTRY_BYTES })

    await load('a.png')
    await load('b.png')

    // Expire `a` and read it again. `Map.set` on a key already present leaves it
    // where it first landed, so before the fix the freshly re-read `a` was still
    // the oldest thing in the map and the next insert threw it away — the
    // opposite of what a re-read means.
    __setMarkdownAssetCacheTtl(0)
    await load('a.png')
    __setMarkdownAssetCacheTtl(30_000)
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:a.png'])

    await load('c.png')
    await load('a.png') // refreshed, so still resident
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:a.png', 'w1:c.png'])

    await load('b.png') // the genuinely least recently used one is what went
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:a.png', 'w1:c.png', 'w1:b.png'])
  })

  it('returns a replaced entry bytes to the budget', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 3 * ENTRY_BYTES })

    await load('a.png')
    await load('b.png')

    // Refresh one key repeatedly. Each pass replaces the entry rather than
    // adding one, so the total must stay at two images' worth; a leak here would
    // silently evict `b` to pay for bytes nothing is holding.
    __setMarkdownAssetCacheTtl(0)
    for (let i = 0; i < 5; i++) await load('a.png')
    __setMarkdownAssetCacheTtl(30_000)

    await load('b.png')
    expect(b.reads.filter((r) => r === 'w1:b.png')).toEqual(['w1:b.png'])
  })

  it('applies a lowered byte budget immediately, evicting least-recently-used first', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 3 * ENTRY_BYTES })

    await load('a.png')
    await load('b.png')
    await load('c.png')
    await load('a.png') // a hit, so the order is now b (oldest), c, a (newest)
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png'])

    // Lowering the budget has to bite here rather than at the next read: a hook
    // that exists to make eviction observable must not leave the cache sitting
    // over its own stated limit, or a test measuring the cache is really
    // measuring whether an unrelated load happened to run first.
    __setMarkdownAssetCacheLimits({ maxBytes: ENTRY_BYTES })

    // The most recently used entry is the one that survived…
    await load('a.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png'])

    // …and the two older ones are actually gone, in LRU order, not merely
    // queued up to be dropped by whatever read comes next.
    await load('b.png')
    await load('c.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png', 'w1:b.png', 'w1:c.png'])
  })

  it('keeps the newest entry when the budget is lowered below a single image', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)

    await load('a.png')
    await load('b.png')

    // Same rule as the insert path, because it is the same eviction: shrinking
    // the budget below one image must not leave an empty cache that re-reads on
    // every keystroke. This is the test that pins the *shape* of the shared
    // policy rather than the deferral bug — it is what fails if the budget hook
    // ever grows its own `while (bytes > max) drop()` loop instead of calling
    // the one `evict` the insert path uses.
    __setMarkdownAssetCacheLimits({ maxBytes: 1 })

    await load('b.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png'])
  })

  it('applies a lowered entry ceiling immediately too', async () => {
    const b = makeSizedBridge(() => true)
    __setMarkdownAssetBridge(b.bridge)

    // Failures retain zero bytes, so the entry ceiling is the only budget that
    // can move here — which makes this the clean test of that half.
    await load('x.png')
    await load('y.png')
    await load('z.png')
    expect(b.reads).toEqual(['w1:x.png', 'w1:y.png', 'w1:z.png'])

    __setMarkdownAssetCacheLimits({ maxEntries: 1 })

    await load('z.png') // the newest, and the only survivor
    expect(b.reads).toHaveLength(3)

    await load('x.png')
    await load('y.png')
    expect(b.reads).toEqual(['w1:x.png', 'w1:y.png', 'w1:z.png', 'w1:x.png', 'w1:y.png'])
  })

  it('drops cached images when the bridge is swapped', async () => {
    const first = makeSizedBridge()
    __setMarkdownAssetBridge(first.bridge)
    await load('a.png')
    expect(first.reads).toEqual(['w1:a.png'])

    // A cache entry is an answer the *old* bridge gave, and keys carry no notion
    // of who read them — so a swap that left entries resident would keep serving
    // them and the new bridge would never see the read.
    const second = makeSizedBridge()
    __setMarkdownAssetBridge(second.bridge)
    await load('a.png')
    expect(second.reads).toEqual(['w1:a.png'])
  })

  it('still expires on the TTL, however recently the entry was used', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)

    await load('a.png')
    await load('a.png') // a hit: touched, but its load time must not be reset
    expect(b.reads).toEqual(['w1:a.png'])

    // Otherwise an image referenced on every keystroke would be pinned for the
    // session, and an edit to it on disk would never show up in the preview.
    __setMarkdownAssetCacheTtl(0)
    await load('a.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:a.png'])
  })
})

/* ---- Straggling reads ------------------------------------------------------
 *
 * A read is charged to the budget when it SETTLES, and by then its entry may no
 * longer be the live one for its key: the TTL replaced it, or eviction dropped
 * it while the read was still in flight. `charge` has an identity check for
 * exactly this, and before these tests deleting that check killed nothing.
 * -------------------------------------------------------------------------- */

/**
 * A sized bridge whose reads for `held` paths do not settle until the test
 * says so (in order), so a read can be made to land after its entry has been
 * replaced or evicted. Reads for every other path settle immediately.
 */
function makeHeldBridge(held: readonly string[]): {
  bridge: { readFileBase64: (worktreeId: string, path: string) => Promise<string> }
  reads: string[]
  release: () => void
} {
  const reads: string[] = []
  const pending: (() => void)[] = []
  return {
    bridge: {
      readFileBase64: (worktreeId: string, path: string): Promise<string> => {
        reads.push(`${worktreeId}:${path}`)
        const bytes = 'A'.repeat(IMG_B64)
        if (!held.includes(path)) return Promise.resolve(bytes)
        return new Promise((resolve) => pending.push(() => resolve(bytes)))
      }
    },
    reads,
    release: (): void => {
      pending.shift()?.()
    }
  }
}

describe('markdown asset cache straggling reads', () => {
  beforeEach(() => {
    __resetMarkdownAssetCache()
    __setMarkdownAssetCacheTtl(30_000)
  })
  afterEach(() => {
    __setMarkdownAssetBridge(null)
    __setMarkdownAssetCacheTtl(30_000)
    __setMarkdownAssetCacheLimits(null)
    __resetMarkdownAssetCache()
  })

  it('does not charge a read that settles after its entry was replaced', async () => {
    const b = makeHeldBridge(['a.png'])
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 2 * ENTRY_BYTES })

    // Two reads of `a` in flight at once: the first entry expired (TTL 0)
    // before it settled, so the second load dropped it and inserted a fresh
    // entry with its own read.
    const first = load('a.png')
    __setMarkdownAssetCacheTtl(0)
    const second = load('a.png')
    __setMarkdownAssetCacheTtl(30_000)
    expect(b.reads).toEqual(['w1:a.png', 'w1:a.png'])

    // The stale read lands first. Its entry is no longer the live one, so its
    // bytes must not be charged — and it must not be reinserted over the live
    // entry either.
    b.release()
    await first
    b.release()
    await second

    // With `a` charged once, `a` + `b` fit the two-image budget exactly, so
    // `a` is still resident. A leaked charge from the stale read would have
    // put the total one image over and evicted `a` to pay for it — in which
    // case this last load is a fresh (held) read, released so the assertion
    // rather than the test timeout is what reports it.
    await load('b.png')
    const again = load('a.png')
    b.release()
    await again
    expect(b.reads).toEqual(['w1:a.png', 'w1:a.png', 'w1:b.png'])
  })

  it('does not resurrect or charge an entry evicted while its read was in flight', async () => {
    const b = makeHeldBridge(['a.png'])
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxEntries: 2 })

    // `a` is pending; `b` and `c` land at once and push it out by count.
    const a = load('a.png')
    await load('b.png')
    await load('c.png')

    // Now `a` settles. Its entry is gone: the charge must be ignored rather
    // than reinserting the entry and evicting `b` to make room for it.
    b.release()
    await a
    await load('b.png')
    await load('c.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png'])

    // And `a` really is gone — asking for it again is a fresh read.
    const again = load('a.png')
    b.release()
    await again
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png', 'w1:a.png'])
  })
})

/* ---- Passes ---------------------------------------------------------------
 *
 * One render of one document is a pass, and nothing a pass asked for is evicted
 * to make room for something else the same pass asked for. Without that, a
 * document over budget hit the LRU sequential-scan cliff: 0% hit rate, every
 * image re-read on every keystroke.
 * -------------------------------------------------------------------------- */

describe('markdown asset cache passes', () => {
  beforeEach(() => {
    __resetMarkdownAssetCache()
    __setMarkdownAssetCacheTtl(30_000)
  })
  afterEach(() => {
    __setMarkdownAssetBridge(null)
    __setMarkdownAssetCacheTtl(30_000)
    __setMarkdownAssetCacheLimits(null)
    __resetMarkdownAssetCache()
  })

  it('keeps a document resident across renders even when it exceeds the byte budget', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 3 * ENTRY_BYTES })
    const doc = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']

    await loadDoc(doc)
    expect(b.reads).toHaveLength(5)

    // A keystroke, then another. Before the pass rule each image loaded here
    // evicted one loaded earlier in the same render, so every render re-read
    // all five.
    await loadDoc(doc)
    await loadDoc(doc)
    expect(b.reads).toHaveLength(5)
  })

  it('keeps a document resident across renders even when it exceeds the entry ceiling', async () => {
    // The probe from the original report: 50 broken images against a
    // 10-entry ceiling gave 50 reads on render 1 and 50 again on render 2.
    const b = makeSizedBridge(() => true)
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxEntries: 10 })
    const doc = Array.from({ length: 50 }, (_, i) => `broken-${i}.png`)

    await loadDoc(doc)
    expect(b.reads).toHaveLength(50)
    await loadDoc(doc)
    expect(b.reads).toHaveLength(50)
  })

  it('does not evict the rest of an over-budget document when an image is added at its top', async () => {
    // The order images are asked for is the document order, so a new first
    // image is inserted before the others are re-touched. Evicting at that
    // insert would drop every image the render is about to ask for; eviction
    // therefore waits until the whole pass has been asked for.
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 3 * ENTRY_BYTES })
    const doc = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']
    await loadDoc(doc)

    await loadDoc(['new.png', ...doc])
    expect(b.reads).toHaveLength(6)
    await loadDoc(['new.png', ...doc])
    expect(b.reads).toHaveLength(6)
  })

  it('reclaims the overshoot once another document renders, oldest first', async () => {
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 3 * ENTRY_BYTES })
    const doc = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']
    await loadDoc(doc)

    // A different file: its one image is the new pass, and the previous
    // document's five are fair game down to the budget — a, b, c go, d and e
    // stay beside z.
    await load('z.png')
    expect(b.reads).toHaveLength(6)
    await load('d.png')
    await load('e.png')
    expect(b.reads).toHaveLength(6)
    await load('a.png')
    expect(b.reads).toHaveLength(7)
  })

  it('still evicts within the budget when the document fits', async () => {
    // The pass rule must not turn into "never evict": an ordinary sequence of
    // small documents is still bounded by the budget, LRU first.
    const b = makeSizedBridge()
    __setMarkdownAssetBridge(b.bridge)
    __setMarkdownAssetCacheLimits({ maxBytes: 2 * ENTRY_BYTES })

    await load('a.png')
    await load('b.png')
    await load('c.png') // over budget: a is the oldest and not in this pass
    await load('b.png')
    await load('c.png')
    expect(b.reads).toEqual(['w1:a.png', 'w1:b.png', 'w1:c.png'])
    await load('a.png')
    expect(b.reads).toHaveLength(4)
  })
})
