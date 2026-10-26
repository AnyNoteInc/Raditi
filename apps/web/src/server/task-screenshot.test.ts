import { describe, expect, it, vi } from 'vitest'

import { getTaskScreenshot, type TaskScreenshotDependencies } from './task-screenshot'

// A snapshot of a task's browser for the client (`web_screenshot`): signed in, with the current
// documents accepted, and only what the reader of @repo/trpc found.

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const params = {
  taskId: '0199a3f2-0000-7000-8000-000000000001',
  screenshotId: '0199a3f2-0000-7000-8000-000000000002',
}

function deps(patch: Partial<TaskScreenshotDependencies> = {}) {
  return {
    getSession: vi.fn(async () => ({ user: { id: '0199a3f2-0000-7000-8000-0000000000a1' } })),
    hasRequiredConsents: vi.fn(async () => true),
    read: vi.fn(async () => jpeg),
    onFailure: vi.fn(),
    ...patch,
  } satisfies TaskScreenshotDependencies
}

const request = () => new Request('http://localhost/api/tasks/x/screenshots/y')

describe('a snapshot of the browser of a task', () => {
  it('serves the JPEG of the reader to its member, never sniffed or framed', async () => {
    const d = deps()
    const response = await getTaskScreenshot(request(), params, d)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(d.read).toHaveBeenCalledExactlyOnceWith({
      userId: '0199a3f2-0000-7000-8000-0000000000a1',
      ...params,
    })
  })

  it('asks to sign in, to accept the documents, and answers someone else’s alike missing', async () => {
    expect(
      (await getTaskScreenshot(request(), params, deps({ getSession: async () => null }))).status,
    ).toBe(401)
    expect(
      (await getTaskScreenshot(request(), params, deps({ hasRequiredConsents: async () => false })))
        .status,
    ).toBe(428)
    expect(
      (await getTaskScreenshot(request(), params, deps({ read: async () => null }))).status,
    ).toBe(404)
  })

  it('says a failed read in its own words, and logs the cause', async () => {
    const d = deps({
      read: async () => {
        throw new Error('s3 down')
      },
    })
    const response = await getTaskScreenshot(request(), params, d)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ message: 'Не удалось загрузить снимок экрана.' })
    expect(d.onFailure).toHaveBeenCalledWith('task screenshot read failed', expect.any(Error))
  })
})
