import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Task } from '@shared/types'
import ArchiveTaskButton from './ArchiveTaskButton'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('archives the task in one click, without the click reaching the card', () => {
  const archiveTask = vi.fn(async () => undefined)
  vi.stubGlobal('orbital', { archiveTask })
  const onCardClick = vi.fn()
  render(
    <div onClick={onCardClick}>
      <ArchiveTaskButton task={{ id: 't1', seq: 7, status: 'done' } as Task} />
    </div>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Archive task #7' }))
  expect(archiveTask).toHaveBeenCalledWith('t1')
  expect(onCardClick).not.toHaveBeenCalled()
})
