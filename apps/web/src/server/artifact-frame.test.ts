import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { pageKeys, signArtifactToken } = await import('@repo/trpc')
const { artifactEditFrame, artifactOnPages } = await import('./artifact-frame')
const { uploadArtifactFile } = await import('./artifact-file')

// The answers of artifacts on the root of the pages and the edit frame of the cabinet
// (docs/plan/88-artifacts.md, Ар9, Ар12, Ар28; slices 88.12, 88.13), without a database: what each
// refuses before it reads anything.

const keys = pageKeys('synthetic-pages-secret-of-the-unit-test-01')
const chat = () =>
  ({
    pageViews: { origin: 'https://pages.raditi.test', appUrl: 'https://raditi.test', keys },
    storage: () => ({}),
  }) as never
const deps = (over: Record<string, unknown> = {}) => ({
  db: () => ({}) as never,
  chat,
  pagesHost: () => 'pages.raditi.test',
  ...over,
})
const token = (label: 'artifact' | 'aedit', userId = 'u1') =>
  signArtifactToken(keys.view, label, {
    artifactId: '019f1a21-1800-7f00-8abc-000000000001',
    userId,
    expiresAt: Date.now() + 60_000,
  })

describe('/v/<segment> on the root of the pages', () => {
  it('leaves a segment that is no artifact’s to the page of plan 67', async () => {
    const request = new Request('https://pages.raditi.test/v/abc.def', {
      headers: { host: 'pages.raditi.test' },
    })
    expect(await artifactOnPages(request, 'abc.def', deps())).toBeNull()
  })

  it('answers the frame of a screen only on the host of the pages', async () => {
    const request = new Request('https://raditi.test/v/x', { headers: { host: 'raditi.test' } })
    expect((await artifactOnPages(request, token('artifact'), deps()))?.status).toBe(404)
  })

  it('serves a font of the platform with CORS and CORP for any frame, forever', async () => {
    const { artifactPlatformFiles } = await import('./artifact-platform')
    const file = artifactPlatformFiles[0]!
    const request = new Request(`https://pages.raditi.test/v/${file.label}.${file.hash}`, {
      headers: { host: 'pages.raditi.test' },
    })
    const answer = (await artifactOnPages(request, `${file.label}.${file.hash}`, deps()))!
    expect(answer.status).toBe(200)
    expect(answer.headers.get('access-control-allow-origin')).toBe('*')
    expect(answer.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(answer.headers.get('content-type')).toBe('font/woff2')
    const old = await artifactOnPages(request, `${file.label}.0000000000000000`, deps())
    expect(old?.status).toBe(404)
  })
})

describe('the edit frame /api/artifact-frame/<token> (Ар9)', () => {
  const asked = (headers: Record<string, string>) =>
    new Request('https://raditi.test/api/artifact-frame/x', { headers })
  it('answers only a frame of the cabinet’s own origin', async () => {
    const session = vi.fn(async () => ({ user: { id: 'u1' } }))
    expect(
      (await artifactEditFrame(asked({}), token('aedit'), deps({ getSession: session }))).status,
    ).toBe(404)
    expect(
      (
        await artifactEditFrame(
          asked({ 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' }),
          token('aedit'),
          deps({ getSession: session }),
        )
      ).status,
    ).toBe(404)
    expect(session).not.toHaveBeenCalled()
  })

  it('answers only the viewer its token names, and no token of the frame of the view', async () => {
    const frame = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' }
    const other = vi.fn(async () => ({ user: { id: 'u2' } }))
    expect(
      (await artifactEditFrame(asked(frame), token('aedit'), deps({ getSession: other }))).status,
    ).toBe(404)
    const same = vi.fn(async () => ({ user: { id: 'u1' } }))
    expect(
      (await artifactEditFrame(asked(frame), token('artifact'), deps({ getSession: same }))).status,
    ).toBe(404)
  })
})

describe('PUT /api/artifact-files/<id> (Ар12)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
  const fileDeps = (over: Record<string, unknown> = {}) => {
    const put = vi.fn(async () => undefined)
    const markReady = vi.fn(async () => true)
    return {
      put,
      markReady,
      deps: {
        appOrigin: () => 'https://raditi.test',
        getSession: async () => ({ user: { id: 'u1' } }),
        hasRequiredConsents: async () => true,
        findUpload: async () => ({
          id: '019f1a21-1800-7f00-8abc-0000000000f1',
          name: 'logo.png',
          objectKey: 'artifacts/w/a/f',
          bytes: PNG.byteLength,
        }),
        markReady,
        storage: () => ({ put, delete: vi.fn() }),
        ...over,
      },
    }
  }
  const upload = (body: Uint8Array, origin = 'https://raditi.test') =>
    new Request('https://raditi.test/api/artifact-files/x', {
      method: 'PUT',
      body: new Uint8Array(body) as Uint8Array<ArrayBuffer>,
      headers: { origin },
    })
  const id = { id: '019f1a21-1800-7f00-8abc-0000000000f1' }

  it('stores a picture that begins as its type, under the key of its hash', async () => {
    const { deps, put, markReady } = fileDeps()
    const answer = await uploadArtifactFile(upload(PNG), id, deps)
    expect(answer.status).toBe(200)
    expect(put).toHaveBeenCalledWith(
      'artifacts',
      expect.stringMatching(/^artifacts\/w\/a\/f\.[0-9a-f]{16}$/),
      expect.anything(),
      expect.anything(),
    )
    expect(markReady).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'image/png' }))
  })

  it('refuses another origin, other bytes than announced and a type in disguise', async () => {
    expect(
      (await uploadArtifactFile(upload(PNG, 'https://evil.test'), id, fileDeps().deps)).status,
    ).toBe(403)
    expect((await uploadArtifactFile(upload(PNG.slice(0, 4)), id, fileDeps().deps)).status).toBe(
      400,
    )
    const html = new TextEncoder().encode('<html>xx')
    const disguised = fileDeps({
      findUpload: async () => ({
        id: id.id,
        name: 'logo.png',
        objectKey: 'k',
        bytes: html.byteLength,
      }),
    })
    expect((await uploadArtifactFile(upload(html), id, disguised.deps)).status).toBe(422)
    expect(disguised.put).not.toHaveBeenCalled()
  })
})
