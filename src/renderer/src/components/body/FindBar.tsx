import { useEffect, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X
} from 'lucide-react'
import { shortcutLabel } from '@renderer/lib/platform'

/**
 * The editor's find/replace widget, laid out the way VS Code's is: a chevron
 * that opens the replace row, the query box with its three toggles (case,
 * whole word, regex) inside it, the count, the step buttons and close; then,
 * when expanded, a replace box with Replace and Replace All beside it.
 *
 * It floats in the top-right of the code view, over the content rather than
 * pushing it down — the line you were reading should not move because you
 * started looking for something.
 *
 * It owns no state. The matches, the current index and the queries all live in
 * the editor, because that is what has the text and the caret; this is the
 * control surface for them.
 */

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'
const BTN = `flex size-[22px] flex-none items-center justify-center rounded-[6px] text-muted hover:bg-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted ${FOCUS}`
const INPUT = `allow-select min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-text-2 placeholder:text-faint outline-none`

export interface FindToggles {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

function Toggle({
  label,
  shortcut,
  on,
  onChange,
  children
}: {
  label: string
  shortcut: string
  on: boolean
  onChange: (next: boolean) => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={`${label} (${shortcut})`}
      onClick={() => onChange(!on)}
      className={`flex size-[20px] flex-none items-center justify-center rounded-[5px] ${
        on ? 'bg-accent/15 text-blue ring-1 ring-accent/50' : 'text-muted hover:bg-hover hover:text-text'
      } ${FOCUS}`}
    >
      {children}
    </button>
  )
}

export default function FindBar({
  query,
  onQuery,
  toggles,
  onToggles,
  error,
  count,
  index,
  focus,
  replaceOpen,
  onReplaceOpen,
  replacement,
  onReplacement,
  onStep,
  onReplace,
  onReplaceAll,
  onClose
}: {
  query: string
  onQuery: (next: string) => void
  toggles: FindToggles
  onToggles: (next: FindToggles) => void
  /** Why the query cannot be searched for (a regex that does not compile). */
  error: string | null
  /** Total matches for the current query. */
  count: number
  /** 0-based index of the current match, or -1 when there is none. */
  index: number
  /**
   * Where to put focus, bumped by each Ctrl+F (the find box) or Ctrl+H (the
   * replace box). A second press re-selects what is already in the box.
   */
  focus: { seq: number; target: 'find' | 'replace' }
  replaceOpen: boolean
  onReplaceOpen: (next: boolean) => void
  replacement: string
  onReplacement: (next: string) => void
  onStep: (forward: boolean) => void
  onReplace: () => void
  onReplaceAll: () => void
  onClose: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)

  // Select rather than merely focus: Ctrl+F on an open bar should let you type
  // a new query over the old one, which is what every other find box does.
  useEffect(() => {
    const box = focus.target === 'replace' ? (replaceRef.current ?? inputRef.current) : inputRef.current
    box?.focus()
    box?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.seq])

  // Shared by both boxes: the toggles' Alt shortcuts, Escape, and Ctrl+Alt+Enter
  // for Replace All all mean the same thing wherever focus is in the widget.
  const commonKeys = (event: KeyboardEvent): boolean => {
    if (event.key === 'Escape') {
      onClose()
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyC') {
      onToggles({ ...toggles, caseSensitive: !toggles.caseSensitive })
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyW') {
      onToggles({ ...toggles, wholeWord: !toggles.wholeWord })
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyR') {
      onToggles({ ...toggles, regex: !toggles.regex })
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.altKey) {
      onReplaceAll()
    } else {
      return false
    }
    event.preventDefault()
    return true
  }

  const onFindKeyDown = (event: KeyboardEvent): void => {
    if (commonKeys(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onStep(!event.shiftKey)
    }
  }

  const onReplaceKeyDown = (event: KeyboardEvent): void => {
    if (commonKeys(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onReplace()
    }
  }

  const status = !query ? '' : error ? 'invalid' : count === 0 ? 'no results' : `${index + 1} of ${count}`

  return (
    <div
      // Stops a click on the bar reaching the editor's own handlers, and keeps
      // the context menu from opening over the controls.
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      data-testid="find-widget"
      className="absolute right-3 top-2 z-20 flex items-start gap-1 rounded-[9px] border border-line-strong bg-elev py-1 pl-1 pr-1.5 elev-menu"
    >
      <button
        type="button"
        aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
        aria-expanded={replaceOpen}
        title={shortcutLabel('Toggle replace (Ctrl+H)')}
        onClick={() => onReplaceOpen(!replaceOpen)}
        className={`flex h-[22px] w-[16px] flex-none items-center justify-center self-stretch rounded-[5px] text-muted hover:bg-hover hover:text-text ${FOCUS}`}
      >
        {replaceOpen ? <ChevronDown size={13} strokeWidth={1.5} /> : <ChevronRight size={13} strokeWidth={1.5} />}
      </button>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <div
            title={error ?? undefined}
            className={`flex w-[230px] items-center gap-0.5 rounded-[6px] border bg-pane py-[1px] pl-1.5 pr-[2px] focus-within:border-accent/60 ${
              error ? 'border-red/70' : 'border-line-strong'
            }`}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={onFindKeyDown}
              placeholder="Find"
              aria-label="Find in file"
              aria-invalid={error ? true : undefined}
              spellCheck={false}
              className={INPUT}
            />
            <Toggle
              label="Match case"
              shortcut="Alt+C"
              on={toggles.caseSensitive}
              onChange={(caseSensitive) => onToggles({ ...toggles, caseSensitive })}
            >
              <CaseSensitive size={14} strokeWidth={1.5} />
            </Toggle>
            <Toggle
              label="Match whole word"
              shortcut="Alt+W"
              on={toggles.wholeWord}
              onChange={(wholeWord) => onToggles({ ...toggles, wholeWord })}
            >
              <WholeWord size={14} strokeWidth={1.5} />
            </Toggle>
            <Toggle
              label="Use regular expression"
              shortcut="Alt+R"
              on={toggles.regex}
              onChange={(regex) => onToggles({ ...toggles, regex })}
            >
              <Regex size={13} strokeWidth={1.5} />
            </Toggle>
          </div>
          {/* Reserved width, so stepping through matches doesn't shuffle the
              buttons left and right as the count's digits change. */}
          <span
            aria-live="polite"
            data-testid="find-count"
            className={`w-[64px] flex-none text-right font-mono text-[10.5px] ${
              query && (count === 0 || error) ? 'text-red-2' : 'text-faint'
            }`}
          >
            {status}
          </span>
          <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={count === 0} onClick={() => onStep(false)} className={BTN}>
            <ArrowUp size={13} strokeWidth={1.5} />
          </button>
          <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={count === 0} onClick={() => onStep(true)} className={BTN}>
            <ArrowDown size={13} strokeWidth={1.5} />
          </button>
          <button type="button" aria-label="Close find" title="Close (Esc)" onClick={onClose} className={BTN}>
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
        {replaceOpen && (
          <div className="flex items-center gap-1.5">
            <div className="flex w-[230px] items-center rounded-[6px] border border-line-strong bg-pane py-[3px] pl-1.5 pr-1 focus-within:border-accent/60">
              <input
                ref={replaceRef}
                value={replacement}
                onChange={(e) => onReplacement(e.target.value)}
                onKeyDown={onReplaceKeyDown}
                placeholder="Replace"
                aria-label="Replace with"
                spellCheck={false}
                className={INPUT}
              />
            </div>
            <button type="button" aria-label="Replace" title="Replace (Enter)" disabled={count === 0} onClick={onReplace} className={BTN}>
              <Replace size={13} strokeWidth={1.5} />
            </button>
            <button type="button" aria-label="Replace all" title={shortcutLabel('Replace all (Ctrl+Alt+Enter)')} disabled={count === 0} onClick={onReplaceAll} className={BTN}>
              <ReplaceAll size={13} strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
