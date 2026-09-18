import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Marked, positionsToRanges } from './Marked'

/**
 * Highlighting is where an off-by-one shows up as dropped or duplicated
 * characters in front of the user, so these pin the text as much as the marks.
 */

afterEach(cleanup)

describe('positionsToRanges', () => {
  it('collapses a run of adjacent indices into one span', () => {
    expect(positionsToRanges([0, 1, 2])).toEqual([[0, 3]])
  })

  it('keeps separated indices as separate spans', () => {
    expect(positionsToRanges([0, 4])).toEqual([
      [0, 1],
      [4, 5]
    ])
  })

  it('handles the mixed case a fuzzy match actually produces', () => {
    // "cmd" against "Command Palette": C, m, d — one run, then a gap.
    expect(positionsToRanges([0, 2, 6])).toEqual([
      [0, 1],
      [2, 3],
      [6, 7]
    ])
  })

  it('is empty for no positions', () => {
    expect(positionsToRanges([])).toEqual([])
    expect(positionsToRanges(undefined)).toEqual([])
  })
})

describe('Marked', () => {
  it('renders the text unchanged when nothing matched', () => {
    render(<Marked text="hello world" ranges={[]} />)
    expect(screen.getByText('hello world')).toBeTruthy()
  })

  it('preserves every character while marking a span', () => {
    const { container } = render(<Marked text="const useStore = 1" ranges={[[6, 14]]} />)
    expect(container.textContent).toBe('const useStore = 1')
    expect(container.querySelector('.font-bold')?.textContent).toBe('useStore')
  })

  it('marks several spans on one line', () => {
    const { container } = render(
      <Marked
        text="useStore and useStore"
        ranges={[
          [0, 8],
          [13, 21]
        ]}
      />
    )
    expect(container.textContent).toBe('useStore and useStore')
    expect(container.querySelectorAll('.font-bold')).toHaveLength(2)
  })

  it('marks a span that starts at the very beginning', () => {
    const { container } = render(<Marked text="useStore()" ranges={[[0, 8]]} />)
    expect(container.textContent).toBe('useStore()')
  })

  it('does not lose text for a range that runs past the end', () => {
    const { container } = render(<Marked text="short" ranges={[[2, 99]]} />)
    expect(container.textContent).toBe('short')
  })

  it('does not duplicate text for overlapping ranges', () => {
    const { container } = render(
      <Marked
        text="abcdef"
        ranges={[
          [0, 4],
          [2, 6]
        ]}
      />
    )
    expect(container.textContent).toBe('abcdef')
  })

  it('takes a custom mark class, so a code hit and a name hit can look different', () => {
    const { container } = render(<Marked text="abc" ranges={[[0, 1]]} className="bg-amber/25" />)
    expect(container.querySelector('.bg-amber\\/25')?.textContent).toBe('a')
  })
})
