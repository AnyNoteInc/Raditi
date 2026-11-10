// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { downloadText, REVOKE_AFTER_MS } from './download-text'

describe('downloadText', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('saves the text as a file and lets go of its address only after the browser has begun', async () => {
    vi.useFakeTimers()
    const blobs: Blob[] = []
    const revoke = vi.fn()
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob)
        return 'blob:text'
      },
      revokeObjectURL: revoke,
    })
    const clicked: { name: string; href: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ name: this.download, href: this.href })
    })

    downloadText('Цена.md', '# Цена\n', 'text/markdown;charset=utf-8')

    expect(clicked).toEqual([{ name: 'Цена.md', href: 'blob:text' }])
    expect(await blobs[0]!.text()).toBe('# Цена\n')
    expect(document.querySelector('a[download]')).toBeNull()
    // Revoked at once, the address could not be read when the save begins.
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REVOKE_AFTER_MS)
    expect(revoke).toHaveBeenCalledWith('blob:text')
  })
})
