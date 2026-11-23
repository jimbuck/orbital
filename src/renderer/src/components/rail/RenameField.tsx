import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'

/**
 * A rail row's name as an editable field (folders, project headers). Mounted
 * only while renaming, so its draft always starts from the current name and it
 * takes focus as it appears. Enter or leaving the field commits; Escape drops
 * the edit.
 */
export default function RenameField({
  initial,
  label,
  className,
  onCommit,
  onCancel
}: {
  initial: string
  /** Its accessible name: "Folder name", "Project name". */
  label: string
  /** Type size and weight, matching the name it stands in for. */
  className: string
  onCommit: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // The row's own keys (Enter selects, arrows open) must not see the field's.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      onCommit(draft)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => onCommit(draft)}
      onClick={(e) => e.stopPropagation()}
      className={`allow-select w-full rounded border border-accent/60 bg-bg px-1 py-0.5 text-text outline-none ${className}`}
    />
  )
}
