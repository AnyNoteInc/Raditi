import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { envVar, parseEnv } from './env.ts'

const schema = z
  .object({
    PORT: envVar(z.coerce.number().int().default(8081)),
    SECRET: envVar(z.string().min(8)),
  })
  .superRefine((env, ctx) => {
    if (env.PORT === 1) ctx.addIssue({ code: 'custom', message: 'port 1 is reserved' })
  })

describe('envVar', () => {
  it('treats blank values as unset, so defaults apply', () => {
    for (const PORT of [undefined, '', '  ']) {
      expect(parseEnv('test', schema, { PORT, SECRET: 'long-enough' }).PORT).toBe(8081)
    }
    expect(parseEnv('test', schema, { PORT: '9000', SECRET: 'long-enough' }).PORT).toBe(9000)
  })
})

describe('parseEnv', () => {
  it('lists every problem with its variable, never the value', () => {
    let message = ''
    try {
      parseEnv('demo', schema, { PORT: 'http', SECRET: 'hunter2' })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toMatch(/^\[demo\] invalid configuration: PORT: [^;]+; SECRET: [^;]+$/)
    expect(message).not.toMatch(/hunter2|http/)
  })

  it('prints an issue without a path as its message alone', () => {
    expect(() => parseEnv('demo', schema, { PORT: '1', SECRET: 'long-enough' })).toThrow(
      '[demo] invalid configuration: port 1 is reserved',
    )
  })
})
