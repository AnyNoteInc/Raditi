import { describe, expect, it } from 'vitest'

import { agentDriverConfigFromEnv, parseAgentDriverConfig } from './config.ts'

describe('agent driver configuration', () => {
  it('reads SANDBOX_IMAGE_PREFIX, including a registry host with a port', () => {
    expect(agentDriverConfigFromEnv({ SANDBOX_IMAGE_PREFIX: 'raditi/agent' })).toEqual({
      imagePrefix: 'raditi/agent',
    })
    const prefix = 'registry.raditi.local:3300/raditi/agent'
    expect(agentDriverConfigFromEnv({ SANDBOX_IMAGE_PREFIX: prefix }).imagePrefix).toBe(prefix)
  })

  it('requires an image prefix; a blank value counts as unset', () => {
    for (const env of [{}, { SANDBOX_IMAGE_PREFIX: '' }, { SANDBOX_IMAGE_PREFIX: '  ' }])
      expect(() => agentDriverConfigFromEnv(env)).toThrow(
        '[agent drivers] invalid configuration: SANDBOX_IMAGE_PREFIX:',
      )
  })

  it.each([
    'raditi/agent:latest',
    'raditi/agent@sha256:abc',
    'Raditi/Agent',
    'raditi//agent',
    'host:3300',
    '/agent',
  ])('rejects the image prefix %s, from env and when passed directly', (prefix) => {
    expect(() => agentDriverConfigFromEnv({ SANDBOX_IMAGE_PREFIX: prefix })).toThrow(
      /SANDBOX_IMAGE_PREFIX/,
    )
    expect(() => parseAgentDriverConfig({ imagePrefix: prefix })).toThrow(
      /Invalid agent driver configuration/,
    )
  })
})
