import type { FrameRenderer } from '@repo/browser-providers/render'
import { DomainError } from '@repo/domain'
import { artifactPrintLimits } from '@repo/domain/artifacts'
import { describe, expect, it, vi } from 'vitest'

import { PrintService } from './print-service.ts'

// The route of prints (docs/plan/88-artifacts.md, §7.13, 88.32): the page to the printer of a slot
// of the pool, the PDF in base64, a file over 8 MiB refused.

function serviceWith(bytes: Uint8Array | Error) {
  const print = vi.fn(async () => {
    if (bytes instanceof Error) throw bytes
    return bytes
  })
  const pool = {
    run: async <T>(work: (renderer: FrameRenderer) => Promise<T>) =>
      work({ print } as unknown as FrameRenderer),
  }
  return { service: new PrintService(pool), print }
}

const html = '<!doctype html><html><head></head><body><h1>Отчёт</h1></body></html>'

describe('the route of prints', () => {
  it('prints the page and answers the PDF in base64', async () => {
    const { service, print } = serviceWith(new TextEncoder().encode('%PDF-1.7'))
    const out = await service.print({ html })
    expect(print).toHaveBeenCalledWith({ html })
    expect(Buffer.from(out.pdf, 'base64').toString('latin1')).toBe('%PDF-1.7')
  })

  it('refuses a file over the limit and turns a fault of the Chromium into RENDER_UNAVAILABLE', async () => {
    await expect(
      serviceWith(new Uint8Array(artifactPrintLimits.pdfBytes + 1)).service.print({ html }),
    ).rejects.toMatchObject({ code: 'RENDER_TOO_LARGE', httpStatus: 413 })
    await expect(
      serviceWith(new Error('print deadline')).service.print({ html }),
    ).rejects.toMatchObject({ code: 'RENDER_UNAVAILABLE' })
    // A page that does not print in time is refused (4xx): core does not try it again.
    await expect(
      serviceWith(new DomainError('RENDER_TIMEOUT', 'late', 422)).service.print({ html }),
    ).rejects.toMatchObject({ code: 'RENDER_TIMEOUT', httpStatus: 422 })
  })
})
