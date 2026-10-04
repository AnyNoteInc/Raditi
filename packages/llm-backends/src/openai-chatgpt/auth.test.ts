import { credentialMetadataSchema, type EgressHttp, type EgressResponse } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { encodeJson } from '../shared.ts'
import { codexClientId, refreshCodexCredential, revokeCodexCredential } from './auth.ts'
import {
  codexCredentialMetadata,
  codexCredentialSchema,
  credentialFromTokens,
  readCodexCredential,
} from './credentials.ts'
import { syntheticCodexCredential, syntheticJwt } from './fixtures/auth.ts'
import { codexDeviceLogin as login } from './login.ts'

const now = new Date(1_790_726_400_000)
const credential = syntheticCodexCredential()
const response = (status: number, value: unknown): EgressResponse => ({
  status,
  body: encodeJson(value),
  headers: new Headers(),
})
const tokenReply = {
  access_token: credential.accessToken,
  refresh_token: credential.refreshToken,
  id_token: credential.idToken,
}
const send = (reply: EgressResponse) => vi.fn<EgressHttp['request']>().mockResolvedValue(reply)
const bodyOf = (body: Uint8Array | undefined): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
const startState = () =>
  login.parseStart(
    response(200, { device_auth_id: 'synthetic-device', user_code: 'ABCD-1234', interval: '5' }),
    now,
  )

afterEach(() => vi.useRealTimers())

describe('Codex credentials', () => {
  it('returns only provider-neutral metadata, without any token or email', () => {
    const metadata = codexCredentialMetadata(credential)
    expect(metadata).toEqual({
      externalAccountId: 'synthetic-account',
      plan: 'plus',
      accessIssuedAt: now,
      accessExpiresAt: new Date(credential.accessExpiresAt),
    })
    expect(credentialMetadataSchema.parse(metadata)).toEqual(metadata)
    expect(JSON.stringify(metadata)).not.toContain('Token')
  })

  it('accepts missing optional claims and preserves unknown dates', () => {
    const partial = syntheticCodexCredential({
      accessToken: syntheticJwt({}),
      accessExpiresAt: null,
      idToken: syntheticJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
      }),
    })
    expect(codexCredentialMetadata(partial)).toEqual({
      externalAccountId: 'synthetic-account',
      plan: null,
      accessIssuedAt: null,
      accessExpiresAt: null,
    })
  })

  it.each([
    { accessToken: 'synthetic-not-a-jwt' },
    { idToken: 'secret-invalid-json' },
    { refreshToken: 'secret\nheader' },
    { chatgptAccountId: 'another-account' },
    { accessExpiresAt: 'not-a-date' },
    { accessExpiresAt: now.toISOString() },
    { accessToken: syntheticJwt({ exp: -1 }) },
    { accessToken: syntheticJwt({ exp: '1790730000' }) },
    { accessToken: syntheticJwt({ exp: 1_790_730_000, iat: 1_790_730_001 }) },
    { accessToken: syntheticJwt({ exp: 1_790_730_000, iat: Number.MAX_SAFE_INTEGER }) },
    { v: '2' },
    {
      accessToken: syntheticJwt({
        exp: 1_790_730_000,
        'https://api.openai.com/auth': { chatgpt_account_id: 'different-account' },
      }),
    },
    { unexpected: 'synthetic-secret' },
  ])('rejects bad credentials without exposing values: %j', (patch) => {
    const invalid = syntheticCodexCredential(patch)
    expect(codexCredentialSchema.safeParse(invalid).success).toBe(false)
    expect(() => readCodexCredential(invalid)).toThrow('Invalid Codex credential')
    try {
      readCodexCredential(invalid)
    } catch (error) {
      expect(String(error)).not.toContain('secret')
      expect(JSON.stringify(error)).not.toContain('secret')
    }
  })

  it('validates expired credentials structurally so the caller can refresh them', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'))
    expect(codexCredentialSchema.safeParse(credential).success).toBe(true)
  })

  it('uses expires_in only when JWT expiry is unavailable', () => {
    const result = credentialFromTokens(
      { ...tokenReply, access_token: syntheticJwt({ iat: now.getTime() / 1000 }), expires_in: 120 },
      now,
    )
    expect(result?.accessExpiresAt).toBe(new Date(now.getTime() + 120_000).toISOString())
    expect(credentialFromTokens({ ...tokenReply, expires_in: 1 }, now)?.accessExpiresAt).toBe(
      credential.accessExpiresAt,
    )
  })
})

