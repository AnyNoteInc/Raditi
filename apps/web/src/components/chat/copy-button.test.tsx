// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CopyButton } from './copy-button'

describe('«Скопировать текст» of a message (14.11.2026)', () => {
  it('copies the words and says so for a moment', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<CopyButton text="Поменяйте цену" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Скопировать текст' }))
    })
    expect(writeText).toHaveBeenCalledWith('Поменяйте цену')
    expect(screen.getByRole('button', { name: 'Скопировано' })).toBeTruthy()
  })
})
