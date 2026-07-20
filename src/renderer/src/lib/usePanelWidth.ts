import { useEffect, useRef, useState } from 'react'

/**
 * Width state for a resizable side panel: clamped to [min, max], persisted to
 * localStorage, with a mouse-drag starter for the panel's resize handle. Also
 * tracks a persisted collapsed flag so the panel can be tucked away entirely.
 */
export function usePanelWidth(opts: {
  storageKey: string
  defaultWidth: number
  min: number
  max: number
  /** Which edge of the panel carries the handle ('right' for the left rail). */
  handleEdge: 'left' | 'right'
}): {
  width: number
  collapsed: boolean
  dragging: boolean
  startResize: (e: React.MouseEvent) => void
  resetWidth: () => void
  toggleCollapsed: () => void
} {
  const { storageKey, defaultWidth, min, max, handleEdge } = opts
  const collapsedKey = `${storageKey}.collapsed`
  const clamp = (v: number): number => Math.min(max, Math.max(min, v))
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved > 0 ? clamp(saved) : defaultWidth
  })
  const [collapsed, setCollapsed] = useState<boolean>(() => window.localStorage.getItem(collapsedKey) === '1')
  const [dragging, setDragging] = useState(false)

  // Detach an in-flight drag's window listeners if the panel unmounts mid-drag.
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const sign = handleEdge === 'right' ? 1 : -1
    const widthAt = (clientX: number): number => clamp(startWidth + sign * (clientX - startX))
    const move = (ev: MouseEvent): void => setWidth(widthAt(ev.clientX))
    const stop = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      setDragging(false)
      dragCleanup.current = null
    }
    const up = (ev: MouseEvent): void => {
      stop()
      const final = widthAt(ev.clientX)
      setWidth(final)
      window.localStorage.setItem(storageKey, String(final))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    // The strip is only 5px wide — pin the cursor so it survives leaving it mid-drag.
    document.body.style.cursor = 'col-resize'
    setDragging(true)
    dragCleanup.current = stop
  }

  const resetWidth = (): void => {
    setWidth(defaultWidth)
    window.localStorage.removeItem(storageKey)
  }

  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      const next = !prev
      window.localStorage.setItem(collapsedKey, next ? '1' : '0')
      return next
    })
  }

  return { width, collapsed, dragging, startResize, resetWidth, toggleCollapsed }
}
