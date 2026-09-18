import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Search, X } from 'lucide-react'
import type { SearchFileResult, SearchQuery, SearchScope, Tab } from '@shared/types'
import { SEARCH_SCOPES } from '@shared/types'
import { useStore } from '@renderer/store'
import { useContentSearch } from '@renderer/lib/useContentSearch'
import { openFileInEditor } from '@renderer/lib/openTab'
import { fireAndForget } from '@renderer/lib/bridge'
import { Marked } from '../Marked'

/**
 * The Search tab — content search across checkouts, in a pane.
 *
 * It is a tab rather than a palette view or a rail section because its results
 * are a working set, not a destination. You visit a hit, read around it, come
 * back for the next one, refine the query, come back again. An overlay that
 * dismisses on choosing is hostile to that, and the right-hand rail is both too
 * narrow for a line of code and scoped to one Worktree. A tab gets real width,
 * survives switching away, can sit beside the editor it drives, and several can
 * be open at once against different scopes.
 *
 * The query and its options persist in the tab's config, so a Search tab
 * restored after a restart comes back on the search you left it on.
 */

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/** How long after typing stops before the tab's config is written. */
const PERSIST_DEBOUNCE_MS = 1200

/** A file row plus its expanded matches, flattened for arrow-key navigation. */
interface NavRow {
  file: SearchFileResult
  matchIndex: number
}

/* Identity for collapse and dismissal. A path is unique only within its
   checkout, and a line only within its file. */
const fileKey = (f: { worktreeId: string; path: string }): string => `${f.worktreeId}:${f.path}`
const matchKey = (f: { worktreeId: string; path: string }, m: { line: number }): string =>
  `${fileKey(f)}#${m.line}`

/**
 * The mark inside an option toggle.
 *
 * Lucide has icons for these three, and they do not work together: inside the
 * same 24-unit box `case-sensitive` draws 8 units tall, `whole-word` 12 and
 * `regex` 18, so at one size the first two read as squashed next to the third.
 * Set as type on a shared baseline they simply match — and these are glyphs to
 * begin with, which is why every editor draws them as `Aa`, `ab` and `.*`.
 */
function Glyph({ children, underline }: { children: string; underline?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={`font-mono text-[11px] font-bold leading-none tracking-tight ${
        underline ? 'underline decoration-[1.5px] underline-offset-[3px]' : ''
      }`}
    >
      {children}
    </span>
  )
}

