import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, CaseSensitive, X } from 'lucide-react'

/**
 * The editor's find bar: a floating strip in the top-right of the code view,
 * over the content rather than pushing it down — the line you were reading
 * should not move because you started looking for something.
 *
 * It owns no state. The matches, the current index and the query all live in
 * the editor, because that is what has the text and the caret; this is the
 * control surface for them.
 */

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'
const BTN = `flex size-[22px] flex-none items-center justify-center rounded-[6px] text-muted hover:bg-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted ${FOCUS}`

export default function FindBar({
  query,
  onQuery,
  caseSensitive,
  onCaseSensitive,
  count,
  index,
  focusSeq,
  onStep,
  onClose
}: {
  query: string
  onQuery: (next: string) => void
  caseSensitive: boolean
  onCaseSensitive: (next: boolean) => void
  /** Total matches for the current query. */
  count: number
  /** 0-based index of the current match, or -1 when there is none. */
  index: number
  /** Bumped to pull focus back to the input — a second Ctrl+F re-selects it. */
  focusSeq: number
  onStep: (forward: boolean) => void
  onClose: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  // Select rather than merely focus: Ctrl+F on an open bar should let you type
  // a new query over the old one, which is what every other find box does.
  useEffect(() => {
    inputRef.current?.select()
  }, [focusSeq])

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onStep(!event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div
      // Stops a click on the bar reaching the editor's own handlers, and keeps
      // the context menu from opening over the controls.
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="absolute right-3 top-2 z-20 flex items-center gap-1.5 rounded-[9px] border border-line-strong bg-elev py-1 pl-2 pr-1.5 elev-menu"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find"
        aria-label="Find in file"
        spellCheck={false}
        className={`allow-select w-[150px] bg-transparent font-mono text-[11.5px] text-text-2 placeholder:text-faint ${FOCUS}`}
      />
      {/* Reserved width, so stepping through matches doesn't shuffle the
          buttons left and right as the count's digits change. */}
      <span
        aria-live="polite"
        className={`w-[64px] flex-none text-right font-mono text-[10.5px] ${
          query && count === 0 ? 'text-red-2' : 'text-faint'
        }`}
      >
        {!query ? '' : count === 0 ? 'no results' : `${index + 1} of ${count}`}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={caseSensitive}
        aria-label="Match case"
        title="Match case"
        onClick={() => onCaseSensitive(!caseSensitive)}
        className={`flex size-[22px] flex-none items-center justify-center rounded-[6px] ${
          caseSensitive ? 'bg-accent/15 text-blue' : 'text-muted hover:bg-hover hover:text-text'
        } ${FOCUS}`}
      >
        <CaseSensitive size={14} strokeWidth={1.5} />
      </button>
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
  )
}
