import type { ResolvedTheme } from './theme'
import { highlightHtml, langForFence } from './highlight'

/**
 * Fenced code blocks in rendered markdown: ```mermaid fences become inline SVG
 * diagrams, and fences tagged with a language the app has a grammar for get
 * shiki's syntax colouring. Everything else is left exactly as marked emitted
 * it.
 *
 * Runs on marked's HTML *before* it is handed to a preview, so the same pass
 * serves both the editor's sandboxed preview frame (which cannot run scripts —
 * mermaid renders here, in the app, and only its SVG crosses into the frame)
 * and the task modal's in-page preview. Blocks are processed independently: a
 * grammar that fails to load, or a diagram with a syntax error, degrades that
 * one block and never the document.
 *
 * Like lib/markdownAssets, the rewrite happens on a parsed fragment (an inert
 * `<template>`), never by string surgery on the HTML.
 */

const FENCE_MARK = '<code class="language-'

/** True when `html` carries at least one tagged fence — the cheap pre-check that keeps untagged documents on the synchronous path. */
export function hasTaggedFences(html: string): boolean {
  return html.includes(FENCE_MARK)
}

/** Mermaid's theme for the app theme. */
function mermaidTheme(theme: ResolvedTheme): 'default' | 'dark' {
  return theme === 'light' ? 'default' : 'dark'
}

type MermaidModule = typeof import('mermaid')['default']

let mermaidPromise: Promise<MermaidModule> | null = null
let mermaidTheme_: ResolvedTheme | null = null
let diagramSeq = 0

/** The mermaid runtime, loaded on first use (it is several MB, and most documents never need it). */
function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
    // A failed chunk load must not poison every later diagram.
    mermaidPromise.catch(() => {
      mermaidPromise = null
    })
  }
  return mermaidPromise
}

/**
 * Render one diagram to SVG. Mermaid measures text while it draws, so the
 * scratch element it works in has to be laid out; it is parked off-screen
 * (not display:none, which would zero every measurement) for the duration.
 */
export async function renderMermaid(source: string, theme: ResolvedTheme): Promise<string> {
  const mermaid = await loadMermaid()
  if (mermaidTheme_ !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      // strict: mermaid sanitises labels, and click/href directives stay inert.
      securityLevel: 'strict',
      theme: mermaidTheme(theme),
      // A bad diagram throws (handled per block below) instead of mermaid
      // painting its own "syntax error" bomb into the document.
      suppressErrorRendering: true
    })
    mermaidTheme_ = theme
  }
  const scratch = document.createElement('div')
  scratch.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none'
  document.body.appendChild(scratch)
  try {
    const { svg } = await mermaid.render(`orbital-mermaid-${++diagramSeq}`, source, scratch)
    return svg
  } finally {
    scratch.remove()
  }
}

/** Test hook: forget the loaded runtime and its theme, so each test starts cold. */
export function __resetMarkdownCode(): void {
  mermaidPromise = null
  mermaidTheme_ = null
  diagramSeq = 0
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Rewrite every tagged fence in `html` (see the module note). Resolves to the
 * input untouched when there is nothing to do.
 */
export async function enhanceMarkdownCode(html: string, theme: ResolvedTheme): Promise<string> {
  if (!hasTaggedFences(html)) return html

  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const blocks = [...tpl.content.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')]

  await Promise.all(
    blocks.map(async (code) => {
      const pre = code.parentElement
      if (!pre) return
      const tag = (/(?:^|\s)language-(\S+)/.exec(code.className)?.[1] ?? '').toLowerCase()
      const source = code.textContent ?? ''

      if (tag === 'mermaid') {
        let replacement: string
        try {
          replacement = `<div class="mermaid-diagram">${await renderMermaid(source, theme)}</div>`
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Keep the source readable under the message, so the author can see
          // what mermaid choked on without flipping back to the editor.
          replacement =
            `<div class="mermaid-error"><div class="mermaid-error-title">Mermaid: ${escapeHtml(message)}</div>` +
            `<pre><code>${escapeHtml(source)}</code></pre></div>`
        }
        const holder = document.createElement('template')
        holder.innerHTML = replacement
        pre.replaceWith(holder.content)
        return
      }

      const lang = langForFence(tag)
      if (!lang) return
      try {
        const holder = document.createElement('template')
        holder.innerHTML = await highlightHtml(source, lang, theme)
        pre.replaceWith(holder.content)
      } catch {
        // No grammar, or the chunk failed to load: the plain block stands.
      }
    })
  )

  return tpl.innerHTML
}
