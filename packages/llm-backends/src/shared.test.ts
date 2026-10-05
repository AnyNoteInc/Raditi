import type { EgressHttp, EgressRequest, EgressResponse } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { controlRequest, decodeControlJson, encodeJson, maxControlResponseBytes } from './shared.ts'

const request: EgressRequest = {
  url: 'https://provider.invalid/control',
  method: 'POST',
  headers: new Headers({ authorization: 'Bearer synthetic-secret' }),
  body: encodeJson({ token: 'synthetic-secret' }),
}
const response = (status = 200, body = encodeJson({ ok: true })): EgressResponse => ({
  status,
  headers: new Headers(),
  body,
})

afterEach(() => vi.useRealTimers())

describe('bounded control responses', () => {
  it('preserves a response and passes an AbortSignal without changing the request', async () => {
    const reply = response()
    const send = vi.fn<EgressHttp['request']>().mockResolvedValue(reply)
    expect(await controlRequest({ request: send }, request)).toBe(reply)
    expect(send).toHaveBeenCalledExactlyOnceWith(request, { signal: expect.any(AbortSignal) })
  })

  it.each([400, 401, 403, 404, 429, 500])(
    'returns status %s to the adapter for classification',
    async (status) => {
      const send = vi.fn<EgressHttp['request']>().mockResolvedValue(response(status))
      expect((await controlRequest({ request: send }, request)).status).toBe(status)
      expect(send).toHaveBeenCalledTimes(1)
    },
  )

  it('bounds a stalled request, aborts it and never retries', async () => {
    vi.useFakeTimers()
    const send = vi.fn<EgressHttp['request']>().mockImplementation(() => new Promise(() => {}))
    const result = controlRequest({ request: send }, request)
    const assertion = expect(result).rejects.toMatchObject({ code: 'LLM_GATEWAY_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['sync', 'async'])('scrubs %s transport failures including their cause', async (kind) => {
    const send: EgressHttp['request'] = () => {
      const error = new Error('synthetic-secret', { cause: request })
      if (kind === 'sync') throw error
      return Promise.reject(error)
    }
    try {
      await controlRequest({ request: send }, request)
      expect.fail('request unexpectedly succeeded')
    } catch (error) {
      expect(error).toMatchObject({ code: 'LLM_GATEWAY_UNAVAILABLE' })
      expect(String(error)).not.toContain('synthetic-secret')
      expect(JSON.stringify(error)).not.toContain('synthetic-secret')
      expect(error).not.toHaveProperty('cause')
    }
  })

  it.each([301, 302, 307, 308])('rejects redirects (%s) without following them', async (status) => {
    const send = vi.fn<EgressHttp['request']>().mockResolvedValue(response(status))
    await expect(controlRequest({ request: send }, request)).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('enforces the response bound and clears the deadline after success or rejection', async () => {
    vi.useFakeTimers()
    const send = vi.fn<EgressHttp['request']>()
    send.mockResolvedValueOnce(response(200, new Uint8Array(maxControlResponseBytes)))
    await controlRequest({ request: send }, request)
    expect(vi.getTimerCount()).toBe(0)
    send.mockResolvedValueOnce(response(200, new Uint8Array(maxControlResponseBytes + 1)))
    await expect(controlRequest({ request: send }, request)).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, -1, 0.5, 20_001, Infinity])(
    'rejects invalid deadlines before I/O (%s)',
    async (timeout) => {
      const send = vi.fn<EgressHttp['request']>()
      await expect(controlRequest({ request: send }, request, timeout)).rejects.toMatchObject({
        code: 'LLM_GATEWAY_UNAVAILABLE',
      })
      expect(send).not.toHaveBeenCalled()
    },
  )

  it('decodes JSON objects, including ordinary Unicode', () => {
    expect(decodeControlJson(encodeJson({ message: 'Привет' }))).toEqual({ message: 'Привет' })
  })

  it.each([
    encodeJson(['not an object']),
    encodeJson(null),
    new TextEncoder().encode('{"secret":"synthetic-secret"'),
    new TextEncoder().encode('{"__proto__":{}}'),
    Uint8Array.of(255),
    new Uint8Array(maxControlResponseBytes + 1),
  ])('rejects invalid control JSON without parser error details', (body) => {
    expect(decodeControlJson(body)).toBeNull()
  })
})
