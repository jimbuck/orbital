import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useStore } from '@renderer/store'

import ModalRoot from './ModalRoot'

/**
 * Escape peels the modal stack — unless a control inside the modal already
 * handled that press (an inline input cancelling its own edit), in which case
 * the modal must stay, with every unsaved edit in it.
 */

beforeEach(() => {
  vi.stubGlobal('orbital', new Proxy({}, { get: () => vi.fn(async () => null) }))
  useStore.setState({ modalStack: [], modal: null, modalData: null } as unknown as Parameters<typeof useStore.setState>[0])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ModalRoot Escape', () => {
  it('closes the top modal on a plain Escape', () => {
    render(<ModalRoot />)
    act(() => useStore.getState().openModal('addProject'))
    expect(useStore.getState().modalStack.length).toBe(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useStore.getState().modalStack.length).toBe(0)
  })

  it('leaves the modal open when something inside already consumed the Escape', () => {
    render(<ModalRoot />)
    act(() => useStore.getState().openModal('addProject'))
    const evt = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    evt.preventDefault()
    window.dispatchEvent(evt)
    expect(useStore.getState().modalStack.length).toBe(1)
  })
})
