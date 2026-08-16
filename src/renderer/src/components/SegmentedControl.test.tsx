import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SegmentedControl, nextSegmentIndex, type SegmentedOption } from './SegmentedControl'

/**
 * These tests pin the ARIA contract the radio roles promise. Declaring
 * role="radiogroup"/role="radio" without the keyboard behaviour is worse than
 * using plain buttons, so the behaviour is what gets tested — not the classes.
 */

type Fruit = 'apple' | 'pear' | 'plum'

const OPTIONS: readonly SegmentedOption<Fruit>[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'pear', label: 'Pear' },
  { value: 'plum', label: 'Plum' }
]

/** Live wrapper: the control is controlled, so a test needs something to hold state. */
function Harness({ initial = 'apple', onChange }: { initial?: Fruit; onChange?: (v: Fruit) => void }): JSX.Element {
  const [value, setValue] = useState<Fruit>(initial)
  return (
    <SegmentedControl
      label="Fruit"
      options={OPTIONS}
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
    />
  )
}

const radios = (): HTMLElement[] => screen.getAllByRole('radio')
const checkedLabels = (): string[] =>
  radios()
    .filter((r) => r.getAttribute('aria-checked') === 'true')
    .map((r) => r.textContent ?? '')
/** The single element Tab can reach — the whole point of a roving tabIndex. */
const tabStops = (): string[] => radios().filter((r) => r.tabIndex === 0).map((r) => r.textContent ?? '')

afterEach(cleanup)

describe('nextSegmentIndex', () => {
  it('moves forward on Right/Down and wraps past the end', () => {
    expect(nextSegmentIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextSegmentIndex('ArrowDown', 1, 3)).toBe(2)
    expect(nextSegmentIndex('ArrowRight', 2, 3)).toBe(0)
  })

  it('moves backward on Left/Up and wraps past the start', () => {
    expect(nextSegmentIndex('ArrowLeft', 2, 3)).toBe(1)
    expect(nextSegmentIndex('ArrowUp', 1, 3)).toBe(0)
    // The wrap is the case a naive `current - 1` gets wrong: -1 is a valid array
    // index for nothing, and would silently select undefined.
    expect(nextSegmentIndex('ArrowLeft', 0, 3)).toBe(2)
  })

  it('jumps to the ends on Home/End', () => {
    expect(nextSegmentIndex('Home', 2, 3)).toBe(0)
    expect(nextSegmentIndex('End', 0, 3)).toBe(2)
  })

  it('declines keys it does not own, so they can bubble', () => {
    // Escape in particular must reach the modal that closes on it.
    for (const key of ['Escape', 'Enter', ' ', 'Tab', 'a', 'PageDown']) {
      expect(nextSegmentIndex(key, 0, 3)).toBeNull()
    }
  })

  it('declines everything for an empty group rather than dividing by zero', () => {
    expect(nextSegmentIndex('ArrowRight', 0, 0)).toBeNull()
    expect(nextSegmentIndex('Home', 0, 0)).toBeNull()
  })
})

describe('SegmentedControl', () => {
  it('exposes the options as a labelled radio group', () => {
    render(<Harness initial="pear" />)

    expect(screen.getByRole('radiogroup', { name: 'Fruit' })).toBeTruthy()
    expect(radios().map((r) => r.textContent)).toEqual(['Apple', 'Pear', 'Plum'])
    expect(checkedLabels()).toEqual(['Pear'])
  })

  it('is a single tab stop, held by the checked option', () => {
    render(<Harness initial="plum" />)

    expect(tabStops()).toEqual(['Plum'])
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0])
  })

  it('keeps the tab stop reachable when the value matches no option', () => {
    // A stale persisted setting must not leave the group keyboard-unreachable.
    render(<SegmentedControl label="Fruit" options={OPTIONS} value={'quince' as Fruit} onChange={() => {}} />)

    expect(checkedLabels()).toEqual([])
    expect(tabStops()).toEqual(['Apple'])
  })

  it('selects and focuses the next option on ArrowRight, wrapping at the end', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.keyDown(radios()[0], { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('pear')
    expect(checkedLabels()).toEqual(['Pear'])
    // Selection follows focus: arrowing that left focus behind would strand a
    // keyboard user on an option that is no longer the selected one.
    expect(document.activeElement?.textContent).toBe('Pear')
    expect(tabStops()).toEqual(['Pear'])

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(checkedLabels()).toEqual(['Apple'])
    expect(document.activeElement?.textContent).toBe('Apple')
  })

  it('selects and focuses the previous option on ArrowLeft, wrapping at the start', () => {
    render(<Harness />)

    fireEvent.keyDown(radios()[0], { key: 'ArrowLeft' })
    expect(checkedLabels()).toEqual(['Plum'])
    expect(document.activeElement?.textContent).toBe('Plum')
  })

  it('accepts the vertical arrows too', () => {
    // The group is drawn horizontally, but a screen-reader user has no way to
    // know that, so the APG asks for both axes.
    render(<Harness initial="pear" />)

    fireEvent.keyDown(radios()[1], { key: 'ArrowDown' })
    expect(checkedLabels()).toEqual(['Plum'])

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(checkedLabels()).toEqual(['Pear'])
  })

  it('jumps to the first and last option on Home/End', () => {
    render(<Harness initial="pear" />)

    fireEvent.keyDown(radios()[1], { key: 'End' })
    expect(checkedLabels()).toEqual(['Plum'])
    expect(document.activeElement?.textContent).toBe('Plum')

    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(checkedLabels()).toEqual(['Apple'])
    expect(document.activeElement?.textContent).toBe('Apple')
  })

  it('claims the arrow keys so they cannot also scroll the surrounding modal', () => {
    render(<Harness />)

    expect(fireEvent.keyDown(radios()[0], { key: 'ArrowDown' })).toBe(false) // preventDefault()ed
    // Keys the pattern does not own stay unclaimed, so Escape still closes the modal.
    expect(fireEvent.keyDown(radios()[0], { key: 'Escape' })).toBe(true)
  })

  it('still selects on click', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Plum' }))
    expect(onChange).toHaveBeenCalledWith('plum')
    expect(checkedLabels()).toEqual(['Plum'])
  })

  it('does not report a pressed state — these are radios, not toggles', () => {
    // Carrying both would leave assistive tech announcing two different models
    // of the same control.
    render(<Harness />)
    expect(radios().every((r) => r.getAttribute('aria-pressed') === null)).toBe(true)
  })
})
