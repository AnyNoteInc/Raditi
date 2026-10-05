import type { EgressResponse, LlmBackend } from '@repo/domain'
import { codexBackend, kimiCodeBackend } from '@repo/llm-backends'
import { describe, expect, it, vi } from 'vitest'

import {
  authenticateSubscription,
  saveIssuedCredential,
  UnsavedSubscriptionLogin,
} from './device-login.ts'

const start = 1_800_000_000_000
const identity = { deviceId: 'synthetic-device', deviceName: '4f9c2a7e1b3d' }
const response = (value: unknown, status = 200): EgressResponse => ({
  status,
  headers: new Headers(),
  body: Buffer.from(JSON.stringify(value)),
})
const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const tokens = () => ({
  access_token: jwt({ iat: start / 1000, exp: start / 1000 + 3600 }),
  id_token: jwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'synthetic-account',
      chatgpt_plan_type: 'plus',
    },
  }),
  refresh_token: 'synthetic-refresh',
})
const started = () =>
  response({ device_auth_id: 'synthetic-device-auth', user_code: 'synthetic-code', interval: 2 })
const exchange = () =>
  response({
    authorization_code: 'synthetic-authorization',
    code_verifier: 'synthetic-verifier',
    code_challenge: 'synthetic-challenge',
  })

function setup(backend = codexBackend) {
  let now = start
  const request = vi
    .fn()
    .mockResolvedValueOnce(started())
    .mockResolvedValueOnce(response({}, 404))
    .mockResolvedValueOnce(exchange())
    .mockResolvedValueOnce(response(tokens()))
  const wait = vi.fn(async (ms: number) => {
    now += ms
  })
  const showDeviceCode = vi.fn().mockResolvedValue(undefined)
  const readSecret = vi.fn().mockResolvedValue('synthetic-api-key')
  return {
    request,
    wait,
    showDeviceCode,
    readSecret,
    options: {
      backend,
      identity,
      http: { request },
      signal: new AbortController().signal,
      showDeviceCode,
      readSecret,
      now: () => now,
      wait,
    },
  }
}

