import type { LlmBackend } from '@repo/domain'
import { llmBackends, zaiCodingBackend } from '@repo/llm-backends'
import { describe, expect, it } from 'vitest'

import {
  egressConfigFromEnv,
  llmConfigFromEnv,
  PRODUCTION_VAULT_CA_FILE,
  providerOrigins,
} from './llm-config.ts'

const complete = {
  LLM_GATEWAY_CLIENTS: '10.2.0.0/16,::1/128',
  LLM_GATEWAY_HOSTS: '10.2.0.1:8084',
  LLM_EGRESS_PROXY_URL: 'https://192.0.2.1',
  LLM_EGRESS_CA_FILE: '/run/raditi/llm/ca.pem',
  LLM_EGRESS_CLIENT_CERT_FILE: '/run/raditi/llm/client.pem',
  LLM_EGRESS_CLIENT_KEY_FILE: '/run/raditi/llm/key.pem',
}

describe('subscription gateway configuration', () => {
  it('defaults to a local listener and, without a proxy, to its own connections', () => {
    expect(llmConfigFromEnv({}, 'development')).toMatchObject({
      port: 8084,
      listenHost: '127.0.0.1',
      maxRequestsPerKey: 2,
      maxCallsPerKey30s: 20,
      maxCallsPerKey: 600,
      egress: { proxyUrl: null, upstreamCaFile: null, backendOrigins: new Map() },
      clients: [
        { address: '127.0.0.1', prefix: 32, family: 'ipv4' },
        { address: '172.16.0.0', prefix: 12, family: 'ipv4' },
      ],
      hosts: ['127.0.0.1:8084', 'host.docker.internal:8084'],
    })
  })

  it('goes without the egress node only to the origins whose adapters say they need none', () => {
    // Rule 1 of the platform: every other provider is reached through the node alone. The list
    // is the adapters' own; the role and its configuration name no provider.
    expect(
      llmBackends.flatMap((backend) =>
        backend.egress.filter((entry) => entry.direct === true).map((entry) => entry.origin),
      ),
    ).toEqual(['https://api.z.ai'])
  })

  it('serves in production without a proxy, and never with half of one', () => {
    const listener = {
      LLM_GATEWAY_CLIENTS: complete.LLM_GATEWAY_CLIENTS,
      LLM_GATEWAY_HOSTS: complete.LLM_GATEWAY_HOSTS,
    }
    const direct = { proxyUrl: null, upstreamCaFile: null, backendOrigins: new Map() }
    expect(llmConfigFromEnv(listener, 'production').egress).toEqual(direct)
    expect(egressConfigFromEnv({}, 'production')).toEqual(direct)
    expect(egressConfigFromEnv({}, 'development')).toEqual(direct)
    // What production forbids, it forbids on both paths: no fake origin, no other roots.
    for (const [name, value] of [
      ['LLM_BACKEND_URL_ZAI_CODING', 'https://localhost:9443'],
      ['LLM_UPSTREAM_CA_FILE', '/tmp/secret-ca.pem'],
      ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
      ['NODE_USE_SYSTEM_CA', '1'],
      ['NODE_USE_ENV_PROXY', '1'],
      ['SSL_CERT_FILE', '/tmp/secret-ca.pem'],
      ['SSL_CERT_DIR', '/tmp/secret-ca'],
      ['NODE_OPTIONS', '--use-system-ca'],
    ] as const)
      expect(() => llmConfigFromEnv({ ...listener, [name]: value }, 'production')).toThrow(name)
    // A stand points a direct origin at its loopback fake, with the fake's own CA.
    const stand = llmConfigFromEnv(
      {
        LLM_BACKEND_URL_ZAI_CODING: 'https://localhost:9443',
        LLM_UPSTREAM_CA_FILE: '/tmp/test-ca.pem',
      },
      'test',
    ).egress
    expect(stand).toEqual({
      proxyUrl: null,
      upstreamCaFile: '/tmp/test-ca.pem',
      backendOrigins: new Map([['https://api.z.ai', 'https://localhost:9443']]),
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
    ['LLM_MAX_CALLS_PER_KEY_30S', '0'],
    ['LLM_MAX_CALLS_PER_KEY_30S', '1001'],
    ['LLM_MAX_CALLS_PER_KEY_30S', '2.5'],
    ['LLM_MAX_CALLS_PER_KEY', '0'],
    ['LLM_MAX_CALLS_PER_KEY', '100001'],
    ['LLM_MAX_CALLS_PER_KEY', 'many'],
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

  it('reads the pace and the ceiling of the calls of one turn key', () => {
    expect(
      llmConfigFromEnv(
        { ...complete, LLM_MAX_CALLS_PER_KEY_30S: '40', LLM_MAX_CALLS_PER_KEY: '300' },
        'production',
      ),
    ).toMatchObject({ maxCallsPerKey30s: 40, maxCallsPerKey: 300 })
  })

  it('allows only loopback HTTPS fakes outside production', () => {
    const config = llmConfigFromEnv(
      {
        ...complete,
        LLM_BACKEND_URL_ZAI_CODING: 'https://localhost:9443',
        LLM_UPSTREAM_CA_FILE: '/tmp/test-ca.pem',
      },
      'test',
    )
    expect(config.egress?.backendOrigins.get('https://api.z.ai')).toBe('https://localhost:9443')
    expect(config.egress?.upstreamCaFile).toBe('/tmp/test-ca.pem')
    expect(() =>
      llmConfigFromEnv(
        { ...complete, LLM_BACKEND_URL_ZAI_CODING: 'https://other.example' },
        'test',
      ),
    ).toThrow('LLM_BACKEND_URL_ZAI_CODING')
    // The name alone: TLS takes no IP address for a server name, so such an override could
    // never carry a request, with a proxy or without one.
    for (const address of ['https://127.0.0.1:9443', 'https://[::1]:9443'])
      for (const egress of [complete, {}])
        expect(() =>
          llmConfigFromEnv({ ...egress, LLM_BACKEND_URL_ZAI_CODING: address }, 'test'),
        ).toThrow('LLM_BACKEND_URL_ZAI_CODING: must be an HTTPS origin on localhost')
  })

  it('takes the provider origins and their stand overrides from what the adapters declare', () => {
    expect(llmBackends).toEqual([zaiCodingBackend])
    expect(providerOrigins).toEqual(
      llmBackends.flatMap((backend) => backend.egress.map((entry) => entry.origin)),
    )
    expect(providerOrigins).toEqual(['https://api.z.ai'])
    // Every declared origin can be pointed at a loopback fake on a stand: each by the variable
    // its adapter names, in the order of the adapters. The second adapter is a synthetic one.
    const other: LlmBackend = {
      ...zaiCodingBackend,
      egress: [
        {
          origin: 'https://provider.invalid',
          overrideEnv: 'LLM_BACKEND_URL_SYNTHETIC',
          requests: ['POST https://provider.invalid/v1/generate'],
        },
      ],
    }
    const backends = [other, zaiCodingBackend]
    const env = Object.fromEntries(
      backends
        .flatMap((backend) => backend.egress)
        .map((entry, index) => [entry.overrideEnv, `https://localhost:${9443 + index}`]),
    )
    expect(Object.keys(env)).toEqual(['LLM_BACKEND_URL_SYNTHETIC', 'LLM_BACKEND_URL_ZAI_CODING'])
    expect([
      ...llmConfigFromEnv({ ...complete, ...env }, 'test', backends).egress!.backendOrigins,
    ]).toEqual([
      ['https://provider.invalid', 'https://localhost:9443'],
      ['https://api.z.ai', 'https://localhost:9444'],
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
      ...zaiCodingBackend,
      egress: [
        {
          origin: 'https://provider.invalid',
          overrideEnv: 'LLM_BACKEND_URL_SYNTHETIC',
          requests: ['POST https://provider.invalid/v1/generate'],
        },
      ],
    }
    const env = { ...complete, LLM_BACKEND_URL_SYNTHETIC: 'https://localhost:9443' }
    expect([...llmConfigFromEnv(env, 'test', [adapter]).egress!.backendOrigins]).toEqual([
      ['https://provider.invalid', 'https://localhost:9443'],
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
    ).toThrow('LLM_BACKEND_URL_SYNTHETIC: must be an HTTPS origin on localhost')
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
    // Half a proxy is a mistake in every environment, never a silent direct path.
    for (const name of Object.keys(egress))
      for (const appEnv of ['development', 'production'] as const)
        expect(() => egressConfigFromEnv({ ...egress, [name]: '' }, appEnv)).toThrow(
          'LLM_EGRESS_PROXY_URL',
        )
    for (const [name, value] of [
      ['LLM_BACKEND_URL_ZAI_CODING', 'https://localhost:9443'],
      ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
      ['NODE_USE_ENV_PROXY', '1'],
      ['SSL_CERT_FILE', '/tmp/secret-ca.pem'],
      ['SSL_CERT_DIR', '/tmp/secret-ca'],
    ] as const)
      expect(() => egressConfigFromEnv({ ...egress, [name]: value }, 'production')).toThrow(name)
    expect(llmConfigFromEnv(complete, 'production').egress).toEqual(
      egressConfigFromEnv(complete, 'production'),
    )
  })

  it.each([
    ['LLM_UPSTREAM_CA_FILE', '/tmp/secret-ca.pem'],
    ['LLM_BACKEND_URL_ZAI_CODING', 'https://localhost:9443'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '1'],
    ['NODE_USE_SYSTEM_CA', '1'],
    // What the live profile of the stands refuses beside them (infra/dev/llm-verify/live.mjs):
    // a proxy of the environment under the role's own requests, and the CA files of OpenSSL.
    ['NODE_USE_ENV_PROXY', '1'],
    ['SSL_CERT_FILE', '/tmp/secret-ca.pem'],
    ['SSL_CERT_DIR', '/tmp/secret-ca'],
    ['NODE_OPTIONS', '--use-system-ca'],
    ['NODE_OPTIONS', '--use-openssl-ca'],
  ])('rejects production trust or origin override %s', (name, value) => {
    const refused = () => llmConfigFromEnv({ ...complete, [name]: value }, 'production')
    expect(refused).toThrow(name)
    // The refusal names the variable, never what it was set to.
    expect(refused).not.toThrow(/secret-ca|localhost:9443/)
    // Outside production a stand sets what it needs; an empty value switches nothing.
    expect(() => llmConfigFromEnv({ [name]: value }, 'test')).not.toThrow()
    if (name !== 'NODE_OPTIONS')
      expect(() => llmConfigFromEnv({ ...complete, [name]: ' ' }, 'production')).not.toThrow()
  })

  it('takes one extra CA in production: the CA of Vault at the path the app VM pins', () => {
    // The profile of the app VM gives the role this variable for Vault (infra/app): provider
    // TLS never reads it, the transport verifies against the bundled roots alone.
    const pinned = { ...complete, NODE_EXTRA_CA_CERTS: PRODUCTION_VAULT_CA_FILE }
    expect(llmConfigFromEnv(pinned, 'production')).toEqual(llmConfigFromEnv(complete, 'production'))
    for (const value of [
      '/tmp/another-ca.pem',
      '/run/raditi/egress-ca.pem',
      `${PRODUCTION_VAULT_CA_FILE} `,
      `${PRODUCTION_VAULT_CA_FILE}/../vault-ca.pem`,
      'vault-ca.pem',
      ' ',
    ]) {
      const env = { ...complete, NODE_EXTRA_CA_CERTS: value }
      expect(() => llmConfigFromEnv(env, 'production')).toThrow('NODE_EXTRA_CA_CERTS')
      // The refusal names the variable, never the path it was given.
      expect(() => llmConfigFromEnv(env, 'production')).not.toThrow(/another-ca|egress-ca/)
      // The rule is the role's: a command of the operator runs wherever the operator keeps the
      // CA of Vault, and reaches the provider through the same transport as the role.
      expect(egressConfigFromEnv(env, 'production')).toEqual(
        egressConfigFromEnv(complete, 'production'),
      )
    }
    // Node ignores an empty value, and so does the role.
    expect(() =>
      llmConfigFromEnv({ ...complete, NODE_EXTRA_CA_CERTS: '' }, 'production'),
    ).not.toThrow()
    // Outside production a stand names its own CA for its own Vault and Gitea.
    for (const appEnv of ['development', 'test'] as const)
      expect(() =>
        llmConfigFromEnv({ NODE_EXTRA_CA_CERTS: '/tmp/stand/ca.pem' }, appEnv),
      ).not.toThrow()
  })
})
