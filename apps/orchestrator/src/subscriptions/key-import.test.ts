import type { EgressResponse, LlmBackend } from '@repo/domain'
import { zaiCodingBackend } from '@repo/llm-backends'
import { describe, expect, it, vi } from 'vitest'

import { authenticateSubscription } from './key-import.ts'

const start = 1_800_000_000_000
const response = (value: unknown, status = 200): EgressResponse => ({
  status,
  headers: new Headers(),
  body: Buffer.from(JSON.stringify(value)),
})
// The quota answer of an active plan, in the form of the recorded ones (zai-coding fixtures).
const quota = () => {
  const window = (unit: number, number: number, usage: number, resetInMs: number) => ({
    type: 'CREDIT_LIMIT',
    unit,
    number,
    usage,
    currentValue: 20,
    remaining: usage - 21,
    percentage: 1,
    nextResetTime: Date.now() + resetInMs,
  })
  return response({
    code: 200,
    msg: 'Operation successful',
    success: true,
    data: {
      level: 'lite',
      limits: [window(3, 5, 2000, 3_600_000), window(6, 1, 10_000, 86_400_000)],
    },
  })
}

function setup(backend: LlmBackend = zaiCodingBackend) {
  let now = start
  const request = vi.fn().mockResolvedValue(quota())
  const readSecret = vi.fn().mockResolvedValue('synthetic-api-key')
  return {
    request,
    readSecret,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    options: {
      backend,
      http: { request },
      signal: new AbortController().signal,
      readSecret,
      now: () => now,
    },
  }
}

describe('operator subscription authentication', () => {
  it('imports a key through the adapter and probes it without generation', async () => {
    const { options, request, readSecret } = setup()
    expect(await authenticateSubscription(options)).toEqual({
      v: '1',
      kind: 'zai_api_key',
      apiKey: 'synthetic-api-key',
    })
    expect(readSecret).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]![0].url).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
    expect(request).toHaveBeenCalledOnce()
  })
  it.each([401, 403, 500, 200])('rejects an unconfirmed key probe (%i)', async (status) => {
    const { options, request } = setup()
    request.mockReset().mockResolvedValue(response({ private: 'secret' }, status))
    await expect(authenticateSubscription(options)).rejects.toThrow(/^Subscription login failed$/)
  })
  it('a transport failure that quotes the key produces only safe text', async () => {
    const { options, request } = setup()
    request.mockReset().mockRejectedValue(new Error('synthetic-api-key refused by private-proxy'))
    await expect(authenticateSubscription(options)).rejects.toThrow(/^Subscription login failed$/)
  })
  it('invalid secret input makes no HTTP call', async () => {
    const { options, request, readSecret } = setup()
    readSecret.mockResolvedValue('private\napi-key')
    await expect(authenticateSubscription(options)).rejects.toThrow('Subscription login failed')
    expect(request).not.toHaveBeenCalled()
  })
  it('an unsupported import method reads no key and makes no HTTP call', async () => {
    const { options, request, readSecret } = setup({
      ...zaiCodingBackend,
      importCredential: undefined,
    } as LlmBackend)
    await expect(authenticateSubscription(options)).rejects.toThrow('Subscription login failed')
    expect(readSecret).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it('sends nothing for a command interrupted before or while the key is typed', async () => {
    const before = setup()
    before.options.signal = AbortSignal.abort()
    await expect(authenticateSubscription(before.options)).rejects.toThrow(
      'Subscription login failed',
    )
    expect(before.readSecret).not.toHaveBeenCalled()
    const during = setup()
    const controller = new AbortController()
    during.options.signal = controller.signal
    during.readSecret.mockImplementation(async () => {
      controller.abort()
      return 'synthetic-api-key'
    })
    await expect(authenticateSubscription(during.options)).rejects.toThrow(
      'Subscription login failed',
    )
    expect(during.request).not.toHaveBeenCalled()
  })
  it('does not send a key typed in after the fifteen minutes of the command', async () => {
    const { options, request, readSecret, advance } = setup()
    readSecret.mockImplementation(async () => {
      advance(15 * 60_000)
      return 'synthetic-api-key'
    })
    await expect(authenticateSubscription(options)).rejects.toThrow('Subscription login failed')
    expect(request).not.toHaveBeenCalled()
  })
})
