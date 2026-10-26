import { describe, expect, it } from 'vitest'

import { gatewayConfigFromEnv } from './config.ts'

const env = {
  SANDBOX_GATEWAY_IMAGE: `raditi/proxy@sha256:${'a'.repeat(64)}`,
  SANDBOX_NETWORK_GUARD_IMAGE: `raditi/guard@sha256:${'b'.repeat(64)}`,
  SANDBOX_LLM_UPSTREAM: 'http://llm:8084',
  SANDBOX_MCP_UPSTREAM: 'http://mcp:8082',
}

describe('trusted gateway config', () => {
  it('permits disabled mode and a complete pinned configuration', () => {
    expect(gatewayConfigFromEnv({})).toBeUndefined()
    expect(
      gatewayConfigFromEnv(Object.fromEntries(Object.keys(env).map((key) => [key, ' ']))),
    ).toBeUndefined()
    expect(gatewayConfigFromEnv(env)?.llmUpstream).toBe('http://llm:8084')
  })
  it.each([
    'SANDBOX_GATEWAY_IMAGE',
    'SANDBOX_NETWORK_GUARD_IMAGE',
    'SANDBOX_LLM_UPSTREAM',
    'SANDBOX_MCP_UPSTREAM',
  ])('rejects an incomplete group without exposing values: %s', (key) => {
    let message = ''
    try {
      gatewayConfigFromEnv({ ...env, [key]: '' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(
      new RegExp(`^\\[sandbox gateway\\] invalid configuration: ${key}: [^;]+$`),
    )
    expect(message).not.toMatch(/llm:8084|mcp:8082|a{64}|b{64}/)
  })
  it.each([
    'http://user:synthetic@llm:8084',
    'http://llm:8084/v1',
    'http://llm:8084/?url=evil',
    'file:///tmp/a',
  ])('rejects credentials and configurable paths: %s', (url) => {
    expect(() => gatewayConfigFromEnv({ ...env, SANDBOX_LLM_UPSTREAM: url })).toThrow(
      /^\[sandbox gateway\] invalid configuration: SANDBOX_LLM_UPSTREAM: /,
    )
  })
  it('takes the platform subnets the client egress never reaches, and nothing but CIDR', () => {
    expect(gatewayConfigFromEnv(env)).not.toHaveProperty('egressRefusedSubnets')
    expect(
      gatewayConfigFromEnv({ ...env, SANDBOX_EGRESS_REFUSED_SUBNETS: ' ' }),
    ).not.toHaveProperty('egressRefusedSubnets')
    expect(
      gatewayConfigFromEnv({
        ...env,
        SANDBOX_EGRESS_REFUSED_SUBNETS: '84.201.128.0/18, 2a02:6b8:c00::/40',
      })?.egressRefusedSubnets,
    ).toEqual(['84.201.128.0/18', '2a02:6b8:c00::/40'])
    for (const bad of ['84.201.128.0', '84.201.128.0/33', 'example.ru/8', '10.0.0.0/08'])
      expect(() => gatewayConfigFromEnv({ ...env, SANDBOX_EGRESS_REFUSED_SUBNETS: bad })).toThrow(
        /SANDBOX_EGRESS_REFUSED_SUBNETS/,
      )
    // Alone it is no gateway: the subnets and the image of the host rules serve the previews and
    // the browser sessions too (docs/plan/58), the gateway's own variables turn it on.
    expect(
      gatewayConfigFromEnv({ SANDBOX_EGRESS_REFUSED_SUBNETS: '84.201.128.0/18' }),
    ).toBeUndefined()
    expect(
      gatewayConfigFromEnv({ SANDBOX_NETWORK_GUARD_IMAGE: env.SANDBOX_NETWORK_GUARD_IMAGE }),
    ).toBeUndefined()
    expect(() =>
      gatewayConfigFromEnv({ SANDBOX_GATEWAY_IMAGE: env.SANDBOX_GATEWAY_IMAGE }),
    ).toThrow(/SANDBOX_NETWORK_GUARD_IMAGE/)
  })
  it('requires the platform subnets in production, where every sandbox VM runs a gateway', () => {
    const production = { ...env, APP_ENV: 'production' }
    for (const subnets of [undefined, '', ' '])
      expect(() =>
        gatewayConfigFromEnv({ ...production, SANDBOX_EGRESS_REFUSED_SUBNETS: subnets }),
      ).toThrow(
        /^\[sandbox gateway\] invalid configuration: SANDBOX_EGRESS_REFUSED_SUBNETS: [^;]+$/,
      )
    expect(
      gatewayConfigFromEnv({ ...production, SANDBOX_EGRESS_REFUSED_SUBNETS: '84.201.128.0/18' })
        ?.egressRefusedSubnets,
    ).toEqual(['84.201.128.0/18'])
    // Outside production none is needed; without a gateway nothing is asked.
    expect(gatewayConfigFromEnv({ ...env, APP_ENV: 'development' })).toBeDefined()
    expect(gatewayConfigFromEnv({ APP_ENV: 'production' })).toBeUndefined()
  })
})
