import { Buffer } from 'node:buffer'

import type { AgentDriver, AgentEvent, ExecChunk, ExecHandle } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { readTurnOutput } from './turn-output.ts'

const driver: Pick<AgentDriver, 'parseEvent'> = {
  parseEvent: (line: string) => [JSON.parse(line) as AgentEvent],
}
const handle = (chunks: ExecChunk[]): Pick<ExecHandle, 'output'> => ({
  output: async function* () {
    yield* chunks
  },
})

describe('bounded turn output', () => {
  it('decodes split UTF-8 and only acknowledges complete stdout lines', async () => {
    const bytes = Buffer.from(JSON.stringify({ type: 'message', text: 'Привет' }) + '\n')
    const split = bytes.indexOf(Buffer.from('П')) + 1
    const record = vi.fn(async () => {})
    const read = await readTurnOutput(
      handle([
        { stream: 'stdout', offset: 0, data: bytes.subarray(0, split) },
        { stream: 'stderr', offset: 0, data: Buffer.from('private raw error') },
        { stream: 'stdout', offset: split, data: bytes.subarray(split) },
      ]),
      driver,
      record,
      () => {},
    )
    expect(read.events).toEqual([{ type: 'message', text: 'Привет' }])
    expect(record).toHaveBeenNthCalledWith(1, { stdout: 0, stderr: 0 }, [])
    expect(record).toHaveBeenNthCalledWith(2, { stdout: 0, stderr: 17 }, [])
    expect(record).toHaveBeenLastCalledWith({ stdout: bytes.length, stderr: 17 }, read.events)
    expect(JSON.stringify(record.mock.calls)).not.toContain('private raw error')
  })

  it('accepts a final complete JSON line without a newline', async () => {
    const bytes = Buffer.from(JSON.stringify({ type: 'completed' }))
    const record = vi.fn(async () => {})
    const read = await readTurnOutput(
      handle([{ stream: 'stdout', offset: 0, data: bytes }]),
      driver,
      record,
      () => {},
    )
    expect(read.events).toEqual([{ type: 'completed' }])
    expect(record).toHaveBeenLastCalledWith({ stdout: bytes.length, stderr: 0 }, read.events)
  })

  it('refuses gaps in either stream instead of concatenating missing output', async () => {
    await expect(
      readTurnOutput(
        handle([{ stream: 'stderr', offset: 4, data: Buffer.from('x') }]),
        driver,
        vi.fn(),
        () => {},
      ),
    ).rejects.toThrow('Invalid agent output')
  })

  it('refuses invalid UTF-8 instead of silently changing the output', async () => {
    await expect(
      readTurnOutput(
        handle([{ stream: 'stdout', offset: 0, data: Buffer.from([255, 10]) }]),
        driver,
        vi.fn(),
        () => {},
      ),
    ).rejects.toThrow()
  })
})
