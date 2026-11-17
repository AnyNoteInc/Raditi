// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamStatsLine, streamStatsEnabled, streamStatsText } from './stream-stats-line'

const live = { fps: 9.5, kbPerFrame: 48, mbps: 3.6, drawMs: 7.4, inputMs: 212 }

beforeEach(() => {
  window.sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the line of numbers of the stream', () => {
  it('is turned on and off by the address, and stays for the tab', () => {
    expect(streamStatsEnabled('')).toBe(false)
    expect(streamStatsEnabled('?stream-stats=1')).toBe(true)
    expect(streamStatsEnabled('?other=1')).toBe(true)
    expect(streamStatsEnabled('?stream-stats=0')).toBe(false)
    expect(streamStatsEnabled('')).toBe(false)
  })

  it('says the numbers in Russian, a dash for what was not measured', () => {
    expect(streamStatsText(live)).toBe(
      '9,5 к/с · 48 КБ · 3,6 Мбит/с · рисование 7 мс · касание → картинка 212 мс',
    )
    expect(
      streamStatsText({ fps: 0, kbPerFrame: null, mbps: 0, drawMs: null, inputMs: null }),
    ).toBe('0 к/с · — КБ · 0 Мбит/с · рисование — · касание → картинка —')
  })

  it('shows nothing unless turned on, and refreshes every second when it is', () => {
    vi.useFakeTimers()
    const read = vi.fn(() => live)
    const { unmount } = render(<StreamStatsLine read={read} />)
    expect(screen.queryByTestId('stream-stats')).toBeNull()
    expect(read).not.toHaveBeenCalled()
    unmount()
    window.sessionStorage.setItem('raditi.streamStats', '1')
    render(<StreamStatsLine read={read} />)
    expect(screen.getByTestId('stream-stats').textContent).toContain('9,5 к/с')
    const calls = read.mock.calls.length
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(read.mock.calls.length).toBe(calls + 2)
  })
})
