import { useEffect, useMemo, useState, type JSX } from 'react'
import type { FileDiff } from '@shared/types'
import { useResolvedTheme } from '@renderer/lib/theme'
import { HIGHLIGHT_MAX, highlightTokens, langFor } from '@renderer/lib/highlight'

/**
 * Unified diff renderer shared by the editor tab (working-tree and staged
 * diffs) and the commit-history modal (a commit's change to one file): line
 * numbers on both sides, +/− tinted rows, and shiki-coloured code when the
 * grammar is known and the diff is not huge.
 */

/** Strip a leading +/-/space that the diff producer may already include. */
function stripSign(line: { type: string; text: string }): string {
  const { type, text } = line
  if (type === 'add' && text.startsWith('+')) return text.slice(1)
  if (type === 'del' && text.startsWith('-')) return text.slice(1)
  if (type === 'context' && text.startsWith(' ')) return text.slice(1)
  return text
}

/** A shiki-themed token line: colored spans reassembled per diff line. */
type TokenLine = { content: string; color?: string }[]

/**
 * Tokenize the diff's code lines in one shiki pass (hunk/meta lines become
 * blank placeholders so indices stay aligned). Null while loading, for unknown
 * grammars, and for oversized diffs — callers fall back to flat coloring.
 */
function useDiffTokens(diff: FileDiff, path: string): TokenLine[] | null {
  const [tokens, setTokens] = useState<TokenLine[] | null>(null)
  const theme = useResolvedTheme()

  const code = useMemo(
    () =>
      diff.lines
        .map((l) => (l.type === 'add' || l.type === 'del' || l.type === 'context' ? stripSign(l) : ''))
        .join('\n'),
    [diff]
  )

  useEffect(() => {
    let alive = true
    setTokens(null)
    const lang = langFor(path)
    if (!lang || diff.binary || code.length > HIGHLIGHT_MAX) return
    void highlightTokens(code, lang, theme)
      .then((tokens) => {
        if (alive) setTokens(tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color }))))
      })
      .catch((err) => {
        // Unknown grammar / load failure — flat coloring stays up.
        console.warn(`shiki diff highlight failed for ${path}:`, err)
      })
    return () => {
      alive = false
    }
    // theme is a dep so diff syntax colors follow the app theme.
  }, [code, path, diff.binary, theme])

  return tokens
}

export default function DiffView({ diff, path }: { diff: FileDiff; path: string }): JSX.Element {
  const tokens = useDiffTokens(diff, path)

  if (diff.binary) {
    return <div className="px-4 py-3 font-mono text-[11px] text-faint">Binary file not shown</div>
  }
  return (
    <div className="font-mono text-[11px] leading-[1.7]">
      {diff.lines.map((line, i) => {
        if (line.type === 'hunk') {
          return (
            <div key={i} className="flex bg-diff-hunk/8 text-diff-hunk">
              <span className="w-[62px] flex-none pr-3 text-right text-faint">@@</span>
              <span className="whitespace-pre">{line.text}</span>
            </div>
          )
        }
        const rowBg = line.type === 'add' ? 'bg-green/10' : line.type === 'del' ? 'bg-red/10' : ''
        const signCls =
          line.type === 'add'
            ? 'text-diff-add'
            : line.type === 'del'
              ? 'text-diff-del'
              : line.type === 'meta'
                ? 'text-faint'
                : 'text-text-3'
        const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '
        const isCode = line.type === 'add' || line.type === 'del' || line.type === 'context'
        const lineTokens = isCode && tokens ? tokens[i] : null
        return (
          <div key={i} className={`flex ${rowBg}`}>
            <span className="w-[30px] flex-none pr-1.5 text-right text-faint">{line.oldNo ?? ''}</span>
            <span className="w-[30px] flex-none pr-3 text-right text-faint">{line.newNo ?? ''}</span>
            <span className={`whitespace-pre ${signCls}`}>
              {sign}{' '}
              {lineTokens && lineTokens.length > 0 ? (
                lineTokens.map((t, j) => (
                  <span key={j} style={t.color ? { color: t.color } : undefined}>
                    {t.content}
                  </span>
                ))
              ) : (
                stripSign(line)
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
