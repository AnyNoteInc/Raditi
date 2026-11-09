// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const params: { taskId?: string } = { taskId: '0199a3f2-0000-7000-8000-0000000000b1' }
vi.mock('next/navigation', () => ({ useParams: () => params }))

import { FeedFile, taskFileHref } from './feed-file'

const file = {
  fileId: '0199a3f2-0000-8000-8000-0000000000f1',
  name: 'Смета на ноябрь.xlsx',
  sizeBytes: Math.round(1.2 * 1024 * 1024),
}

describe('a file of the agent in the chat', () => {
  it('shows its name and size and downloads it from the cabinet’s own origin', () => {
    render(<FeedFile {...file} />)
    const href = `/api/tasks/${params.taskId}/files/${file.fileId}`
    expect(taskFileHref(params.taskId!, file.fileId)).toBe(href)
    expect(screen.getByText('Смета на ноябрь.xlsx')).toBeTruthy()
    expect(screen.getByText('1,2 МБ')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Скачать файл «Смета на ноябрь.xlsx»' })
    expect(link.getAttribute('href')).toBe(href)
    expect(link.getAttribute('download')).toBe('Смета на ноябрь.xlsx')
    expect(link.textContent).toBe('Скачать')
  })

  it('shows nothing outside the page of a chat', () => {
    delete params.taskId
    const { container } = render(<FeedFile {...file} />)
    expect(container.innerHTML).toBe('')
  })
})
