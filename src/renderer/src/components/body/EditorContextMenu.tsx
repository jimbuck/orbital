import type { JSX } from 'react'
import { ClipboardPaste, Copy, Redo2, Scissors, TextSelect, Undo2 } from 'lucide-react'
import { ContextMenu, MenuItem, type MenuPos } from '../rail/menu'

/** The editing actions a right-click inside the code editor offers. */
export type EditorAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export const EDITOR_MENU_WIDTH = 188
/** Six rows plus two separators — the surface has one fixed shape. */
export const EDITOR_MENU_HEIGHT = 200

/**
 * Right-click context menu for the code editor's text: the standard editing
 * set (undo/redo, cut/copy/paste, select all). Distinct from
 * {@link FileContextMenu}, which is about the file as a thing in the tree —
 * this one is about the text under the pointer.
 *
 * The menu never takes focus: its buttons preventDefault on mousedown, so the
 * textarea the user right-clicked keeps both focus and its selection, and the
 * owner can dispatch each action straight at the focused element (the same
 * contract the Edit menu relies on — see lib/editActions).
 */
export default function EditorContextMenu({
  pos,
  hasSelection,
  onAction,
  onClose
}: {
  pos: MenuPos
  /** Whether the textarea had a non-empty selection when the menu opened. */
  hasSelection: boolean
  onAction: (action: EditorAction) => void
  onClose: () => void
}): JSX.Element {
  const item = (
    action: EditorAction,
    icon: JSX.Element,
    label: string,
    hint: string,
    disabled = false
  ): JSX.Element => (
    <MenuItem icon={icon} label={label} hint={hint} disabled={disabled} onClick={() => onAction(action)} />
  )

  return (
    <ContextMenu pos={pos} width={EDITOR_MENU_WIDTH} onClose={onClose}>
      <div onMouseDown={(e) => e.preventDefault()}>
        {item('undo', <Undo2 size={13} strokeWidth={1.5} />, 'Undo', 'Ctrl+Z')}
        {item('redo', <Redo2 size={13} strokeWidth={1.5} />, 'Redo', 'Ctrl+Y')}

        <div className="my-1 h-px bg-soft" />
        {item('cut', <Scissors size={13} strokeWidth={1.5} />, 'Cut', 'Ctrl+X', !hasSelection)}
        {item('copy', <Copy size={13} strokeWidth={1.5} />, 'Copy', 'Ctrl+C', !hasSelection)}
        {item('paste', <ClipboardPaste size={13} strokeWidth={1.5} />, 'Paste', 'Ctrl+V')}

        <div className="my-1 h-px bg-soft" />
        {item('selectAll', <TextSelect size={13} strokeWidth={1.5} />, 'Select All', 'Ctrl+A')}
      </div>
    </ContextMenu>
  )
}
