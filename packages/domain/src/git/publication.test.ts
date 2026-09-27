import { describe, expect, it } from 'vitest'

import { assertPublicationChange, publicationLimits } from './publication.ts'

describe('assertPublicationChange', () => {
  const change = (sizeBytes: number) => ({
    path: 'wp-content/uploads/photo.jpg',
    oldMode: '000000',
    newMode: '100644',
    sizeBytes,
  })

  it('accepts a file at the size limit', () => {
    expect(() => assertPublicationChange(change(publicationLimits.fileBytes), [])).not.toThrow()
  })

  it('reports a file over the size limit as too large (413), not as invalid input', () => {
    expect(() => assertPublicationChange(change(publicationLimits.fileBytes + 1), [])).toThrow(
      expect.objectContaining({ code: 'PUBLICATION_TOO_LARGE', httpStatus: 413 }),
    )
  })

  it('keeps an impossible size an invalid input', () => {
    expect(() => assertPublicationChange(change(-1), [])).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })
})