describe('operator subscription authentication', () => {
  it('follows device polling intervals and performs exactly one code exchange', async () => {
    const { options, request, wait, showDeviceCode, readSecret } = setup()
    const credential = await authenticateSubscription(options)
    expect(credential.kind).toBe('chatgpt_oauth')
    expect(wait.mock.calls).toEqual([
      [2000, options.signal],
      [2000, options.signal],
    ])
    expect(request.mock.calls.map(([input]) => input.url)).toEqual([
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
      'https://auth.openai.com/api/accounts/deviceauth/token',
      'https://auth.openai.com/api/accounts/deviceauth/token',
      'https://auth.openai.com/oauth/token',
    ])
    expect(showDeviceCode).toHaveBeenCalledExactlyOnceWith({
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'synthetic-code',
    })
    expect(readSecret).not.toHaveBeenCalled()
    expect(request.mock.calls.every(([, option]) => option.signal instanceof AbortSignal)).toBe(
      true,
    )
  })
  it('does not replay an exchange after an ambiguous transport failure', async () => {
    const { options, request } = setup()
    request
      .mockReset()
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(exchange())
      .mockRejectedValueOnce(new Error('synthetic-refresh private-code'))
    await expect(authenticateSubscription(options)).rejects.toThrow(/^Subscription login failed$/)
    expect(request).toHaveBeenCalledTimes(3)
  })
  describe('a code exchange the provider may already have answered with tokens', () => {
    const deadline = start + 15 * 60_000

    it('keeps tokens whose exchange is answered after the device deadline', async () => {
      const { options, request } = setup()
      let now = start
      options.now = () => now
      options.wait.mockImplementation(async (ms: number) => {
        now += ms
      })
      request
        .mockReset()
        .mockResolvedValueOnce(started())
        .mockResolvedValueOnce(exchange())
        .mockImplementationOnce(async () => {
          now = deadline + 5_000
          return response(tokens())
        })
      expect((await authenticateSubscription(options)).kind).toBe('chatgpt_oauth')
    })

    it('bounds the exchange by its own timeout, not by the time left before the deadline', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout')
      try {
        const { options, request } = setup()
        let now = start
        options.now = () => now
        options.wait.mockImplementation(async () => {
          now = deadline - 3_000
        })
        request
          .mockReset()
          .mockResolvedValueOnce(started())
          .mockResolvedValueOnce(exchange())
          .mockResolvedValueOnce(response(tokens()))
        await authenticateSubscription(options)
        expect(request.mock.calls.at(-1)![0].url).toBe('https://auth.openai.com/oauth/token')
        expect(timeout.mock.calls.at(-1)).toEqual([20_000])
      } finally {
        timeout.mockRestore()
      }
    })

    it('lets an interrupted exchange finish and returns its tokens for the caller to revoke', async () => {
      const { options, request } = setup()
      const controller = new AbortController()
      options.signal = controller.signal
      let exchangeSignal: AbortSignal | undefined
      request
        .mockReset()
        .mockResolvedValueOnce(started())
        .mockResolvedValueOnce(exchange())
        .mockImplementationOnce(async (_input, { signal }: { signal: AbortSignal }) => {
          exchangeSignal = signal
          controller.abort()
          return response(tokens())
        })
      expect((await authenticateSubscription(options)).kind).toBe('chatgpt_oauth')
      expect(exchangeSignal?.aborted).toBe(false)
    })

    it('starts no exchange once the deadline has passed or the operator interrupted', async () => {
      for (const late of [true, false]) {
        const { options, request } = setup()
        const controller = new AbortController()
        options.signal = controller.signal
        let now = start
        options.now = () => now
        request
          .mockReset()
          .mockResolvedValueOnce(started())
          .mockImplementationOnce(async () => {
            if (late) now = deadline + 1
            else controller.abort()
            return exchange()
          })
        await expect(authenticateSubscription(options)).rejects.toThrow(
          /^Subscription login failed$/,
        )
        expect(request).toHaveBeenCalledTimes(2)
      }
    })
  })
  it('cancellation while waiting prevents another provider request', async () => {
    const { options, request } = setup()
    const controller = new AbortController()
    options.signal = controller.signal
    options.wait.mockImplementation(async () => {
      controller.abort()
    })
    await expect(authenticateSubscription(options)).rejects.toThrow('Subscription login failed')
    expect(request).toHaveBeenCalledOnce()
  })
  it('stops before a poll past the 15-minute device deadline', async () => {
    const { options, request } = setup()
    request.mockReset().mockResolvedValue(
      response({
        device_auth_id: 'synthetic-device-auth',
        user_code: 'synthetic-code',
        interval: 900,
      }),
    )
    await expect(authenticateSubscription(options)).rejects.toThrow('Subscription login failed')
    expect(request).toHaveBeenCalledOnce()
  })
  it('denial and malformed login payloads produce only safe text', async () => {
    for (const answer of [
      response({ secret: 'private-provider-body' }, 403),
      { status: 200, headers: new Headers(), body: Buffer.from('private-token not JSON') },
    ]) {
      const { options, request } = setup()
      request.mockReset().mockResolvedValueOnce(started()).mockResolvedValueOnce(answer)
      await expect(authenticateSubscription(options)).rejects.toThrow(/^Subscription login failed$/)
    }
  })
  it('imports a key through the adapter and probes it without generation', async () => {
    const { options, request, readSecret, showDeviceCode } = setup(kimiCodeBackend)
    request.mockReset().mockResolvedValue(response({ usages: { limit_5h: { used_ratio: 0.1 } } }))
    expect(await authenticateSubscription(options)).toEqual({
      v: '1',
      kind: 'kimi_api_key',
      apiKey: 'synthetic-api-key',
    })
    expect(readSecret).toHaveBeenCalledOnce()
    expect(showDeviceCode).not.toHaveBeenCalled()
    expect(request.mock.calls[0]![0].url).toBe('https://api.kimi.ai/coding/v1/usages')
    expect(request).toHaveBeenCalledOnce()
  })
  it.each([401, 403, 500, 200])('rejects an unconfirmed key probe (%i)', async (status) => {
    const { options, request } = setup(kimiCodeBackend)
    request.mockReset().mockResolvedValue(response({ private: 'secret' }, status))
    await expect(authenticateSubscription(options)).rejects.toThrow('Subscription login failed')
  })
  it('invalid secret input makes no HTTP call', async () => {
    const { options, request, readSecret } = setup(kimiCodeBackend)
    readSecret.mockResolvedValue('private\napi-key')
    await expect(authenticateSubscription(options)).rejects.toThrow('Subscription login failed')
    expect(request).not.toHaveBeenCalled()
  })
  it('an unsupported import method makes no HTTP call', async () => {
    const { options, request } = setup({
      ...kimiCodeBackend,
      importCredential: undefined,
    } as LlmBackend)
    await expect(authenticateSubscription(options)).rejects.toThrow('Subscription login failed')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('credentials issued before a failed save', () => {
  const credential = { v: '1', kind: 'synthetic' }
  const http = { request: vi.fn() }

  it('revokes them at the provider and keeps the original failure', async () => {
    const revoke = vi.fn(async () => undefined)
    const failure = new Error('Synthetic Vault outage')
    const save = vi.fn(async () => {
      throw failure
    })
    const error = await saveIssuedCredential({ backend: { revoke }, credential, http, save }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(UnsavedSubscriptionLogin)
    expect(error).toMatchObject({ failure, revoked: true })
    expect(revoke).toHaveBeenCalledExactlyOnceWith(credential, http)
  })

  it('reports a revocation that did not go through', async () => {
    const revoke = vi.fn(async () => {
      throw new Error('synthetic-refresh private-provider-body')
    })
    const error = await saveIssuedCredential({
      backend: { revoke },
      credential,
      http,
      save: async () => {
        throw new Error('Synthetic label conflict')
      },
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ revoked: false })
    expect(String((error as Error).message)).not.toContain('private')
  })

  it('does not revoke saved credentials, and has nothing to revoke for an imported key', async () => {
    const revoke = vi.fn(async () => undefined)
    expect(
      await saveIssuedCredential({ backend: { revoke }, credential, http, save: async () => 7 }),
    ).toBe(7)
    expect(revoke).not.toHaveBeenCalled()
    const failure = new Error('Synthetic failure')
    await expect(
      saveIssuedCredential({
        backend: {},
        credential,
        http,
        save: async () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
  })
})
