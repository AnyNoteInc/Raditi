import {
  conflict,
  notFound,
  RELEASE_API_HEALTH_PATH,
  releaseApiLimits,
  releaseApiPaths,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReleaseApiServer } from './release-api.server.ts'
import { unauthorized, type ReleaseApi } from './release-api.service.ts'

let server: ReleaseApiServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const id = '0196abcd-0000-7000-8000-00000000000a'

async function serve(api: ReleaseApi | null) {
  server = new ReleaseApiServer(api)
  const { port } = await server.listen(0, '127.0.0.1')
  return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)
}

/** A stand-in of the service: the server only routes, reads bodies and maps refusals. */
function api() {
  return {
    manifest: vi.fn(async () => ({ v: 1 })),
    access: vi.fn(async () => ({ v: 1 })),
    step: vi.fn(async () => ({ status: 200, answer: { accepted: true, proceed: true } })),
    backup: vi.fn(async () => ({ phase: 'verify', verified: true })),
    value: vi.fn(async () => Buffer.from('sealed value')),
  }
}

describe('ReleaseApiServer', () => {
  it('answers its health, and only the health while releases are off', async () => {
    const call = await serve(null)
    const health = await call(RELEASE_API_HEALTH_PATH)
    expect(health.status).toBe(200)
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(await health.json()).toEqual({ status: 'ok' })
    for (const path of [releaseApiPaths.manifest(id), '/', '/metrics'])
      expect((await call(path)).status).toBe(404)
    expect((await call(releaseApiPaths.steps(id), { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('routes the four calls with their method, the bearer token and the JSON body', async () => {
    const service = api()
    const call = await serve(service as unknown as ReleaseApi)
    const auth = { authorization: 'Bearer token' }
    expect(
      await (await call(releaseApiPaths.manifest(id.toUpperCase()), { headers: auth })).json(),
    ).toEqual({ v: 1 })
    expect(service.manifest).toHaveBeenCalledWith(id, 'Bearer token')
    await call(releaseApiPaths.access(id), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ deployAttempt: 1 }),
    })
    expect(service.access).toHaveBeenCalledWith(id, 'Bearer token', { deployAttempt: 1 })
    const step = await call(releaseApiPaths.steps(id), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ reportKey: '1:conflicts:started' }),
    })
    expect(step.status).toBe(200)
    expect(service.step).toHaveBeenCalledWith(id, 'Bearer token', {
      reportKey: '1:conflicts:started',
    })
    await call(releaseApiPaths.backup(id), { method: 'POST', headers: auth, body: '{}' })
    expect(service.backup).toHaveBeenCalledWith(id, 'Bearer token', {})
    // The wrong method, a malformed id.
    expect((await call(releaseApiPaths.manifest(id), { method: 'POST' })).status).toBe(405)
    expect((await call(releaseApiPaths.steps(id))).status).toBe(405)
    expect((await call('/v1/releases/not-a-uuid/manifest')).status).toBe(404)
  })

  it('hands out the sealed value of an operation of the plan as bytes, by GET only', async () => {
    const service = api()
    const call = await serve(service as unknown as ReleaseApi)
    const auth = { authorization: 'Bearer token' }
    const value = await call(`/v1/releases/${id}/values/12`, { headers: auth })
    expect(value.status).toBe(200)
    expect(value.headers.get('content-type')).toBe('application/octet-stream')
    expect(value.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await value.arrayBuffer()).toString()).toBe('sealed value')
    expect(service.value).toHaveBeenCalledWith(id, 'Bearer token', '12')
    expect((await call(`/v1/releases/${id}/values/12`, { method: 'POST' })).status).toBe(405)
    for (const path of [`/v1/releases/${id}/values/`, `/v1/releases/${id}/values/x`])
      expect((await call(path, { headers: auth })).status).toBe(404)
    expect((await call(`/v1/releases/${id}/values/12345`, { headers: auth })).status).toBe(404)
    service.value.mockRejectedValueOnce(notFound('The plan has no such operation'))
    expect((await call(`/v1/releases/${id}/values/3`, { headers: auth })).status).toBe(404)
    expect(service.value).toHaveBeenCalledTimes(2)
  })

  it('answers a refused report with 409 and its answer', async () => {
    const service = api()
    service.step.mockResolvedValueOnce({ status: 409, answer: { accepted: false, proceed: false } })
    const call = await serve(service as unknown as ReleaseApi)
    const response = await call(releaseApiPaths.steps(id), { method: 'POST', body: '{}' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ accepted: false, proceed: false })
  })

  it('names a refusal by its code only, and hides any other failure', async () => {
    const service = api()
    service.manifest
      .mockRejectedValueOnce(unauthorized())
      .mockRejectedValueOnce(conflict('The release does not hold its site /www/secret'))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED postgres://raditi:raditi@db'))
    const call = await serve(service as unknown as ReleaseApi)
    const unauthorizedAnswer = await call(releaseApiPaths.manifest(id))
    expect(unauthorizedAnswer.status).toBe(401)
    expect(await unauthorizedAnswer.json()).toEqual({ error: 'UNAUTHORIZED' })
    const conflictAnswer = await call(releaseApiPaths.manifest(id))
    expect(conflictAnswer.status).toBe(409)
    expect(await conflictAnswer.text()).toBe('{"error":"CONFLICT"}')
    const failure = await call(releaseApiPaths.manifest(id))
    expect(failure.status).toBe(503)
    expect(await failure.text()).toBe('{"error":"UNAVAILABLE"}')
  })

  it('refuses a body that is too large or not JSON before the service sees it', async () => {
    const service = api()
    const call = await serve(service as unknown as ReleaseApi)
    const large = await call(releaseApiPaths.steps(id), {
      method: 'POST',
      body: 'x'.repeat(releaseApiLimits.bodyBytes + 1),
    })
    expect(large.status).toBe(413)
    const invalid = await call(releaseApiPaths.steps(id), { method: 'POST', body: '{"a":' })
    expect(invalid.status).toBe(400)
    expect(service.step).not.toHaveBeenCalled()
  })
})
