import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MenuPrompt, clampMenuPos } from './menu'

afterEach(() => {
  cleanup()
})

describe('clampMenuPos', () => {
  /** A synthetic-looking mouse event carrying only what the clamp reads. */
  const at = (clientX: number, clientY: number): React.MouseEvent =>
    ({ clientX, clientY }) as unknown as React.MouseEvent

  it('opens at the pointer when the surface fits', () => {
    // jsdom's window is 1024x768.
    expect(clampMenuPos(at(100, 200), 216, 340)).toEqual({ x: 100, y: 200 })
  })

  it('pulls a menu that would overflow the right edge back inside, with a margin', () => {
    expect(clampMenuPos(at(1000, 200), 216, 340)).toEqual({ x: 1024 - 216 - 12, y: 200 })
  })

  it('pulls a menu that would overflow the bottom edge up to fit', () => {
    expect(clampMenuPos(at(100, 700), 216, 340)).toEqual({ x: 100, y: 768 - 340 })
  })
})

describe('MenuPrompt', () => {
  function mount(props: Partial<Parameters<typeof MenuPrompt>[0]> = {}): {
    input: HTMLInputElement
    onSubmit: ReturnType<typeof vi.fn>
    onCancel: ReturnType<typeof vi.fn>
  } {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(<MenuPrompt label="Rename file" confirmLabel="Rename" onSubmit={onSubmit} onCancel={onCancel} {...props} />)
    return { input: screen.getByRole('textbox', { name: 'Rename file' }) as HTMLInputElement, onSubmit, onCancel }
  }

  it('seeds the field with the initial value, selected for type-over', () => {
    // Selection only: in a browser `select()` also focuses the field, which
    // jsdom does not model, so focus is not asserted here.
    const { input } = mount({ initial: 'a.ts' })
    expect(input.value).toBe('a.ts')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(4)
  })

  it('submits the typed value on Enter and on the confirm button', () => {
    const { input, onSubmit } = mount({ initial: 'a.ts' })
    fireEvent.change(input, { target: { value: 'b.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onSubmit.mock.calls).toEqual([['b.ts'], ['b.ts']])
  })

  it('cancels on Escape without submitting', () => {
    const { input, onSubmit, onCancel } = mount({ initial: 'a.ts' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables the confirm button while the field is blank', () => {
    const { input } = mount()
    const confirm = screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'x' } })
    expect(confirm.disabled).toBe(false)
  })

  it('ignores Enter and locks the field and buttons while busy', () => {
    const { input, onSubmit, onCancel } = mount({ initial: 'a.ts', busy: true })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(input.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('shows the error under the field and keeps the value for correction', () => {
    const { input } = mount({ initial: 'b.ts', error: '"src/b.ts" already exists' })
    expect(screen.getByText('"src/b.ts" already exists')).toBeTruthy()
    expect(input.value).toBe('b.ts')
  })
})
