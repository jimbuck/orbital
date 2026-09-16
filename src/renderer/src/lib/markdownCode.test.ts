import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mermaid needs a real layout engine (getBBox) that jsdom does not have, and
// shiki would pull grammar chunks into a unit test: both are stubbed, so what
// is under test is the rewrite itself — which blocks get touched, with what,
// and how one bad block degrades.
const { render, initialize, highlightHtml } = vi.hoisted(() => ({
  render: vi.fn(),
  initialize: vi.fn(),
  highlightHtml: vi.fn()
}))
vi.mock('mermaid', () => ({ default: { render, initialize } }))
vi.mock('./highlight', async () => {
  const actual = await vi.importActual<typeof import('./highlight')>('./highlight')
  return { ...actual, highlightHtml }
})

import { __resetMarkdownCode, enhanceMarkdownCode, hasTaggedFences } from './markdownCode'

const fence = (lang: string, body: string): string =>
  `<pre><code class="language-${lang}">${body}</code></pre>`

beforeEach(() => {
  __resetMarkdownCode()
  render.mockReset()
  initialize.mockReset()
  highlightHtml.mockReset()
  render.mockImplementation(async (id: string, text: string) => ({ svg: `<svg id="${id}"><title>${text}</title></svg>` }))
  highlightHtml.mockImplementation(async (code: string, lang: string) =>
    `<pre class="shiki"><code>${lang}:${code}</code></pre>`
  )
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('hasTaggedFences', () => {
  it('spots a tagged fence and ignores untagged code and inline code', () => {
    expect(hasTaggedFences(fence('ts', 'x'))).toBe(true)
    expect(hasTaggedFences('<pre><code>plain</code></pre>')).toBe(false)
    expect(hasTaggedFences('<p><code>x</code></p>')).toBe(false)
  })
})

describe('enhanceMarkdownCode', () => {
  it('returns the input untouched when there is nothing to rewrite', async () => {
    const html = '<h1>hi</h1><pre><code>plain</code></pre>'
    expect(await enhanceMarkdownCode(html, 'dark')).toBe(html)
    expect(render).not.toHaveBeenCalled()
    expect(highlightHtml).not.toHaveBeenCalled()
  })

  it('turns a mermaid fence into an inline SVG diagram, in the app theme', async () => {
    const out = await enhanceMarkdownCode(`<p>a</p>${fence('mermaid', 'graph TD; A--&gt;B')}<p>b</p>`, 'dark')
    expect(out).toBe('<p>a</p><div class="mermaid-diagram"><svg id="orbital-mermaid-1"><title>graph TD; A--&gt;B</title></svg></div><p>b</p>')
    // The source reached mermaid decoded, not as the HTML-escaped text marked emitted.
    expect(render).toHaveBeenCalledWith('orbital-mermaid-1', 'graph TD; A-->B', expect.any(HTMLElement))
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark', securityLevel: 'strict' }))
  })

  it('re-initialises mermaid when the theme flips, and only then', async () => {
    await enhanceMarkdownCode(fence('mermaid', 'a'), 'dark')
    await enhanceMarkdownCode(fence('mermaid', 'b'), 'dark')
    expect(initialize).toHaveBeenCalledTimes(1)
    await enhanceMarkdownCode(fence('mermaid', 'c'), 'light')
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }))
  })

  it('cleans up the off-screen scratch element mermaid draws in', async () => {
    await enhanceMarkdownCode(fence('mermaid', 'a'), 'dark')
    expect(document.body.children.length).toBe(0)
  })

  it('shows the error and the source when a diagram does not parse, leaving the rest alone', async () => {
    render.mockRejectedValueOnce(new Error('Parse error on line 2'))
    const out = await enhanceMarkdownCode(`${fence('mermaid', 'bad &lt;x&gt;')}${fence('mermaid', 'ok')}`, 'dark')
    expect(out).toContain('<div class="mermaid-error"><div class="mermaid-error-title">Mermaid: Parse error on line 2</div><pre><code>bad &lt;x&gt;</code></pre></div>')
    expect(out).toContain('<div class="mermaid-diagram"><svg id="orbital-mermaid-')
    expect(document.body.children.length).toBe(0)
  })

  it('highlights fences tagged with a known language, mapping common aliases', async () => {
    const out = await enhanceMarkdownCode(`${fence('ts', 'const a = 1')}${fence('sh', 'ls')}`, 'light')
    expect(out).toBe('<pre class="shiki"><code>typescript:const a = 1</code></pre><pre class="shiki"><code>bash:ls</code></pre>')
    expect(highlightHtml).toHaveBeenCalledWith('const a = 1', 'typescript', 'light')
  })

  it('leaves fences with an unknown language, and ones whose grammar fails, as marked emitted them', async () => {
    highlightHtml.mockRejectedValueOnce(new Error('chunk failed'))
    const html = `${fence('brainfuck', '+++')}${fence('rust', 'fn main() {}')}`
    expect(await enhanceMarkdownCode(html, 'dark')).toBe(html)
    expect(highlightHtml).toHaveBeenCalledTimes(1)
  })
})
