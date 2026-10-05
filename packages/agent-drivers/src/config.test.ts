import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { agentDriverConfigFromEnv, parseAgentDriverConfig } from './config.ts'

const digest = 'a'.repeat(64)
const dev = { APP_ENV: 'development' }
// What an operator starts from: SANDBOX_IMAGE exactly as the example env files carry it.
const placeholders = ['../../../.env.example', '../../../infra/app/env.example'].map((file) => {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8')
  const value = /^SANDBOX_IMAGE=(\S+)$/m.exec(text)?.[1]
  if (!value) throw new Error(`${file} carries no SANDBOX_IMAGE`)
  return value
})

describe('agent driver configuration', () => {
  it.each(['raditi/sbx-wordpress', 'registry.raditi.local:3300/raditi/sbx-wordpress'])(
    'reads the shared digest-pinned stack image from %s',
    (repository) => {
      const image = `${repository}@sha256:${digest}`
      expect(agentDriverConfigFromEnv({ ...dev, SANDBOX_IMAGE: image })).toEqual({ image })
      expect(parseAgentDriverConfig({ image })).toEqual({ image })
    },
  )

  it('requires an image; a blank value counts as unset', () => {
    for (const env of [{}, { SANDBOX_IMAGE: '' }, { SANDBOX_IMAGE: '  ' }])
      expect(() => agentDriverConfigFromEnv({ ...dev, ...env })).toThrow(
        '[agent drivers] invalid configuration: SANDBOX_IMAGE:',
      )
  })

  it('does not fall back to the former repository prefix', () => {
    expect(() =>
      agentDriverConfigFromEnv({ ...dev, SANDBOX_IMAGE_PREFIX: 'raditi/agent' }),
    ).toThrow('[agent drivers] invalid configuration: SANDBOX_IMAGE:')
  })

  it.each([
    'raditi/sbx-wordpress',
    'raditi/sbx-wordpress:latest',
    `raditi/sbx-wordpress:latest@sha256:${digest}`,
    'raditi/sbx-wordpress@sha256:abc',
    `Raditi/Agent@sha256:${digest}`,
    `raditi//agent@sha256:${digest}`,
    `host:3300@sha256:${digest}`,
    `/agent@sha256:${digest}`,
    `raditi/agent@sha256:${'A'.repeat(64)}`,
    `raditi/${'a'.repeat(450)}@sha256:${digest}`,
  ])('rejects the image %s, from env and when passed directly', (image) => {
    expect(() => agentDriverConfigFromEnv({ ...dev, SANDBOX_IMAGE: image })).toThrow(
      /SANDBOX_IMAGE/,
    )
    expect(() => parseAgentDriverConfig({ image })).toThrow(/Invalid agent driver configuration/)
  })

  it.each(placeholders)(
    'refuses the placeholder of the example env files in production: %s',
    (placeholder) => {
      for (const APP_ENV of ['development', 'test'])
        expect(agentDriverConfigFromEnv({ APP_ENV, SANDBOX_IMAGE: placeholder })).toEqual({
          image: placeholder,
        })
      expect(() =>
        agentDriverConfigFromEnv({ APP_ENV: 'production', SANDBOX_IMAGE: placeholder }),
      ).toThrow(
        '[agent drivers] invalid configuration: SANDBOX_IMAGE: the all-zero digest is the env.example placeholder',
      )
      const real = `${placeholder.slice(0, placeholder.indexOf('@'))}@sha256:${digest}`
      expect(agentDriverConfigFromEnv({ APP_ENV: 'production', SANDBOX_IMAGE: real })).toEqual({
        image: real,
      })
    },
  )

  it('requires APP_ENV: a missing one must not switch the production check off', () => {
    for (const env of [{}, { APP_ENV: 'prod' }])
      expect(() =>
        agentDriverConfigFromEnv({ ...env, SANDBOX_IMAGE: `raditi/agent@sha256:${digest}` }),
      ).toThrow('[agent drivers] invalid configuration: APP_ENV:')
  })
})
