import { useRef, type JSX, type KeyboardEvent } from 'react'

/**
 * A segmented control: N mutually exclusive options rendered as one pill.
 *
 * Marked up as a WAI-ARIA radio group rather than a row of `aria-pressed`
 * toggles, because that is what these controls actually are — exactly one
 * option is always active, and picking one un-picks the others. Toggle buttons
 * would announce three unrelated on/off states with no "1 of 3" relationship,
 * and the View menu already models the very same theme choice with
 * `menuitemradio`; using different semantics for the same choice in two places
 * is the kind of drift this component exists to prevent.
 *
 * The radio role is not free though: it promises a keyboard contract that plain
 * buttons do not provide, and a half-kept promise is worse for assistive tech
 * than no roles at all. So the whole contract is implemented here, once:
 *
 *  - **One tab stop.** Tab enters and leaves the group; only the checked option
 *    is tabbable (roving `tabIndex`), so a keyboard user does not have to step
 *    through every option to get past the control.
 *  - **Arrows move and select.** Left/Up go back, Right/Down go forward, both
 *    wrapping; Home/End jump to the ends. Selection follows focus, which is the
 *    APG's "radio group with automatic selection" — appropriate here because
 *    selecting is cheap and instantly previewable (the theme applies live).
 *  - **Space/Enter** still select, for free, because each option is a `button`.
 */

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

/**
 * The option index a radio-group navigation key moves to, or `null` when the
 * key is not one this pattern owns (so the event is left alone to bubble).
 *
 * Split out as a pure function so the keyboard contract can be unit-tested
 * directly — every wrap-around and edge case — instead of only through
 * simulated DOM events on one particular control.
 */
export function nextSegmentIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    // Both axes are bound: the control is laid out horizontally, but the APG
    // asks radio groups to accept the vertical arrows too, and a screen-reader
    // user has no way to know which way this particular group is drawn.
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  fill = false,
  className = ''
}: {
  /** Group label for assistive tech — there is no visible <legend>. */
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Stretch the options to share the width evenly (long labels). */
  fill?: boolean
  /** Extra classes for the group container, e.g. layout margins. */
  className?: string
}): JSX.Element {
  // Arrowing has to move DOM focus itself, so the option elements are kept by
  // value. Cleared on unmount-per-option so a changed option list can't pin a
  // detached node.
  const nodes = useRef(new Map<T, HTMLButtonElement>())

  // The checked option owns the tab stop. If `value` matches nothing (a stale
  // persisted setting, say) fall back to the first option, otherwise the group
  // would have no tabbable element at all and become keyboard-unreachable.
  const checkedIndex = options.findIndex((o) => o.value === value)
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = nextSegmentIndex(event.key, tabStop, options.length)
    if (index === null) return
    // Claim the key so Up/Down don't also scroll the surrounding modal.
    event.preventDefault()
    const next = options[index]
    onChange(next.value)
    // Focus the new option now rather than after the re-render: the DOM node
    // already exists, and moving focus is what makes "selection follows focus"
    // legible to a screen reader.
    nodes.current.get(next.value)?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex items-center rounded-[7px] border border-line-2 bg-bg p-[2px] ${className}`}
    >
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={i === tabStop ? 0 : -1}
          ref={(el) => {
            if (el) nodes.current.set(option.value, el)
            else nodes.current.delete(option.value)
          }}
          onClick={() => onChange(option.value)}
          onKeyDown={onKeyDown}
          className={`${fill ? 'flex-1 ' : ''}rounded-[5px] px-2.5 py-[3px] text-[11px] font-semibold ${
            option.value === value ? 'bg-accent/15 text-blue' : 'text-muted hover:text-text-2'
          } focus-visible:ring-2 focus-visible:ring-accent/60 outline-none`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
