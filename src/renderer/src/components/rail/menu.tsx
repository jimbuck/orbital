import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'

/**
 * Shared right-click context-menu primitives (rail WorktreeRow/Project rows,
 * task cards and the editor file tree): a dismiss overlay + positioned surface,
 * a menu row, a destructive-action confirm block, and a single-line text prompt
 * — the latter two swap in place of the menu items rather than opening a
 * separate dialog, so a right-click never spawns a second surface to aim at.
 */

export type MenuPos = { x: number; y: number }

/** Clamp a context-menu origin so the surface stays inside the window. */
export function clampMenuPos(e: React.MouseEvent, width: number, height: number): MenuPos {
  return { x: Math.min(e.clientX, window.innerWidth - width - 12), y: Math.min(e.clientY, window.innerHeight - height) }
}

/** Full-screen dismiss overlay + fixed, elevated menu surface. */
export function ContextMenu({
  pos,
  width,
  onClose,
  children
}: {
  pos: MenuPos
  width: number
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        role="menu"
        style={{ left: pos.x, top: pos.y, width }}
        className="fixed z-50 rounded-[9px] border border-line-strong bg-elev p-1 shadow-[0_14px_36px_rgba(0,0,0,0.55)]"
      >
        {children}
      </div>
    </>
  )
}

export function MenuItem({
  icon,
  label,
  hint,
  danger,
  onClick
}: {
  icon: ReactNode
  label: string
  hint?: string
  danger?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] font-semibold outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60 ${
        danger ? 'text-red-2' : 'text-text-2'
      }`}
    >
      <span className={`flex-none ${danger ? 'text-red-2' : 'text-muted'}`}>{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[10px] font-normal text-faint">{hint}</span>}
    </button>
  )
}

/**
 * In-menu confirm step for a destructive action: message (+ hint) and Confirm /
 * Cancel. Pass `busy` while the confirmed action is running to lock both buttons
 * (and swap the confirm label for `busyLabel` + a spinner) so a slow action
 * can't be fired twice or cancelled halfway.
 */
export function MenuConfirm({
  message,
  hint,
  confirmLabel,
  danger = true,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel
}: {
  message: string
  hint?: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  busyLabel?: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <div className="p-1">
      <div className={`px-1 py-1 text-[11.5px] leading-snug ${danger ? 'text-red-2' : 'text-text-3'}`}>{message}</div>
      {hint && <div className="px-1 pb-1 text-[11px] text-dim">{hint}</div>}
      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-red/15 px-2 py-1.5 text-[11.5px] font-semibold text-red-2 outline-none hover:bg-red/25 focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-red/15"
        >
          {busy && (
            <span className="inline-block size-[10px] flex-none animate-spin rounded-full border-[1.5px] border-red-2 border-t-transparent" />
          )}
          {busy ? busyLabel || 'Working…' : confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="flex-1 rounded-md bg-hover px-2 py-1.5 text-[11.5px] font-semibold text-text-2 outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * In-menu single-line prompt (New File…, Rename…): a labelled text field that
 * swaps in place of the menu items, mirroring {@link MenuConfirm}. It exists
 * because the alternatives are both worse — `window.prompt` is a blocking
 * native dialog Electron renders inconsistently, and a real modal pulls focus
 * away from the row the user just aimed at.
 *
 * `error` is rendered under the field and the prompt STAYS OPEN when it is set,
 * so a rejected name (already exists, contains a separator) can be corrected in
 * place instead of forcing the user to re-open the menu and retype.
 */
export function MenuPrompt({
  label,
  initial = '',
  placeholder,
  confirmLabel,
  busy = false,
  error,
  onSubmit,
  onCancel
}: {
  label: string
  initial?: string
  placeholder?: string
  confirmLabel: string
  busy?: boolean
  error?: string | null
  onSubmit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  // The menu opens at the pointer with nothing else focused, so the field takes
  // focus itself; selecting the seed text makes Rename a type-over.
  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const submit = (): void => {
    if (busy) return
    onSubmit(value)
  }

  return (
    <div className="p-1">
      <div className="px-1 pb-1 text-[11.5px] font-semibold text-text-2">{label}</div>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        aria-label={label}
        className="allow-select w-full rounded border border-line-strong bg-bg px-1.5 py-1 font-mono text-[11.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
      />
      {error && <div className="px-1 pt-1 text-[11px] leading-snug text-red-2">{error}</div>}
      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          disabled={busy || value.trim() === ''}
          onClick={submit}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent/15 px-2 py-1.5 text-[11.5px] font-semibold text-blue outline-none hover:bg-accent/25 focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-accent/15"
        >
          {busy && (
            <span className="inline-block size-[10px] flex-none animate-spin rounded-full border-[1.5px] border-blue border-t-transparent" />
          )}
          {confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="flex-1 rounded-md bg-hover px-2 py-1.5 text-[11.5px] font-semibold text-text-2 outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
