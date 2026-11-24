import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CollapsedPane, PaneCollapseTab } from './PaneCollapse'

afterEach(cleanup)

describe('PaneCollapseTab', () => {
  const grip = (): HTMLElement => screen.getByRole('button', { name: 'Collapse projects panel' })

  function mount(): { onCollapse: ReturnType<typeof vi.fn>; onResizeStart: ReturnType<typeof vi.fn> } {
    const onCollapse = vi.fn()
    const onResizeStart = vi.fn()
    render(<PaneCollapseTab edge="right" label="projects panel" onCollapse={onCollapse} onResizeStart={onResizeStart} />)
    return { onCollapse, onResizeStart }
  }

  it('collapses the panel on a click that stays put', () => {
    const { onCollapse, onResizeStart } = mount()
    fireEvent.mouseDown(grip(), { button: 0, clientX: 264 })
    fireEvent.click(grip(), { detail: 1, clientX: 265 })
    expect(onCollapse).toHaveBeenCalledTimes(1)
    // The press was handed to the resize handle either way: it cannot know yet which it is.
    expect(onResizeStart).toHaveBeenCalledTimes(1)
  })

  it('resizes instead when the press moves, and leaves the panel open', () => {
    const { onCollapse, onResizeStart } = mount()
    fireEvent.mouseDown(grip(), { button: 0, clientX: 264 })
    fireEvent.click(grip(), { detail: 1, clientX: 272 })
    expect(onResizeStart).toHaveBeenCalledTimes(1)
    expect(onCollapse).not.toHaveBeenCalled()
    // The drag is over: the next plain click collapses again.
    fireEvent.mouseDown(grip(), { button: 0, clientX: 272 })
    fireEvent.click(grip(), { detail: 1, clientX: 272 })
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('collapses from the keyboard, which has no press to measure', () => {
    const { onCollapse, onResizeStart } = mount()
    fireEvent.click(grip(), { detail: 0 })
    expect(onCollapse).toHaveBeenCalledTimes(1)
    expect(onResizeStart).not.toHaveBeenCalled()
  })

  it('does not start a resize from the right mouse button', () => {
    const { onResizeStart } = mount()
    fireEvent.mouseDown(grip(), { button: 2, clientX: 264 })
    expect(onResizeStart).not.toHaveBeenCalled()
  })

  it('says it can be dragged only when it can', () => {
    mount()
    expect(grip().title).toBe('Collapse projects panel · drag to resize')
    cleanup()
    render(<PaneCollapseTab edge="left" label="git & tasks panel" onCollapse={() => {}} />)
    expect(screen.getByRole('button', { name: 'Collapse git & tasks panel' }).title).toBe('Collapse git & tasks panel')
  })
})

describe('CollapsedPane', () => {
  it('reopens the panel from anywhere on the strip', () => {
    const onExpand = vi.fn()
    render(<CollapsedPane edge="right" label="projects panel" onExpand={onExpand} />)
    const strip = screen.getByRole('button', { name: 'Expand projects panel' })
    // The button is the whole strip, not just the mark in the middle of it.
    expect(strip.parentElement?.tagName).toBe('ASIDE')
    expect(strip.className).toContain('flex-1')
    fireEvent.click(strip)
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})
