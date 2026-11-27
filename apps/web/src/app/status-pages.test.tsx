// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import RootError from './error'
import NotFound from './not-found'

describe('the pages of the root boundaries', () => {
  it('leads from «Страница не найдена» to the home page', () => {
    render(<NotFound />)

    expect(screen.getByRole('heading', { level: 1, name: 'Страница не найдена' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'На главную' })).toHaveAttribute('href', '/')
  })

  it('says the code of an error and tries again on a press', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reset = vi.fn()
    render(
      <RootError error={Object.assign(new Error('boom'), { digest: 'abc123' })} reset={reset} />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Что-то пошло не так' })).toBeVisible()
    expect(screen.getByText('Код ошибки для поддержки: abc123')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Попробовать ещё раз' }))
    expect(reset).toHaveBeenCalledOnce()
    expect(screen.getByRole('link', { name: 'На главную' })).toHaveAttribute('href', '/')
    vi.mocked(console.error).mockRestore()
  })
})
