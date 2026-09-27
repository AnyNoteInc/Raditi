import { describe, expect, it } from 'vitest'
import { assertExecSpec, execCursorSchema, execSpecSchema } from './sandbox-provider.ts'

describe('sandbox exec boundary', () => {
  it('keeps independent stream cursors and refuses imprecise offsets', () => {
    expect(execCursorSchema.parse({ stdout: 50, stderr: 2 })).toEqual({ stdout: 50, stderr: 2 })
    for (const value of [1, { stdout: 1 }, { stdout: -1, stderr: 0 }, { stdout: 0.5, stderr: 0 }])
      expect(execCursorSchema.safeParse(value).success).toBe(false)
  })
  it('accepts literal arguments, including spaces and shell metacharacters', () => {
    expect(assertExecSpec({ argv: ['printf', '%s', 'a;$(exit 1)'], timeoutMs: 1000 }).argv).toEqual(
      ['printf', '%s', 'a;$(exit 1)'],
    )
  })
  it.each([
    { argv: [] },
    { argv: [''] },
    { argv: ['x\0y'] },
    { argv: Array(257).fill('a') },
    { argv: ['x', 'a'.repeat(128 * 1024 + 1)] },
    { timeoutMs: 0 },
    { timeoutMs: 20 * 60 * 1000 + 1 },
    { cwd: '/workspace/../etc' },
    { cwd: 'relative' },
    { env: { TOKEN: 'secret' } },
    { env: { URL: 'https://user:password@example.invalid' } },
    { privileged: true },
    { stdin: 'not a stream' },
  ])('rejects invalid specifications without disclosing their values: %o', (change) => {
    const spec = { argv: ['test'], timeoutMs: 1000, ...change }
    expect(execSpecSchema.safeParse(spec).success).toBe(false)
    expect(() => assertExecSpec(spec as never)).toThrow('Invalid sandbox exec specification')
  })
})
