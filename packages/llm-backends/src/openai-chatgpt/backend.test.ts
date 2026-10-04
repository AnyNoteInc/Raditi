import {
  llmEgressOriginSchema,
  type EgressHttp,
  type EgressRequest,
  type LlmRoute,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'
import { encodeJson } from '../shared.ts'
import { codexBackend } from './backend.ts'
import { syntheticCodexCredential } from './fixtures/auth.ts'

describe('Codex backend transport boundary', () => {
  const route = { method: 'POST', path: '/codex/responses' } as const
  const body = { body: new Uint8Array(), estInputTokens: 0 }
  const identity = { installationId: 'stable-account-installation' }

  it('exposes only the generation route, never control or WebSocket routes', () => {
    expect(codexBackend.id).toBe('openai-chatgpt')
    expect(codexBackend.routes).toEqual([route])
    expect(codexBackend.login).toBeDefined()
    expect(codexBackend.refresh).toBeTypeOf('function')
    expect(codexBackend.revoke).toBeTypeOf('function')
  })

  it('declares every request it sends, so the egress can refuse all others', async () => {
    expect(codexBackend.egress).toEqual([
      {
        origin: 'https://chatgpt.com',
        overrideEnv: 'LLM_BACKEND_URL_OPENAI_CHATGPT',
        requests: [
          'POST https://chatgpt.com/backend-api/codex/responses',
          'GET https://chatgpt.com/backend-api/wham/usage',
        ],
      },
      {
        origin: 'https://auth.openai.com',
        overrideEnv: 'LLM_AUTH_URL_OPENAI',
        requests: [
          'POST https://auth.openai.com/oauth/token',
          'POST https://auth.openai.com/oauth/revoke',
          'POST https://auth.openai.com/api/accounts/deviceauth/usercode',
          'POST https://auth.openai.com/api/accounts/deviceauth/token',
        ],
      },
    ])
    for (const entry of codexBackend.egress)
      expect(llmEgressOriginSchema.safeParse(entry).success).toBe(true)
    // Every request the adapter builds is one of the declared ones.
    const sent: string[] = []
    const record = (request: Pick<EgressRequest, 'method' | 'url'>) =>
      sent.push(`${request.method} ${request.url}`)
    const http: EgressHttp = {
      request: vi.fn(async (request) => {
        record(request)
        return { status: 500, headers: new Headers(), body: encodeJson({}) }
      }),
    }
    const credential = syntheticCodexCredential()
    record(codexBackend.upstream(route, body, new Headers(), credential, identity) as EgressRequest)
    await codexBackend.probe(credential, identity, http).catch(() => undefined)
    await codexBackend.refresh!(credential, http)
    await codexBackend.revoke!(credential, http).catch(() => undefined)
    const login = codexBackend.login!
    record(login.start(identity))
    const state = login.parseStart(
      {
        status: 200,
        headers: new Headers(),
        body: encodeJson({ device_auth_id: 'synthetic-device', user_code: 'SYNTH-CODE' }),
      },
      new Date(),
    )
    record(login.poll(state))
    const exchange = login.parsePoll(
      {
        status: 200,
        headers: new Headers(),
        body: encodeJson({
          authorization_code: 'synthetic-code',
          code_verifier: 'synthetic-verifier',
          code_challenge: 'synthetic-challenge',
        }),
      },
      state,
      new Date(),
    )
    if (exchange.kind !== 'next') throw new Error('Missing code exchange request')
    record(exchange.request)
    const declared = codexBackend.egress.flatMap((entry) => entry.requests)
    expect(new Set(sent)).toEqual(new Set(declared))
  })

  it('declares the client and response headers the gateway may pass for it', () => {
    // The gateway admits no provider header by itself: these lists are its allowlist.
    expect(codexBackend.clientHeaders).toEqual([
      'user-agent',
      'originator',
      'session-id',
      'thread-id',
      'x-client-request-id',
      'x-openai-subagent',
      'x-codex-turn-state',
      'x-openai-internal-codex-responses-lite',
    ])
    expect(codexBackend.responseHeaders).toEqual(['x-codex-turn-state'])
    // Every header `upstream` copies from the client is a declared one.
    const client = new Headers(codexBackend.clientHeaders.map((name) => [name, 'true']))
    const sent = codexBackend.upstream(route, body, client, syntheticCodexCredential(), identity)
    for (const name of codexBackend.clientHeaders) expect(sent.headers.get(name)).toBe('true')
  })

  it('uses fixed URL and account headers, forwarding only the approved CLI headers', () => {
    const credential = syntheticCodexCredential()
    const client = new Headers({
      authorization: 'Bearer sandbox-key',
      'chatgpt-account-id': 'spoofed-account',
      'x-codex-installation-id': 'ephemeral-sandbox-installation',
      'accept-encoding': 'gzip',
      'content-type': 'application/javascript',
      'x-codex-turn-metadata': 'sensitive-path',
      'x-codex-window-id': 'untrusted-window',
      'x-codex-routing-hint': 'untrusted-route',
      cookie: 'secret-session-cookie',
      host: 'attacker.invalid',
      'x-forwarded-for': '1.2.3.4',
      'openai-organization': 'untrusted-org',
      'content-length': '9000',
      connection: 'upgrade',
      'user-agent': 'synthetic-codex',
      originator: 'codex_exec',
      'session-id': 'session',
      'thread-id': 'thread',
      'x-client-request-id': 'request',
      'x-openai-subagent': 'subagent',
      'x-codex-turn-state': 'turn-state',
    })
    const result = codexBackend.upstream(route, body, client, credential, identity)
    expect(result.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(result.method).toBe('POST')
    expect(Object.fromEntries(result.headers)).toEqual({
      authorization: `Bearer ${credential.accessToken}`,
      'chatgpt-account-id': credential.chatgptAccountId,
      'x-codex-installation-id': identity.installationId,
      'accept-encoding': 'identity',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': 'synthetic-codex',
      originator: 'codex_exec',
      'session-id': 'session',
      'thread-id': 'thread',
      'x-client-request-id': 'request',
      'x-openai-subagent': 'subagent',
      'x-codex-turn-state': 'turn-state',
    })
    expect(client.get('authorization')).toBe('Bearer sandbox-key')
  })

  it.each([
    ['true', 'true'],
    ['false', null],
    ['synthetic-private-value', null],
    ['true, false', null],
  ])('preserves only the exact Responses Lite opt-in %s', (value, expected) => {
    const result = codexBackend.upstream(
      route,
      body,
      new Headers({ 'x-openai-internal-codex-responses-lite': value! }),
      syntheticCodexCredential(),
      identity,
    )
    expect(result.headers.get('x-openai-internal-codex-responses-lite')).toBe(expected)
  })

  it.each([
    '/codex/responses/compact',
    '/codex/models',
    '/codex/wham/usage',
    '/codex/responses?redirect=other',
    '/kimi/v1/chat/completions',
  ])('rejects unsupported route %s at the builder too', (path) => {
    expect(() =>
      codexBackend.upstream(
        { method: 'POST', path } as LlmRoute,
        body,
        new Headers(),
        syntheticCodexCredential(),
        identity,
      ),
    ).toThrow('Unsupported subscription route')
  })

  it('rejects missing identity or malformed credentials without leaking any secret', () => {
    expect(() =>
      codexBackend.upstream(route, body, new Headers(), syntheticCodexCredential(), {}),
    ).toThrow('Invalid Codex client identity')
    expect(() =>
      codexBackend.upstream(
        route,
        body,
        new Headers(),
        { secret: 'synthetic-private-token' },
        identity,
      ),
    ).toThrow('Invalid Codex credential')
    expect(() =>
      codexBackend.upstream(route, body, new Headers(), syntheticCodexCredential(), {
        installationId: 'bad\r\nvalue',
      }),
    ).toThrow('Invalid Codex client identity')
  })
})
