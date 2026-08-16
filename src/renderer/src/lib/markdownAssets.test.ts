import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extOf,
  imageMime,
  previewImageMime,
  resolveMarkdownAssetPath,
  resolveMarkdownImages,
  __setMarkdownAssetBridge,
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

  it('resolves leading-slash paths against the worktree root', () => {
    expect(resolveMarkdownAssetPath('docs/deep/guide.md', '/assets/logo.png')).toBe('assets/logo.png')
    expect(resolveMarkdownAssetPath('docs/guide.md', '/logo.png')).toBe('logo.png')
    // Rooted paths can't climb out either.
    expect(resolveMarkdownAssetPath('docs/guide.md', '/../logo.png')).toBeNull()
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
})