function Toggle({
  on,
  label,
  title,
  onClick,
  children
}: {
  on: boolean
  label: string
  title: string
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      onClick={onClick}
      className={`flex size-[26px] flex-none items-center justify-center rounded-[6px] border transition-colors ${FOCUS} ${
        on ? 'border-accent/40 bg-accent/15 text-accent' : 'border-transparent text-muted hover:bg-hover hover:text-text-2'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * The strike-off control on a result row. A sibling of the row rather than a
 * child of it: the row is itself a button, and a button inside a button is
 * invalid markup that browsers resolve by dropping one of them.
 */
function DismissButton({ label, onDismiss }: { label: string; onDismiss: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onDismiss()
      }}
      className={`absolute right-1 top-1/2 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-[5px] text-faint opacity-0 hover:bg-hover hover:text-text-2 focus-visible:opacity-100 group-hover:opacity-100 ${FOCUS}`}
    >
      <X size={12} strokeWidth={1.75} />
    </button>
  )
}

export default function SearchTab({ tab, active }: { tab: Tab; active: boolean }): JSX.Element {
  const worktreeId = tab.worktreeId
  const seeded = tab.config.search
  const [query, setQuery] = useState(seeded?.query ?? '')
  const [caseSensitive, setCaseSensitive] = useState(!!seeded?.caseSensitive)
  const [wholeWord, setWholeWord] = useState(!!seeded?.wholeWord)
  const [regex, setRegex] = useState(!!seeded?.regex)
  const [include, setInclude] = useState(seeded?.include ?? '')
  const [scope, setScope] = useState<SearchScope>(seeded?.scope ?? 'worktree')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Hits the user has worked through and struck off. Held here rather than
  // filtered out of `results`, so "show all" can bring them back without
  // re-running the search.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const projects = useStore((s) => s.projects)
  const worktrees = useStore((s) => s.worktrees)

  const search = useMemo<SearchQuery>(
    () => ({ query, caseSensitive, wholeWord, regex, include, scope, worktreeId }),
    [query, caseSensitive, wholeWord, regex, include, scope, worktreeId]
  )
  // The tab id is the search slot, so two Search tabs never cancel each other.
  const { results, searching } = useContentSearch(tab.id, search)

  // Persist what the tab is searching for, well behind the search itself: this
  // is a database write, and it only has to be right by the time the app closes.
  useEffect(() => {
    const timer = setTimeout(() => {
      fireAndForget(window.orbital.updateTabConfig(tab.id, { search }))
    }, PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [tab.id, search])

  // Take focus when the tab is shown, so a freshly opened Search tab is typed
  // into rather than clicked into.
  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  // A new search means new results, so nothing carries over.
  useEffect(() => setDismissed(new Set()), [search])

  const originOf = (id: string): string => {
    const w = worktrees.find((x) => x.id === id)
    if (!w) return 'unknown Worktree'
    return `${projects.find((p) => p.id === w.projectId)?.name ?? '?'} › ${w.name}`
  }

  const allFiles = useMemo(() => results?.files ?? [], [results])

  /** What is left after dismissals: struck-off matches, then emptied files. */
  const files = useMemo(
    () =>
      allFiles
        .filter((f) => !dismissed.has(fileKey(f)))
        .map((f) => ({ ...f, matches: f.matches.filter((m) => !dismissed.has(matchKey(f, m))) }))
        .filter((f) => f.matches.length > 0),
    [allFiles, dismissed]
  )

  const shownMatches = files.reduce((n, f) => n + f.matches.length, 0)
  const hiddenMatches = (results?.totalMatches ?? 0) - shownMatches
  // The origin chip only earns its space when the search actually spans more
  // than one checkout; inside a single Worktree it would repeat on every row.
  // Errors count towards that: when every checkout failed there are no files to
  // count, and "which one of them?" is precisely the question left over.
  // Computed from everything the search found, not from what is left: chips
  // appearing and disappearing as rows are struck off would be its own noise.
  const showOrigin =
    new Set([...allFiles.map((f) => f.worktreeId), ...(results?.errors ?? []).map((e) => e.worktreeId)]).size > 1

  const navRows = useMemo((): NavRow[] => {
    const rows: NavRow[] = []
    for (const file of files) {
      if (collapsed.has(fileKey(file))) continue
      file.matches.forEach((_, i) => rows.push({ file, matchIndex: i }))
    }
    return rows
  }, [files, collapsed])

  useEffect(() => {
    setSelected((cur) => (cur >= navRows.length ? Math.max(0, navRows.length - 1) : cur))
  }, [navRows.length])

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const openMatch = (file: SearchFileResult, matchIndex: number): void => {
    const match = file.matches[matchIndex]
    if (!match) return
    // Keep this pane clear: a hit that opens on top of the result list hides
    // the next one and costs a click to get back to.
    openFileInEditor(file.worktreeId, file.path, { line: match.line, avoidPaneId: tab.paneId })
  }

  const dismiss = (key: string): void => setDismissed((cur) => new Set(cur).add(key))

  const toggleFile = (file: SearchFileResult): void => {
    const key = fileKey(file)
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (navRows.length) setSelected((i) => Math.min(navRows.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (navRows.length) setSelected((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = navRows[selected]
      if (row) openMatch(row.file, row.matchIndex)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Only from the list — Backspace in the query box has to keep deleting
      // characters, which is what the target check below is guarding.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      e.preventDefault()
      const row = navRows[selected]
      if (row) dismiss(matchKey(row.file, row.file.matches[row.matchIndex]))
    }
  }

  const summary = (): string => {
    if (!results) return ''
    if (results.totalMatches === 0) return 'No results'
    if (shownMatches === 0) return 'All results dismissed'
    const m = `${shownMatches} result${shownMatches === 1 ? '' : 's'}`
    const f = `${files.length} file${files.length === 1 ? '' : 's'}`
    return `${m} in ${f}${results.truncated ? ', showing the first of many' : ''}`
  }

  let navIndex = -1

  return (
    <div className="flex h-full w-full flex-col bg-pane" onKeyDown={onKeyDown}>
      {/* Query + options */}
      <div className="flex-none border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-btn border border-line-2 bg-bg px-2.5 py-1.5 focus-within:border-accent/40">
          <Search size={14} strokeWidth={1.5} className="flex-none text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            placeholder="Search in files…"
            aria-label="Search in files"
            spellCheck={false}
            className="allow-select min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-faint"
          />
          <Toggle
            on={caseSensitive}
            label="Match case"
            title="Match case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            <Glyph>Aa</Glyph>
          </Toggle>
          <Toggle on={wholeWord} label="Whole word" title="Whole word" onClick={() => setWholeWord((v) => !v)}>
            <Glyph underline>ab</Glyph>
          </Toggle>
          <Toggle
            on={regex}
            label="Regular expression"
            title="Regular expression"
            onClick={() => setRegex((v) => !v)}
          >
            <Glyph>.*</Glyph>
          </Toggle>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <input
            value={include}
            onChange={(e) => setInclude(e.target.value)}
            placeholder="Files to include, e.g. src/**, *.ts"
            aria-label="Files to include"
            spellCheck={false}
            className="allow-select min-w-0 flex-1 rounded-btn border border-line-2 bg-bg px-2.5 py-[5px] font-mono text-[11px] text-text-3 outline-none placeholder:text-faint focus:border-accent/40"
          />
          <div className="relative flex-none">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as SearchScope)}
              aria-label="Search scope"
              className="appearance-none rounded-btn border border-line-2 bg-bg py-[5px] pl-2.5 pr-7 text-[11px] text-text-3 outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {SEARCH_SCOPES.map((s) => (
                <option key={s.value} value={s.value} className="bg-panel text-text-2">
                  {s.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={12}
              strokeWidth={1.5}
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint"
            />
          </div>
        </div>

        <div className="mt-1.5 flex min-h-[15px] items-center gap-2 text-[11px] text-dim">
          {searching ? <span className="text-faint">Searching…</span> : <span>{summary()}</span>}
          {hiddenMatches > 0 && (
            <button
              type="button"
              onClick={() => setDismissed(new Set())}
              className={`ml-auto flex-none rounded-[5px] px-1.5 py-px text-[10.5px] text-faint hover:bg-hover hover:text-text-3 ${FOCUS}`}
            >
              {hiddenMatches} dismissed · show all
            </button>
          )}
        </div>
      </div>

      {/* Per-checkout failures — a bad regex is the common one, and silence
          there reads as "no matches", which is the wrong answer entirely. */}
      {results && results.errors.length > 0 && (
        <div className="flex-none border-b border-line bg-red/10 px-3 py-2">
          {results.errors.map((err) => (
            <div key={err.worktreeId} className="flex items-start gap-2 text-[11px] text-red-2">
              <AlertTriangle size={12} strokeWidth={1.5} className="mt-px flex-none" />
              <span className="allow-select min-w-0">
                {showOrigin ? `${originOf(err.worktreeId)}: ` : ''}
                {err.message}
              </span>
            </div>
          ))}
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
        {query.trim().length < 2 ? (
          <div className="px-3 py-6 text-center text-[12px] text-faint">
            Type at least two characters to search file contents.
          </div>
        ) : files.length === 0 && !searching ? (
          <div className="px-3 py-6 text-center text-[12px] text-faint">No results.</div>
        ) : (
          files.map((file) => {
            const key = fileKey(file)
            const isCollapsed = collapsed.has(key)
            const cut = file.path.lastIndexOf('/')
            const name = cut === -1 ? file.path : file.path.slice(cut + 1)
            const dir = cut === -1 ? '' : file.path.slice(0, cut)
            return (
              <div key={key}>
                <div className="group relative">
                <button
                  type="button"
                  onClick={() => toggleFile(file)}
                  aria-expanded={!isCollapsed}
                  className={`flex w-full items-center gap-1.5 py-1 pl-2 pr-8 text-left hover:bg-hover ${FOCUS}`}
                >
                  {isCollapsed ? (
                    <ChevronRight size={13} strokeWidth={1.5} className="flex-none text-muted" />
                  ) : (
                    <ChevronDown size={13} strokeWidth={1.5} className="flex-none text-muted" />
                  )}
                  <span className="flex-none text-[12px] font-semibold text-text-2">{name}</span>
                  {dir && <span className="min-w-0 truncate font-mono text-[10.5px] text-faint">{dir}</span>}
                  <span className="ml-auto flex flex-none items-center gap-2">
                    {showOrigin && (
                      <span className="rounded-chip bg-hover px-[7px] py-[2px] text-[10px] font-semibold text-dim">
                        {originOf(file.worktreeId)}
                      </span>
                    )}
                    <span className="rounded-chip bg-hover px-[6px] py-px text-[10px] font-bold text-muted">
                      {file.matches.length}
                      {file.truncated ? '+' : ''}
                    </span>
                  </span>
                </button>
                <DismissButton label={`Dismiss all results in ${name}`} onDismiss={() => dismiss(key)} />
                </div>

                {!isCollapsed &&
                  file.matches.map((match, i) => {
                    navIndex++
                    const isSelected = navIndex === selected
                    return (
                      <div key={`${match.line}:${i}`} className="group relative">
                      <button
                        type="button"
                        data-selected={isSelected}
                        onClick={() => openMatch(file, i)}
                        className={`flex w-full items-baseline gap-2 py-[2px] pl-7 pr-8 text-left ${FOCUS} ${
                          isSelected ? 'bg-accent/15' : 'hover:bg-hover'
                        }`}
                      >
                        <span className="w-10 flex-none text-right font-mono text-[10.5px] text-faint">
                          {match.line}
                        </span>
                        <span className="min-w-0 flex-1 truncate whitespace-pre font-mono text-[11.5px] text-text-3">
                          {match.clippedStart > 0 && <span className="text-faint">… </span>}
                          <Marked
                            text={match.text}
                            ranges={match.ranges}
                            className="rounded-[2px] bg-amber/25 font-semibold text-text"
                          />
                        </span>
                      </button>
                      <DismissButton
                        label={`Dismiss ${name} line ${match.line}`}
                        onDismiss={() => dismiss(matchKey(file, match))}
                      />
                      </div>
                    )
                  })}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
