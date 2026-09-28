import { describe, expect, it } from 'vitest'
import { appEnvSchema, isProduction } from './app-env.ts'

describe('appEnvSchema', () => {
  it('accepts the three environments', () => {
    for (const env of ['development', 'test', 'production']) {
      expect(appEnvSchema.parse(env)).toBe(env)
    }
  })

  it('rejects a missing or misspelt value instead of defaulting', () => {
    for (const env of [undefined, '', 'prod', 'Production']) {
      expect(appEnvSchema.safeParse(env).success).toBe(false)
    }
  })

  it('knows production', () => {
    expect(isProduction('production')).toBe(true)
    expect(isProduction('test')).toBe(false)
  })
})
