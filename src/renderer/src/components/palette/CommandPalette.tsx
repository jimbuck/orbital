import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Check, FileText, GitBranch, Hash, Search, TextSearch } from 'lucide-react'
import type { FileSearchHit, SearchQuery, Worktree } from '@shared/types'
import { fuzzyMatch, fuzzyMatchPath } from '@shared/fuzzy'
import { useStore } from '@renderer/store'
import { taskStatusLabel } from '@renderer/lib/status'
import { openFileInEditor, openTab } from '@renderer/lib/openTab'
import { useContentSearch } from '@renderer/lib/useContentSearch'
import { fireAndForget } from '@renderer/lib/bridge'
import { Marked, positionsToRanges } from '../Marked'
import { buildCommands, type IconType } from './commands'

/**
 * The command palette — one place to reach Orbital's features by typing.
 *
 * Four views, picked by a prefix the way editors do it, so the shape is already
 * familiar and the whole thing is discoverable from the footer:
 *
 *   (none)  everything: files, commands, Worktrees and tasks together
 *   >       commands only
 *   /       text inside files, in the active Worktree
 *   @       Worktrees (switch which one the cockpit is showing)
 *   #       tasks
 *
 * Content search sits behind its own prefix rather than joining the mixed view.
 * It costs a grep per checkout per keystroke, and its hits are numerous enough
 * to bury the file names and commands that view exists to surface. The peek
 * here answers "where is this called" without leaving the keyboard; anything
 * more is a working set, and the last row hands it to a Search tab.
 *
 * File search spans EVERY Worktree in the workspace, not just the active one —
 * running several checkouts side by side is the whole point of the cockpit, and
 * "which copy of config.ts" is the question a result row has to answer. So each
 * file row carries the project and Worktree it came from, in one small chip
 * rather than a second line per result.
 */

/** Per-section caps in the mixed view, so one kind cannot crowd out the rest. */
const MIXED_CAPS = { commands: 5, worktrees: 4, tasks: 4, files: 12 }

/** How long the palette waits after a keystroke before asking main for files. */
const SEARCH_DEBOUNCE_MS = 90

type Mode = 'mixed' | 'commands' | 'text' | 'goto' | 'tasks'

interface Row {
  key: string
  group: string
  Icon: IconType
  label: string
  /** `[start, end)` spans of `label` the query matched, for highlighting. */
  ranges?: [number, number][]
  /** Dim text after the label — a path, a branch, a status, a keyboard hint. */
  detail?: string
  /** Render `detail` as mono type (it is a path or a ref, not prose). */
  mono?: boolean
  /**
   * The label is a line of source, not a name: it takes the row's width and is
   * set in mono, with the file and line demoted to the trailing detail. The
   * other rows do the opposite, because there the name is what you are reading.
   */
  code?: boolean
  /** Right-aligned chip: which project and Worktree a hit belongs to. */
  meta?: string
  /** Renders a selected-state check gutter (theme, default open action). */
  checked?: boolean
  run: () => void
  /** Leave the palette open after running — the rows that switch view. */
  keepOpen?: boolean
  /** Fuzzy score, for ranking within a section. */
  score: number
}

/** The view a query asks for, and the text left after its prefix. */
export function parseQuery(query: string): { mode: Mode; term: string } {
  if (query.startsWith('>')) return { mode: 'commands', term: query.slice(1).trim() }
  // Text search is NOT trimmed: trailing whitespace is a legitimate thing to
  // search code for, and the caller gates on length rather than emptiness.
  if (query.startsWith('/')) return { mode: 'text', term: query.slice(1) }
  if (query.startsWith('@')) return { mode: 'goto', term: query.slice(1).trim() }
  if (query.startsWith('#')) return { mode: 'tasks', term: query.slice(1).trim() }
  return { mode: 'mixed', term: query.trim() }
}

