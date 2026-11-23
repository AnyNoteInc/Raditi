import { expect, it, vi } from 'vitest'

import { getCanvasThumb, type CanvasThumbDependencies } from './canvas-thumb'

it('does not cache a private thumbnail and checks access on a repeat request', async () => {
  const input = {
    artifactId: '0199a3f2-0000-7000-8000-0000000000a1',
    file: '00000000000000000000000000-390.jpg',
  }
  const request = new Request(
    `http://localhost/api/artifact-thumbs/${input.artifactId}/${input.file}`,
  )
  const bytes = Uint8Array.of(255, 216, 255)
  const deps = {
    getSession: async () => ({ user: { id: 'viewer' } }),
    hasRequiredConsents: async () => true,
    read: vi
      .fn<CanvasThumbDependencies['read']>()
      .mockResolvedValueOnce(bytes)
      .mockResolvedValueOnce(null),
  }
  const response = await getCanvasThumb(request, input, deps)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.bytes()).toEqual(bytes)
  expect((await getCanvasThumb(request, input, deps)).status).toBe(404)
  expect(deps.read).toHaveBeenNthCalledWith(2, { userId: 'viewer', ...input })
})
