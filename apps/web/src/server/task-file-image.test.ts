import { describe, expect, it, vi } from 'vitest'

import { getTaskFileImage } from './task-file-image'

vi.mock('server-only', () => ({}))

const params = { taskId: 't', fileId: 'f' }
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
const deps = (overrides = {}) => ({
  getSession: async () => ({ user: { id: 'u' } }),
  hasRequiredConsents: async () => true,
  read: vi.fn(async () => ({ type: 'image/png', bytes: png })),
  ...overrides,
})

describe('GET /api/tasks/<taskId>/files/<fileId>/image (docs/plan/67, Д5)', () => {
  it('serves a picture inline, never sniffed, framed or read by another origin', async () => {
    const response = await getTaskFileImage(new Request('http://x'), params, deps())
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; sandbox",
    })
  })

  it('answers no session, no consents and no picture', async () => {
    const at = (d: ReturnType<typeof deps>) => getTaskFileImage(new Request('http://x'), params, d)
    expect((await at(deps({ getSession: async () => null }))).status).toBe(401)
    expect((await at(deps({ hasRequiredConsents: async () => false }))).status).toBe(428)
    expect((await at(deps({ read: async () => null }))).status).toBe(404)
  })
})
