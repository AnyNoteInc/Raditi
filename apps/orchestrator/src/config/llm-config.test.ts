import type { LlmBackend } from '@repo/domain'
import { codexBackend, kimiCodeBackend, llmBackends, zaiCodingBackend } from '@repo/llm-backends'
import { describe, expect, it } from 'vitest'

import { egressConfigFromEnv, llmConfigFromEnv, providerOrigins } from './llm-config.ts'

const complete = {
  LLM_GATEWAY_CLIENTS: '10.2.0.0/16,::1/128',
  LLM_GATEWAY_HOSTS: '10.2.0.1:8084',
  LLM_EGRESS_PROXY_URL: 'https://192.0.2.1',
  LLM_EGRESS_CA_FILE: '/run/raditi/llm/ca.pem',
  LLM_EGRESS_CLIENT_CERT_FILE: '/run/raditi/llm/client.pem',
  LLM_EGRESS_CLIENT_KEY_FILE: '/run/raditi/llm/key.pem',
}

describe('subscription gateway configuration', () => {
  it('defaults to a local listener and disables outgoing requests without a proxy', () => {
    expect(llmConfigFromEnv({}, 'development')).toMatchObject({
      port: 8084,
      listenHost: '127.0.0.1',
      maxRequestsPerKey: 2,
      egress: null,
      clients: [
        { address: '127.0.0.1', prefix: 32, family: 'ipv4' },
        { address: '172.16.0.0', prefix: 12, family: 'ipv4' },
      ],
      hosts: ['127.0.0.1:8084', 'host.docker.internal:8084'],
    })
  })

  it('requires explicit production allowlists and a complete mTLS proxy group', () => {
    expect(() => llmConfigFromEnv({}, 'production')).toThrow('LLM_GATEWAY_CLIENTS')
    // Parsed once: the listener takes these ranges as they are.
    expect(llmConfigFromEnv(complete, 'production')).toMatchObject({
      listenHost: '0.0.0.0',
      clients: [
        { address: '10.2.0.0', prefix: 16, family: 'ipv4' },
        { address: '::1', prefix: 128, family: 'ipv6' },
      ],
    })
    for (const name of Object.keys(complete)) {
      const env = { ...complete, [name]: '' }
      expect(() => llmConfigFromEnv(env, 'production')).toThrow(name)
    }
  })

  it.each([
    ['LLM_GATEWAY_PORT', '0'],
    ['LLM_GATEWAY_PORT', '65536'],
    ['LLM_MAX_REQUESTS_PER_KEY', '3'],
    ['LLM_GATEWAY_LISTEN_HOST', 'localhost'],
    ['LLM_GATEWAY_CLIENTS', 'localhost/32'],
    ['LLM_GATEWAY_CLIENTS', '10.0.0.1/33'],
    ['LLM_GATEWAY_CLIENTS', '::1/129'],
    ['LLM_GATEWAY_CLIENTS', '127.0.0.1/32,'],
    ['LLM_GATEWAY_HOSTS', 'http://private.test:8084'],
    ['LLM_GATEWAY_HOSTS', 'private.test:8084/path'],
    ['LLM_EGRESS_PROXY_URL', 'http://192.0.2.1'],
    ['LLM_EGRESS_PROXY_URL', 'https://secret:token@example.test'],
    ['LLM_EGRESS_PROXY_URL', 'https://example.test/path'],
    ['LLM_EGRESS_PROXY_URL', 'https://example.test/?secret=token'],
    ['LLM_EGRESS_CA_FILE', 'relative.pem'],
  ])('rejects invalid %s without exposing its value', (name, value) => {
    let error: unknown
    try {
      llmConfigFromEnv({ ...complete, [name]: value }, 'test')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(name)
    if (value.length > 5) expect((error as Error).message).not.toContain(value)
  })

  it('allows only loopback HTTPS fakes outside production', () => {
    const config = llmConfigFromEnv(
      {
        ...complete,
        LLM_BACKEND_URL_OPENAI_CHATGPT: 'https://localhost:9443',
        LLM_UPSTREAM_CA_FILE: '/tmp/test-ca.pem',
      },
      'test',
    )
    expect(config.egress?.backendOrigins.get('https://chatgpt.com')).toBe('https://localhost:9443')
    expect(config.egress?.upstreamCaFile).toBe('/tmp/test-ca.pem')
    expect(() =>
      llmConfigFromEnv({ ...complete, LLM_BACKEND_URL_KIMI_CODE: 'https://other.example' }, 'test'),
    ).toThrow('LLM_BACKEND_URL_KIMI_CODE')
  })

  it('takes the provider origins and their stand overrides from what the adapters declare', () => {
    expect(llmBackends).toEqual([codexBackend, kimiCodeBackend, zaiCodingBackend])
    expect(providerOrigins).toEqual(
      llmBackends.flatMap((backend) => backend.egress.map((entry) => entry.origin)),
    )
    expect(providerOrigins).toEqual([
      'https://chatgpt.com',
      'https://auth.openai.com',
      'https://api.kimi.ai',
      'https://api.z.ai',
    ])
    // Every declared origin can be pointed at a loopback fake on a stand, as before.
    const env = Object.fromEntries(
      llmBackends
        .flatMap((backend) => backend.egress)
        .map((entry, index) => [entry.overrideEnv, `https://localhost:${9443 + index}`]),
    )
    expect(Object.keys(env)).toEqual([
      'LLM_BACKEND_URL_OPENAI_CHATGPT',
      'LLM_AUTH_URL_OPENAI',
      'LLM_BACKEND_URL_KIMI_CODE',
      'LLM_BACKEND_URL_ZAI_CODING',
    ])
    expect([...llmConfigFromEnv({ ...complete, ...env }, 'test').egress!.backendOrigins]).toEqual([
      ['https://chatgpt.com', 'https://localhost:9443'],
      ['https://auth.openai.com', 'https://localhost:9444'],
      ['https://api.kimi.ai', 'https://localhost:9445'],
      ['https://api.z.ai', 'https://localhost:9446'],
    ])
  })

  it('points the Z.ai origin at a loopback fake of a stand and nowhere else', () => {
    const fake = { ...complete, LLM_BACKEND_URL_ZAI_CODING: 'https://localhost:9443' }
    expect(llmConfigFromEnv(fake, 'test').egress?.backendOrigins.get('https://api.z.ai')).toBe(
      'https://localhost:9443',
    )
    for (const value of ['https://api.z.ai.example', 'http://localhost:9443', 'https://10.0.0.1'])
      expect(() =>
        llmConfigFromEnv({ ...complete, LLM_BACKEND_URL_ZAI_CODING: value }, 'test'),
      ).toThrow('LLM_BACKEND_URL_ZAI_CODING')
    expect(() => llmConfigFromEnv(fake, 'production')).toThrow(
      'LLM_BACKEND_URL_ZAI_CODING: forbidden in production',
    )
    // The plan key is no setting of the role: it comes from Vault, never from the environment.
    const withKey = llmConfigFromEnv({ ...complete, ZAI_API_KEY: 'synthetic-zai-plan-key' }, 'test')
    expect(JSON.stringify(withKey)).not.toContain('synthetic-zai-plan-key')
    expect(withKey).toEqual(llmConfigFromEnv(complete, 'test'))
  })

  it('reads the override of an adapter it has never heard of, and refuses it in production', () => {
    const adapter: LlmBackend = {
      ...kimiCodeBackend,
      egress: [
        {
          origin: 'https://provider.invalid',
          overrideEnv: 'LLM_BACKEND_URL_SYNTHETIC',
          requests: ['POST https://provider.invalid/v1/generate'],
        },
      ],
    }
    const env = { ...complete, LLM_BACKEND_URL_SYNTHETIC: 'https://127.0.0.1:9443' }
    expect([...llmConfigFromEnv(env, 'test', [adapter]).egress!.backendOrigins]).toEqual([
      ['https://provider.invalid', 'https://127.0.0.1:9443'],
    ])
    expect([...egressConfigFromEnv(env, 'test', [adapter])!.backendOrigins]).toHaveLength(1)
    // Not declared by the adapters in use: the variable means nothing.
    expect(llmConfigFromEnv(env, 'test').egress!.backendOrigins.size).toBe(0)
    expect(() => llmConfigFromEnv(env, 'production', [adapter])).toThrow(
      'LLM_BACKEND_URL_SYNTHETIC: forbidden in production',
    )
    expect(() =>
      llmConfigFromEnv(
        { ...complete, LLM_BACKEND_URL_SYNTHETIC: 'https://other.example' },
        'test',
        [adapter],
      ),
    ).toThrow('LLM_BACKEND_URL_SYNTHETIC: must be a loopback HTTPS origin')
    // A declaration the transport could read too widely stops the configuration.
    const broken = {
      ...adapter,
      egress: [{ ...adapter.egress[0]!, origin: 'http://provider.invalid' }],
    }
    expect(() => llmConfigFromEnv(complete, 'test', [broken])).toThrow()
  })

  it('gives operator commands the egress channel without the listener of the llm role', () => {
    const egress = {
      LLM_EGRESS_PROXY_URL: complete.LLM_EGRESS_PROXY_URL,
      LLM_EGRESS_CA_FILE: complete.LLM_EGRESS_CA_FILE,
      LLM_EGRESS_CLIENT_CERT_FILE: complete.LLM_EGRESS_CLIENT_CERT_FILE,
      LLM_EGRESS_CLIENT_KEY_FILE: complete.LLM_EGRESS_CLIENT_KEY_FILE,
    }
    // Neither the gateway allowlists nor its port concern a login.
    expect(
      egressConfigFromEnv({ ...egress, LLM_GATEWAY_PORT: 'not-a-port' }, 'production'),
    ).toMatchObject({
      proxyUrl: new URL('https://192.0.2.1'),
      caFile: '/run/raditi/llm/ca.pem',
      upstreamCaFile: null,
    })
    expect(egressConfigFromEnv({}, 'development')).toBeNull()
    expect(() => egressConfigFromEnv({}, 'production')).toThrow('LLM_EGRESS_PROXY_URL')
    for (const [name, value] of [
      ['LLM_BACKEND_URL_KIMI_CODE', 'https://localhost:9443'],
      ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ] as const)
      expect(() => egressConfigFromEnv({ ...egress, [name]: value }, 'production')).toThrow(name)
    expect(llmConfigFromEnv(complete, 'production').egress).toEqual(
      egressConfigFromEnv(complete, 'production'),
    )
  })

  it.each([
    ['LLM_UPSTREAM_CA_FILE', '/tmp/secret-ca.pem'],
    ['LLM_BACKEND_URL_OPENAI_CHATGPT', 'https://localhost:9443'],
    ['LLM_AUTH_URL_OPENAI', 'https://localhost:9443'],
    ['LLM_BACKEND_URL_KIMI_CODE', 'https://localhost:9443'],
    ['LLM_BACKEND_URL_ZAI_CODING', 'https://localhost:9443'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '1'],
    ['NODE_USE_SYSTEM_CA', '1'],
    ['NODE_OPTIONS', '--use-system-ca'],
    ['NODE_OPTIONS', '--use-openssl-ca'],
  ])('rejects production trust or origin override %s', (name, value) => {
    expect(() => llmConfigFromEnv({ ...complete, [name]: value }, 'production')).toThrow(name)
  })
})
