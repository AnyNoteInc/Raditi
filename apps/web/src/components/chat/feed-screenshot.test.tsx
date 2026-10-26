// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const params: { taskId?: string } = { taskId: '0199a3f2-0000-7000-8000-0000000000b1' }
vi.mock('next/navigation', () => ({ useParams: () => params }))

import { FeedScreenshot, taskScreenshotHref } from './feed-screenshot'

const shot = {
  screenshotId: '0199a3f2-0000-7000-8000-0000000000c1',
  number: 2,
  width: 1280,
  height: 800,
}

describe('a snapshot in the dialog', () => {
  it('shows the image of the task from the cabinet’s own origin, and opens it full size', () => {
    render(<FeedScreenshot {...shot} />)
    const href = `/api/tasks/${params.taskId}/screenshots/${shot.screenshotId}`
    expect(taskScreenshotHref(params.taskId!, shot.screenshotId)).toBe(href)
    expect(screen.getByText('Снимок экрана № 2')).toBeTruthy()
    const image = screen.getByRole<HTMLImageElement>('img', { name: /Снимок экрана сайта № 2/ })
    expect(image.getAttribute('src')).toBe(href)
    expect(image.getAttribute('width')).toBe('1280')
    expect(image.getAttribute('height')).toBe('800')
    const full = screen.getByRole('link', { name: 'Открыть в полном размере' })
    expect(full.getAttribute('href')).toBe(href)
    expect(full.getAttribute('target')).toBe('_blank')
  })

  it('shows nothing outside the page of a dialog', () => {
    delete params.taskId
    const { container } = render(<FeedScreenshot {...shot} />)
    expect(container.innerHTML).toBe('')
  })
})
