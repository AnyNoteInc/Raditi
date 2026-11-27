// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMinuteNow } from './use-minute-now'

const rendered = vi.fn()
function Clock({ label }: { label: string }) {
  rendered()
  const now = useMinuteNow()
  return <span data-testid={label}>{now.toISOString()}</span>
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-11-27T10:15:30.000Z'))
  rendered.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useMinuteNow', () => {
  it('gives every reader the same time, and a new one when the minute turns', () => {
    const { unmount } = render(
      <>
        <Clock label="first" />
        <Clock label="second" />
      </>,
    )
    const first = screen.getByTestId('first').textContent
    expect(screen.getByTestId('second').textContent).toBe(first)
    const before = rendered.mock.calls.length

    act(() => void vi.advanceTimersByTime(20_000))
    expect(rendered).toHaveBeenCalledTimes(before)

    act(() => void vi.advanceTimersByTime(10_000))
    expect(screen.getByTestId('first').textContent).toBe('2026-11-27T10:16:00.000Z')
    expect(screen.getByTestId('second').textContent).toBe('2026-11-27T10:16:00.000Z')
    unmount()
  })
})
