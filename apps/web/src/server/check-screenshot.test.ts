import { describe, expect, it, vi } from 'vitest'

import { getCheckScreenshot, type CheckScreenshotDependencies } from './check-screenshot'

// The screenshot of the agent's check, for the «Проверки» tab (docs/plan/53, Р22): signed in,
// with the current documents accepted, and only what the reader of @repo/trpc found.

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const params = {
  taskId: '0199a3f2-0000-7000-8000-000000000001',
  checkId: '0199a3f2-0000-7000-8000-000000000002',
}

function deps(patch: Partial<CheckScreenshotDependencies> = {}) {
  return {
    getSession: vi.fn(async () => ({ user: { id: '0199a3f2-0000-7000-8000-0000000000a1' } })),
    hasRequiredConsents: vi.fn(async () => true),
    read: vi.fn(async () => png),
    onFailure: vi.fn(),
    ...patch,
  } satisfies CheckScreenshotDependencies
}

const request = () => new Request('http://localhost/api/tasks/x/checks/y/screenshot')

describe('the screenshot of a check', () => {
  it('serves the PNG of the reader to its member, never sniffed or framed', async () => {
    const d = deps()
    const response = await getCheckScreenshot(request(), params, d)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400, immutable')
    expect(d.read).toHaveBeenCalledExactlyOnceWith({
      userId: '0199a3f2-0000-7000-8000-0000000000a1',
      ...params,
    })
  })

  it('answers without a session, before the documents and for what the reader did not find', async () => {
    expect(
      (await getCheckScreenshot(request(), params, deps({ getSession: async () => null }))).status,
    ).toBe(401)
    const unconsented = deps({ hasRequiredConsents: async () => false })
    expect((await getCheckScreenshot(request(), params, unconsented)).status).toBe(428)
    expect(unconsented.read).not.toHaveBeenCalled()
    expect(
      (await getCheckScreenshot(request(), params, deps({ read: async () => null }))).status,
    ).toBe(404)
    const broken = deps({
      read: async () => {
        throw new Error('private S3 detail')
      },
    })
    const failed = await getCheckScreenshot(request(), params, broken)
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('S3')
    expect(broken.onFailure).toHaveBeenCalledOnce()
  })
})
