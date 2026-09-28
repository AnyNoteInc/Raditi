import { describe, expect, it } from 'vitest'

import { gatewayConfigFromEnv } from './config.ts'

const env = {
  SANDBOX_GATEWAY_IMAGE: `raditi/proxy@sha256:${'a'.repeat(64)}`,
  SANDBOX_NETWORK_GUARD_IMAGE: `raditi/guard@sha256:${'b'.repeat(64)}`,
  SANDBOX_LLM_UPSTREAM: 'http://litellm:4000',
  SANDBOX_MCP_UPSTREAM: 'http://mcp:8082',
}

describe('trusted gateway config', () => {
  it('permits disabled mode and a complete pinned configuration', () => {
    expect(gatewayConfigFromEnv({})).toBeUndefined()
    expect(
      gatewayConfigFromEnv(Object.fromEntries(Object.keys(env).map((key) => [key, ' ']))),
    ).toBeUndefined()
    expect(gatewayConfigFromEnv(env)?.llmUpstream).toBe('http://litellm:4000')
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
    expect(message).not.toMatch(/litellm|mcp:8082|a{64}|b{64}/)
  })
  it.each([
    'http://user:synthetic@llm:4000',
    'http://llm:4000/v1',
    'http://llm:4000/?url=evil',
    'file:///tmp/a',
  ])('rejects credentials and configurable paths: %s', (url) => {
    expect(() => gatewayConfigFromEnv({ ...env, SANDBOX_LLM_UPSTREAM: url })).toThrow(
      /^\[sandbox gateway\] invalid configuration: SANDBOX_LLM_UPSTREAM: /,
    )
  })
})