export default function CommandPalette(): JSX.Element | null {
  const palette = useStore((s) => s.palette)
  const closePalette = useStore((s) => s.closePalette)
  const worktrees = useStore((s) => s.worktrees)
  const projects = useStore((s) => s.projects)
  const tasks = useStore((s) => s.tasks)
  const settings = useStore((s) => s.settings)
  const devServers = useStore((s) => s.devServers)
  const zoomFactor = useStore((s) => s.zoomFactor)
  const activeWorktreeId = useStore((s) => s.activeWorktreeId)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const setActiveWorktree = useStore((s) => s.setActiveWorktree)
  const openModal = useStore((s) => s.openModal)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [files, setFiles] = useState<FileSearchHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Whatever had focus when the palette opened. The Edit commands (Copy, Paste,
  // Select All) act on the focused element, so focus has to be handed back
  // BEFORE the command runs, not whenever React next gets around to it.
  const restoreRef = useRef<HTMLElement | null>(null)

  const open = palette !== null
  const seq = palette?.seq ?? 0
  const seedQuery = palette?.query

  // Seed (or re-seed) from the request that opened it: pressing Ctrl+Shift+P
  // while the file view is up switches it to commands rather than doing nothing.
  useEffect(() => {
    if (seedQuery === undefined) return
    setQuery(seedQuery)
    setSelected(0)
  }, [seq, seedQuery])

  useEffect(() => {
    if (!open) {
      restoreRef.current = null
      return
    }
    const previous = document.activeElement
    restoreRef.current = previous instanceof HTMLElement ? previous : null
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, seq])

  const { mode, term } = useMemo(() => parseQuery(query), [query])

  /* ---- File search (runs in main, debounced) ---------------------------- */
  useEffect(() => {
    if (!open || mode !== 'mixed' || !term) {
      setFiles([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      window.orbital
        .searchFiles(term, MIXED_CAPS.files * 2)
        .then((hits) => {
          if (live) setFiles(hits)
        })
        .catch(() => {
          // Main logs the failure; an empty Files section is the honest result.
          if (live) setFiles([])
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, mode, term])

  /* ---- Content search (the `/` view) ------------------------------------- */

  // Scoped to the active Worktree, unlike file search. A global content search
  // returns pages of hits from checkouts the user was not thinking about, and
  // costs a grep in each of them on every keystroke. The Search tab is where
  // you widen the scope, and its control says so in words.
  const contentQuery = useMemo<SearchQuery | null>(
    () =>
      open && mode === 'text' && activeWorktreeId
        ? { query: term, scope: 'worktree', worktreeId: activeWorktreeId, limit: 12 }
        : null,
    [open, mode, term, activeWorktreeId]
  )
  const { results: content, searching } = useContentSearch('palette', contentQuery)

  /* ---- Row assembly ------------------------------------------------------ */

  const projectName = useCallback(
    (id: string): string => projects.find((p) => p.id === id)?.name ?? 'unknown project',
    [projects]
  )

  /** `project › worktree` — the one line that says which checkout a hit is in. */
  const originOf = useCallback(
    (worktree: Worktree | undefined): string =>
      worktree ? `${projectName(worktree.projectId)} › ${worktree.name}` : 'unknown Worktree',
    [projectName]
  )

  const commandRows = useMemo((): Row[] => {
    if (!open) return []
    const rows: Row[] = []
    for (const c of buildCommands({ setQuery })) {
      let ranges: [number, number][] | undefined
      let score = 0
      if (term) {
        const onLabel = fuzzyMatch(term, c.label)
        if (onLabel) {
          ranges = positionsToRanges(onLabel.positions)
          score = onLabel.score
        } else {
          // Synonyms rescue a command the label alone would miss ("preferences"
          // → Settings). They rank below any real label match and highlight
          // nothing, because nothing visible in the row was matched.
          const onKeywords = c.keywords ? fuzzyMatch(term, `${c.label} ${c.keywords}`) : null
          if (!onKeywords) continue
          score = Math.max(1, onKeywords.score - 20)
        }
      }
      rows.push({
        key: `cmd:${c.id}`,
        group: c.group,
        Icon: c.icon,
        label: c.label,
        ranges,
        detail: c.hint,
        checked: c.checked,
        run: c.run,
        keepOpen: c.keepOpen,
        score
      })
    }
    return rows
    // buildCommands reads the store snapshot itself rather than taking a dozen
    // slices as arguments, so the lint rule cannot see that these are exactly
    // the values it depends on — dropping them would leave a stale command list
    // behind a state change (an agent profile added, a dev server registered).
    // Subscribing to each slice, rather than to the whole store, is what keeps
    // this component from re-rendering on every terminal status flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seq, term, worktrees, projects, tasks, settings, devServers, zoomFactor, activeWorktreeId, activeProjectId])

  const worktreeRows = useMemo((): Row[] => {
    const rows: Row[] = []
    for (const w of worktrees) {
      const m = term ? fuzzyMatch(term, `${originOf(w)} ${w.branch}`) : { score: 0, positions: [] }
      if (!m) continue
      rows.push({
        key: `wt:${w.id}`,
        group: 'Go to',
        Icon: GitBranch,
        label: w.name,
        detail: w.branch,
        mono: true,
        meta: projectName(w.projectId),
        run: () => setActiveWorktree(w.id),
        score: m.score
      })
    }
    return rows.sort((a, b) => b.score - a.score)
  }, [worktrees, term, originOf, projectName, setActiveWorktree])

  const taskRows = useMemo((): Row[] => {
    const rows: Row[] = []
    for (const t of tasks) {
      const label = `#${t.seq} ${t.title}`
      const m = term ? fuzzyMatch(term, `${label} ${t.tags.join(' ')}`) : { score: 0, positions: [] }
      if (!m) continue
      rows.push({
        key: `task:${t.id}`,
        group: 'Tasks',
        Icon: Hash,
        label,
        ranges: term ? positionsToRanges(m.positions.filter((p) => p < label.length)) : undefined,
        detail: taskStatusLabel(t.status),
        meta: projectName(t.projectId),
        run: () => openModal('editTask', { task: t }),
        score: m.score
      })
    }
    // Tie-break on recency: a task filed a minute ago is likelier to be the one
    // being looked for than one from last month.
    return rows.sort((a, b) => b.score - a.score)
  }, [tasks, term, projectName, openModal])

  const fileRows = useMemo((): Row[] => {
    const byId = new Map(worktrees.map((w) => [w.id, w]))
    return files.map((hit): Row => {
      const cut = hit.path.lastIndexOf('/')
      const name = cut === -1 ? hit.path : hit.path.slice(cut + 1)
      const dir = cut === -1 ? '' : hit.path.slice(0, cut)
      const m = fuzzyMatchPath(term, hit.path)
      // Highlight only what landed inside the file name; a match that reached
      // into the directory still ranks by it, it just isn't painted.
      const positions = m?.positions.filter((p) => p > cut).map((p) => p - cut - 1)
      return {
        key: `file:${hit.worktreeId}:${hit.path}`,
        group: 'Files',
        Icon: FileText,
        label: name,
        ranges: positionsToRanges(positions),
        detail: dir,
        mono: true,
        meta: originOf(byId.get(hit.worktreeId)),
        run: () => openFileInEditor(hit.worktreeId, hit.path),
        score: hit.score
      }
    })
  }, [files, worktrees, term, originOf])

  const contentRows = useMemo((): Row[] => {
    const rows: Row[] = []
    for (const file of content?.files ?? []) {
      const cut = file.path.lastIndexOf('/')
      const name = cut === -1 ? file.path : file.path.slice(cut + 1)
      for (const match of file.matches) {
        rows.push({
          key: `hit:${file.path}:${match.line}`,
          group: 'In files',
          Icon: FileText,
          // The matched LINE is the label, because that is what tells you
          // whether this is the hit you wanted; the file is the supporting
          // detail, which is the opposite of the file-name view.
          label: match.clippedStart > 0 ? `… ${match.text}` : match.text,
          ranges: match.ranges.map(([a, b]): [number, number] =>
            match.clippedStart > 0 ? [a + 2, b + 2] : [a, b]
          ),
          code: true,
          detail: `${name}:${match.line}`,
          run: () => openFileInEditor(file.worktreeId, file.path, { line: match.line }),
          score: 0
        })
      }
    }
    return rows
  }, [content])

  /** The rows this view shows, in section order. */
  const rows = useMemo((): Row[] => {
    if (mode === 'commands') return [...commandRows].sort((a, b) => b.score - a.score)
    if (mode === 'goto') return worktreeRows
    if (mode === 'tasks') return taskRows
    if (mode === 'text') {
      // Always offer the hand-off, even with no hits yet: a search worth
      // widening or keeping is exactly the one the peek came up short on.
      const toTab: Row = {
        key: 'hit:open-tab',
        group: 'In files',
        Icon: TextSearch,
        label: term.trim() ? `Open all results for “${term.trim()}”` : 'Open a Search tab',
        detail: 'scope, filters and the full list',
        run: () => {
          if (!activeWorktreeId) return
          fireAndForget(
            openTab(activeWorktreeId, 'search', {
              search: { query: term, scope: 'worktree', worktreeId: activeWorktreeId }
            })
          )
        },
        score: 0
      }
      return [...contentRows, toTab]
    }
    // Mixed. With nothing typed the palette is a landing page, not a search:
    // show where you can go and how to narrow, rather than an arbitrary slice
    // of a hundred commands.
    if (!term) {
      return [
        ...commandRows.filter((r) => r.group === 'Search'),
        ...worktreeRows.slice(0, MIXED_CAPS.worktrees)
      ]
    }
    return [
      ...fileRows.slice(0, MIXED_CAPS.files),
      ...[...commandRows].sort((a, b) => b.score - a.score).slice(0, MIXED_CAPS.commands),
      ...worktreeRows.slice(0, MIXED_CAPS.worktrees),
      ...taskRows.slice(0, MIXED_CAPS.tasks)
    ]
  }, [mode, term, commandRows, worktreeRows, taskRows, fileRows, contentRows, activeWorktreeId])

  // A shrinking list must not leave the highlight past its end.
  useLayoutEffect(() => {
    setSelected((cur) => (cur >= rows.length ? Math.max(0, rows.length - 1) : cur))
  }, [rows.length])

  // Keep the highlighted row visible while arrowing through a long list.
  // scrollIntoView is optional-chained because jsdom does not implement it, and
  // a missing scroll is not worth taking the palette down over.
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, rows.length])

  if (!open) return null

  const close = (): void => {
    closePalette()
    restoreRef.current?.focus()
  }

  const execute = (row: Row): void => {
    if (row.keepOpen) {
      row.run()
      inputRef.current?.focus()
      return
    }
    // Focus goes back BEFORE the command runs: Copy / Paste / Select All act on
    // whatever the user was editing, and with the palette's own input still
    // focused they would act on that instead.
    close()
    row.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // Claim the press so ModalRoot's Escape handler doesn't ALSO pop a modal
      // the palette was opened over.
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      if (rows.length) setSelected((i) => (i + 1) % rows.length)
      return
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault()
      if (rows.length) setSelected((i) => (i - 1 + rows.length) % rows.length)
      return
    }
    if (e.key === 'Home' && rows.length) {
      e.preventDefault()
      setSelected(0)
      return
    }
    if (e.key === 'End' && rows.length) {
      e.preventDefault()
      setSelected(rows.length - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[selected]
      if (row) execute(row)
    }
  }

  const placeholder =
    mode === 'commands'
      ? 'Type a command…'
      : mode === 'text'
        ? 'Search inside files in this Worktree…'
        : mode === 'goto'
        ? 'Go to a Worktree…'
        : mode === 'tasks'
          ? 'Find a task…'
          : 'Search files, commands, Worktrees and tasks…'

  let lastGroup: string | null = null

  return (
    <div
      style={{ animation: 'overlayIn .12s ease-out' }}
      className="no-drag fixed inset-0 z-[100] flex justify-center bg-scrim px-8 pb-8 pt-[11vh]"
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{ animation: 'panelIn .16s ease-out' }}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-fit max-h-[74vh] w-[660px] max-w-[94vw] flex-col overflow-hidden rounded-modal border border-line-strong bg-panel elev-modal"
      >
        <div className="flex flex-none items-center gap-2.5 border-b border-soft px-3.5 py-3">
          <Search size={15} strokeWidth={1.5} className="flex-none text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="Command palette query"
            spellCheck={false}
            autoComplete="off"
            className="allow-select min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-faint"
          />
        </div>

        <div ref={listRef} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <div className="px-2.5 py-6 text-center text-[12px] text-faint">No matching results.</div>
          ) : (
            rows.map((row, i) => {
              const heading = row.group !== lastGroup ? row.group : null
              lastGroup = row.group
              const isSelected = i === selected
              return (
                <div key={row.key}>
                  {heading && (
                    <div className="px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.6px] text-faint">
                      {heading}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected}
                    // Selection follows the pointer, so the mouse and the arrow
                    // keys never disagree about what Enter would run.
                    onMouseMove={() => setSelected(i)}
                    onClick={() => execute(row)}
                    className={`flex w-full items-center gap-2.5 rounded-btn px-2.5 py-[7px] text-left outline-none ${
                      isSelected ? 'bg-accent/15 text-text' : 'text-text-2 hover:bg-hover'
                    }`}
                  >
                    {row.checked === undefined ? (
                      <row.Icon
                        size={14}
                        strokeWidth={1.5}
                        className={`flex-none ${isSelected ? 'text-accent' : 'text-muted'}`}
                      />
                    ) : (
                      <Check
                        size={14}
                        strokeWidth={2.5}
                        aria-hidden
                        className={`flex-none text-accent ${row.checked ? '' : 'invisible'}`}
                      />
                    )}
                    <span
                      className={
                        row.code
                          ? 'min-w-0 flex-1 truncate whitespace-pre font-mono text-[11.5px] text-text-3'
                          : 'max-w-[56%] flex-none truncate text-[12.5px] font-semibold'
                      }
                    >
                      <Marked
                        text={row.label}
                        ranges={row.ranges ?? []}
                        className={row.code ? 'rounded-[2px] bg-amber/25 font-semibold text-text' : 'font-bold text-accent'}
                      />
                    </span>
                    <span
                      className={`truncate text-[11px] text-faint ${row.code ? 'flex-none' : 'min-w-0 flex-1'} ${
                        row.mono || row.code ? 'font-mono' : ''
                      }`}
                    >
                      {row.detail ?? ''}
                    </span>
                    {row.meta && (
                      <span className="flex-none whitespace-nowrap rounded-chip bg-hover px-[7px] py-[2px] text-[10.5px] font-semibold text-dim">
                        {row.meta}
                      </span>
                    )}
                  </button>
                </div>
              )
            })
          )}
        </div>

        {/* The one place the prefixes are written down — a palette whose modes
            nobody can discover is a palette with one mode. */}
        <div className="flex flex-none items-center gap-3 border-t border-soft px-3.5 py-[7px] text-[10.5px] text-faint">
          <PrefixHint prefix=">" label="commands" active={mode === 'commands'} />
          <PrefixHint prefix="/" label="in files" active={mode === 'text'} />
          <PrefixHint prefix="@" label="worktrees" active={mode === 'goto'} />
          <PrefixHint prefix="#" label="tasks" active={mode === 'tasks'} />
          <span className="ml-auto">
            {searching ? 'Searching…' : 'Arrow keys to move · Enter to run · Esc to close'}
          </span>
        </div>
      </div>
    </div>
  )
}

function PrefixHint({ prefix, label, active }: { prefix: string; label: string; active: boolean }): JSX.Element {
  return (
    <span className={`flex items-center gap-1 ${active ? 'text-accent' : ''}`}>
      <span
        className={`rounded-[4px] border px-[5px] py-px font-mono ${
          active ? 'border-accent/40 bg-accent/10' : 'border-line-2 bg-hover'
        }`}
      >
        {prefix}
      </span>
      {label}
    </span>
  )
}
