import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { ExecFrames } from './exec.ts'

const frame = (stream: 1 | 2, value: string) => {
  const body = Buffer.from(value)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

describe('exec frames', () => {
  it('keeps stdout and stderr apart across chunk borders', () => {
    const frames = new ExecFrames(64, 64)
    const bytes = Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, 'put')])
    for (let offset = 0; offset < bytes.length; offset += 5)
      frames.push(bytes.subarray(offset, offset + 5))
    const output = frames.finish()
    expect(output.stdout.toString()).toBe('output')
    expect(output.stderr.toString()).toBe('err')
  })

  it('fails over either limit, on a foreign frame and on a cut frame', () => {
    expect(() => new ExecFrames(2, 64).push(frame(1, 'abc'))).toThrow()
    expect(() => new ExecFrames(64, 2).push(frame(2, 'abc'))).toThrow()
    expect(() => new ExecFrames(64, 64).push(Buffer.from([3, 0, 0, 0, 0, 0, 0, 1, 65]))).toThrow()
    const cut = new ExecFrames(64, 64)
    cut.push(frame(1, 'abc').subarray(0, 9))
    expect(() => cut.finish()).toThrow()
  })
})