describe('Codex refresh and revoke', () => {
  it('merges a partial refresh, keeps account identity and sends the JSON grant once', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const request = send(response(200, { refresh_token: 'synthetic-rotated' }))
    const result = await refreshCodexCredential(credential, { request })
    expect(result).toEqual({
      kind: 'ok',
      credential: {
        ...credential,
        refreshToken: 'synthetic-rotated',
        refreshedAt: now.toISOString(),
      },
    })
    const [outgoing, options] = request.mock.calls[0]!
    expect(outgoing.url).toBe('https://auth.openai.com/oauth/token')
    expect(outgoing.method).toBe('POST')
    expect(outgoing.headers.get('content-type')).toBe('application/json')
    expect(outgoing.headers.get('originator')).toBe('codex_cli_rs')
    expect(bodyOf(outgoing.body)).toEqual({
      grant_type: 'refresh_token',
      client_id: codexClientId,
      refresh_token: credential.refreshToken,
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('extracts a changed plan from a new id_token at the single metadata boundary', async () => {
    const idToken = syntheticJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'synthetic-account',
        chatgpt_plan_type: 'free',
      },
    })
    const result = await refreshCodexCredential(credential, {
      request: send(response(200, { id_token: idToken })),
    })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(codexCredentialMetadata(result.credential).plan).toBe('free')
  })

  it.each([
    [400, { error: 'invalid_grant' }, 'auth'],
    [400, { error: { code: 'refresh_token_expired' } }, 'auth'],
    [400, { error: { code: 'refresh_token_reused' } }, 'auth'],
    [400, { error: { code: 'refresh_token_invalidated' } }, 'auth'],
    [401, { error: { code: 'anything' } }, 'auth'],
    [403, { error: { code: 'unsupported_country_region_territory' } }, 'region'],
  ] as const)('classifies a final structured rejection %s %j', async (status, body, reason) => {
    const request = send(response(status, body))
    expect(await refreshCodexCredential(credential, { request })).toEqual({ kind: 'final', reason })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    [429, { error: 'invalid_grant' }],
    [500, { error: 'refresh_token_reused' }],
    [403, { error: { code: 'unknown' } }],
    [400, { error: 'unknown' }],
    [401, {}],
    [200, { error: 'invalid_grant' }],
    [200, {}],
    [
      200,
      {
        access_token: syntheticJwt({
          exp: 1_790_730_000,
          'https://api.openai.com/auth': { chatgpt_account_id: 'different-account' },
        }),
      },
    ],
    [200, { access_token: null }],
    [200, { access_token: 'invalid-token' }],
    [
      200,
      {
        id_token: syntheticJwt({
          'https://api.openai.com/auth': { chatgpt_account_id: 'different-account' },
        }),
      },
    ],
  ] as const)('never retries ambiguous response %s %j', async (status, body) => {
    const request = send(response(status, body))
    expect(await refreshCodexCredential(credential, { request })).toEqual({ kind: 'ambiguous' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('treats HTML, transport errors and timeout as ambiguous, without token leakage or retries', async () => {
    const html = response(401, {})
    html.body = new TextEncoder().encode('<html>synthetic-secret</html>')
    expect(await refreshCodexCredential(credential, { request: send(html) })).toEqual({
      kind: 'ambiguous',
    })
    const failing = vi.fn<EgressHttp['request']>().mockRejectedValue(new Error('synthetic-secret'))
    expect(await refreshCodexCredential(credential, { request: failing })).toEqual({
      kind: 'ambiguous',
    })
    expect(failing).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()
    const stalled = vi.fn<EgressHttp['request']>().mockImplementation(() => new Promise(() => {}))
    const pending = refreshCodexCredential(credential, { request: stalled })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pending).toEqual({ kind: 'ambiguous' })
    expect(stalled).toHaveBeenCalledTimes(1)
    expect(stalled.mock.calls[0]![1].signal.aborted).toBe(true)
  })

  it('revokes the refresh token once and fails visibly on rejection', async () => {
    const request = send(response(200, {}))
    await revokeCodexCredential(credential, { request })
    expect(request.mock.calls[0]![0].url).toBe('https://auth.openai.com/oauth/revoke')
    expect(bodyOf(request.mock.calls[0]![0].body)).toEqual({
      token: credential.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: codexClientId,
    })
    expect(request).toHaveBeenCalledTimes(1)
    await expect(
      revokeCodexCredential(credential, {
        request: send(response(503, { error: 'synthetic-secret' })),
      }),
    ).rejects.toMatchObject({ code: 'LLM_GATEWAY_UNAVAILABLE' })
  })

  it('rejects invalid stored credentials before transport', async () => {
    const request = send(response(200, {}))
    await expect(
      refreshCodexCredential({ ...credential, refreshToken: '' }, { request }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      revokeCodexCredential({ ...credential, refreshToken: '' }, { request }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('Codex device login', () => {
  it('builds fixed endpoints and completes the authorization-code exchange without I/O', () => {
    const start = login.start({ installationId: 'synthetic-installation' })
    expect(start.url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode')
    expect(bodyOf(start.body)).toEqual({ client_id: codexClientId })
    const state = startState()
    expect(state.verificationUri).toBe('https://auth.openai.com/codex/device')
    expect(state.expiresAt.getTime() - now.getTime()).toBe(900_000)
    expect(state.intervalMs).toBe(5000)
    const poll = login.poll(state)
    expect(poll.url).toBe('https://auth.openai.com/api/accounts/deviceauth/token')
    expect(bodyOf(poll.body)).toEqual({
      device_auth_id: 'synthetic-device',
      user_code: 'ABCD-1234',
    })
    const next = login.parsePoll(
      response(200, {
        authorization_code: 'code+&=',
        code_challenge: 'challenge',
        code_verifier: 'verifier+&=',
      }),
      state,
      now,
    )
    expect(next.kind).toBe('next')
    if (next.kind !== 'next') throw new Error('expected exchange')
    expect(next.request.url).toBe('https://auth.openai.com/oauth/token')
    expect(next.request.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(new TextDecoder().decode(next.request.body))
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      client_id: codexClientId,
      code: 'code+&=',
      code_verifier: 'verifier+&=',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
    })
    expect(form.has('requested_token')).toBe(false)
    expect(() => login.poll(next.state)).toThrow('awaiting token exchange')
    const completedAt = new Date(now.getTime() + 10_000)
    expect(login.parsePoll(response(200, tokenReply), next.state, completedAt)).toEqual({
      kind: 'complete',
      credential: { ...credential, refreshedAt: completedAt.toISOString() },
    })
    expect(state.privateState).toEqual({ phase: 'poll', deviceAuthId: 'synthetic-device' })
  })

  it.each([403, 404])(
    'keeps provider pending status %s within the same bounded login',
    (status) => {
      const state = startState()
      expect(login.parsePoll(response(status, {}), state, now)).toEqual({
        kind: 'pending',
        intervalMs: 5000,
      })
      expect(login.parsePoll(response(status, {}), state, state.expiresAt)).toEqual({
        kind: 'denied',
      })
    },
  )

  it('keeps tokens the provider issued even when the exchange reply arrives after the deadline', () => {
    const state = startState()
    const next = login.parsePoll(
      response(200, {
        authorization_code: 'code',
        code_challenge: 'challenge',
        code_verifier: 'verifier',
      }),
      state,
      now,
    )
    if (next.kind !== 'next') throw new Error('expected exchange')
    // Discarding them here would leave a live refresh-token chain nobody stores or revokes.
    const late = new Date(state.expiresAt.getTime() + 5000)
    expect(login.parsePoll(response(200, tokenReply), next.state, late)).toEqual({
      kind: 'complete',
      credential: { ...credential, refreshedAt: late.toISOString() },
    })
    expect(login.parsePoll(response(400, {}), next.state, late)).toEqual({ kind: 'denied' })
    // The deadline still bounds polling: an approval that arrives late starts no exchange.
    expect(
      login.parsePoll(
        response(200, {
          authorization_code: 'code',
          code_challenge: 'challenge',
          code_verifier: 'verifier',
        }),
        state,
        late,
      ),
    ).toEqual({ kind: 'denied' })
  })

  it.each([400, 401, 429, 500])('ends login on non-pending rejection %s', (status) => {
    expect(
      login.parsePoll(response(status, { error: 'synthetic-secret' }), startState(), now),
    ).toEqual({ kind: 'denied' })
  })

  it('accepts the legacy usercode alias and safely defaults missing interval', () => {
    const state = login.parseStart(
      response(200, { device_auth_id: 'device', usercode: 'CODE' }),
      now,
    )
    expect(state.userCode).toBe('CODE')
    expect(state.intervalMs).toBe(5000)
  })

  it.each([0, -1, Infinity, 'nope', '0', 0.1, '901'])(
    'rejects invalid polling interval %j',
    (interval) => {
      expect(() =>
        login.parseStart(
          response(200, { device_auth_id: 'device', user_code: 'CODE', interval }),
          now,
        ),
      ).toThrow('Subscription gateway is unavailable')
    },
  )

  it('rejects malformed replies and tampered state without exposing private state or body', () => {
    expect(() => login.parseStart(response(200, { secret: 'synthetic-secret' }), now)).toThrow(
      'Subscription gateway is unavailable',
    )
    expect(() => login.parseStart(response(404, {}), now)).toThrow(
      'Subscription gateway is unavailable',
    )
    const state = startState()
    expect(() => login.poll({ ...state, verificationUri: 'https://attacker.invalid' })).toThrow(
      'Invalid Codex login state',
    )
    expect(() =>
      login.parsePoll(response(200, { authorization_code: 'synthetic-secret' }), state, now),
    ).toThrow('Subscription gateway is unavailable')
    expect(() => login.parsePoll(response(200, {}), state, new Date(NaN))).toThrow(
      'Invalid Codex login time',
    )
  })
})
