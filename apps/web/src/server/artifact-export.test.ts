import { describe, expect, it, vi } from 'vitest'

import { getArtifactExport, type ArtifactExportDependencies } from './artifact-export'

// «Скачать → Excel» of a table (docs/plan/88-artifacts.md, question 26): signed in, with the
// documents accepted, only what the reader of @repo/trpc found for this person, always a download.

const bytes = Buffer.from('PK xlsx')
const exportId = '0199a3f2-0000-7000-8000-0000000000e1'

function deps(patch: Partial<ArtifactExportDependencies> = {}) {
  return {
    getSession: vi.fn(async () => ({ user: { id: '0199a3f2-0000-7000-8000-0000000000a1' } })),
    hasRequiredConsents: vi.fn(async () => true),
    read: vi.fn(async () => ({
      name: 'Прайс-лист.xlsx',
      bytes,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })),
    onFailure: vi.fn(),
    ...patch,
  } satisfies ArtifactExportDependencies
}

const request = () => new Request(`http://localhost/api/artifact-exports/${exportId}`)

describe('a workbook of a table', () => {
  it('goes to the person who asked as an attachment, never sniffed or framed', async () => {
    const d = deps()
    const response = await getArtifactExport(request(), exportId, d)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(response.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('Прайс-лист.xlsx')}`,
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(d.read).toHaveBeenCalledExactlyOnceWith({
      userId: '0199a3f2-0000-7000-8000-0000000000a1',
      exportId,
    })
  })

  it('asks to sign in, to accept the documents, and answers another’s alike missing', async () => {
    expect(
      (await getArtifactExport(request(), exportId, deps({ getSession: async () => null }))).status,
    ).toBe(401)
    expect(
      (
        await getArtifactExport(
          request(),
          exportId,
          deps({ hasRequiredConsents: async () => false }),
        )
      ).status,
    ).toBe(428)
    expect(
      (await getArtifactExport(request(), exportId, deps({ read: async () => null }))).status,
    ).toBe(404)
  })

  it('says a failed read in its own words and logs the cause', async () => {
    const d = deps({ read: async () => Promise.reject(new Error('S3 away')) })
    const response = await getArtifactExport(request(), exportId, d)
    expect(response.status).toBe(503)
    expect(d.onFailure).toHaveBeenCalledOnce()
  })
})
