/**
 * Focus-aware copy / paste / select-all shared by the Edit menu and the terminal
 * right-click. A terminal (xterm) renders its selection on a canvas, so the
 * browser's native copy can't see it — each live terminal registers imperative
 * handlers here keyed by its container element. The actions below then dispatch
 * to the focused terminal, a native input/textarea, or the DOM selection based
 * on where focus currently is.
 *
 * For this to work from the Edit menu, the menu buttons must NOT steal focus
 * (they preventDefault on mousedown), so `document.activeElement` still points at
 * the terminal/input the user was editing when the menu item fires.
 */

export interface TerminalEditHandlers {
  copy: () => void
  paste: () => void
  selectAll: () => void
}

const terminals = new Map<HTMLElement, TerminalEditHandlers>()

/** Register a live terminal's edit handlers; returns an unregister fn for cleanup. */
export function registerTerminal(el: HTMLElement, handlers: TerminalEditHandlers): () => void {
  terminals.set(el, handlers)
  return () => {
    terminals.delete(el)
  }
}

/** The terminal whose DOM subtree currently holds focus, if any. */
function focusedTerminal(): TerminalEditHandlers | null {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return null
  for (const [node, handlers] of terminals) {
    if (node.contains(el)) return handlers
  }
  return null
}

/** The focused element if it's a natively-editable input/textarea. */
function focusedInput(): HTMLInputElement | HTMLTextAreaElement | null {
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el
  return null
}

export function editCopy(): void {
  const term = focusedTerminal()
  if (term) {
    term.copy()
    return
  }
  const input = focusedInput()
  if (input && input.selectionStart != null && input.selectionEnd != null) {
    const text = input.value.slice(input.selectionStart, input.selectionEnd)
    if (text) window.orbital.writeClipboard(text)
    return
  }
  const sel = window.getSelection()?.toString()
  if (sel) window.orbital.writeClipboard(sel)
}

export function editPaste(): void {
  const term = focusedTerminal()
  if (term) {
    term.paste()
    return
  }
  const input = focusedInput()
  if (input) {
    const text = window.orbital.readClipboard()
    // insertText replaces the current selection and fires an input event, so
    // React-controlled inputs observe the change (unlike setting .value directly).
    if (text) document.execCommand('insertText', false, text)
  }
}

export function editSelectAll(): void {
  const term = focusedTerminal()
  if (term) {
    term.selectAll()
    return
  }
  const input = focusedInput()
  if (input) {
    input.select()
    return
  }
  const el = document.activeElement
  if (el instanceof HTMLElement) {
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
}
