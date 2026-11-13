// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { arrivedSince, latestDocumentRow, useDocumentArrivals } from './use-document-arrivals'

const file = (id: string, name: string) => ({
  id,
  type: 'feed.file',
  fileId: `f${id}`,
  name,
  sizeBytes: 1,
})

describe('documents that come live (docs/plan/67, Д4)', () => {
  it('measures what came against the newest document row of the history', () => {
    const rows = [file('3', 'a.md'), file('5', 'b.docx'), file('7', 'c.html')]
    expect(latestDocumentRow(rows)).toBe('7')
    expect(arrivedSince([...rows, file('10', 'a.md')], '7')).toEqual(['a.md'])
    expect(arrivedSince(rows, '7')).toEqual([])
  })

  it('tells nothing of the history, and every arrival once', () => {
    const onArrive = vi.fn()
    const history = [file('3', 'a.md')]
    const { rerender } = renderHook(
      ({ rows, ready }) => useDocumentArrivals(rows, ready, onArrive),
      { initialProps: { rows: [] as ReturnType<typeof file>[], ready: false } },
    )
    rerender({ rows: history, ready: true })
    expect(onArrive).not.toHaveBeenCalled()
    const live = [...history, file('9', '00-оглавление.md'), file('11', '01-a.md')]
    rerender({ rows: live, ready: true })
    expect(onArrive).toHaveBeenCalledWith(['00-оглавление.md', '01-a.md'])
    rerender({ rows: [...live], ready: true })
    expect(onArrive).toHaveBeenCalledTimes(1)
  })
})
