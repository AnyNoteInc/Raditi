import { Buffer } from 'node:buffer'

import {
  agentOutputLimits,
  type AgentDriver,
  type AgentEvent,
  type ExecChunk,
  type ExecHandle,
} from '@repo/domain'
import { createOpencodeDriver } from '@repo/agent-drivers'
import { describe, expect, it, vi } from 'vitest'

import { readTurnOutput, SKIPPED_LINE_MESSAGE } from './turn-output.ts'

const image = `registry.invalid/raditi/sbx@sha256:${'a'.repeat(64)}`
/** A turn result as a real CLI prints it in its final message. */
const finalResult = JSON.stringify({
  summary: 'Готово',
  change_type: 'none',
  client_message: 'Готово.',
  files_changed: [],
  questions: [],
  needs_approval: false,
  risk: 'low',
})

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
    // A partial line and stderr carry no events: nothing is journaled until the line completes.
    expect(record).toHaveBeenCalledOnce()
    expect(record).toHaveBeenCalledWith({ stdout: bytes.length, stderr: 17 }, read.events)
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

  it('journals only output with events, and the final tail as before', async () => {
    const record = vi.fn(async () => {})
    await readTurnOutput(
      handle([{ stream: 'stdout', offset: 0, data: Buffer.from('progress\nmore') }]),
      { parseEvent: () => [] },
      record,
      () => {},
    )
    expect(record).toHaveBeenCalledOnce()
    expect(record).toHaveBeenCalledWith({ stdout: 13, stderr: 0 }, [])
  })

  // The agent's output, not the client's input: never a 400 «check the data you entered».
  const rejected = { code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 }
  const tooLarge = { code: 'TURN_OUTPUT_TOO_LARGE', httpStatus: 413 }

  it('refuses gaps in either stream instead of concatenating missing output', async () => {
    await expect(
      readTurnOutput(
        handle([{ stream: 'stderr', offset: 4, data: Buffer.from('x') }]),
        driver,
        vi.fn(),
        () => {},
      ),
    ).rejects.toMatchObject({ ...rejected, message: 'Invalid agent output stream' })
  })

  it('refuses invalid UTF-8 instead of silently changing the output', async () => {
    await expect(
      readTurnOutput(
        handle([{ stream: 'stdout', offset: 0, data: Buffer.from([255, 10]) }]),
        driver,
        vi.fn(),
        () => {},
      ),
    ).rejects.toMatchObject(rejected)
  })

  it('refuses an event that fails the shared schema as rejected output', async () => {
    await expect(
      readTurnOutput(
        handle([{ stream: 'stdout', offset: 0, data: Buffer.from('{"type":"unknown"}\n') }]),
        driver,
        vi.fn(),
        () => {},
      ),
    ).rejects.toMatchObject(rejected)
  })

  it('refuses a known credential as rejected output', async () => {
    const line = JSON.stringify({ type: 'message', text: 'key synthetic-turn-key' }) + '\n'
    await expect(
      readTurnOutput(
        handle([{ stream: 'stdout', offset: 0, data: Buffer.from(line) }]),
        driver,
        vi.fn(),
        () => {},
        ['synthetic-turn-key'],
      ),
    ).rejects.toMatchObject({ ...rejected, message: 'Agent output contains a turn credential' })
  })

  /** `stdout` as the exec yields it: chunks of at most `size` bytes, one after another. */
  const chunked = (stdout: Buffer, size = 64 * 1024): ExecChunk[] => {
    const chunks: ExecChunk[] = []
    for (let offset = 0; offset < stdout.length; offset += size)
      chunks.push({ stream: 'stdout', offset, data: stdout.subarray(offset, offset + size) })
    return chunks
  }
  const line = (event: AgentEvent) => Buffer.from(JSON.stringify(event) + '\n')
  const result = { type: 'message', text: '{"summary":"Готово"}' } as const

  it('skips a line longer than the parsers read and goes on with the turn', async () => {
    // A CLI prints the whole output of a command as one line of its events: 1 MiB here.
    const before = line({ type: 'started', nativeSessionId: 'native1' })
    const long = Buffer.concat([Buffer.alloc(1024 * 1024, 'x'), Buffer.from('\n')])
    const after = line(result)
    const parseEvent = vi.fn(driver.parseEvent)
    const record = vi.fn(async () => {})
    const read = await readTurnOutput(
      handle(chunked(Buffer.concat([before, long, after]))),
      { parseEvent },
      record,
      () => {},
    )
    expect(read.events).toEqual([
      { type: 'started', nativeSessionId: 'native1' },
      { type: 'message', text: SKIPPED_LINE_MESSAGE },
      result,
    ])
    // Nothing of the long line is decoded or parsed.
    expect(parseEvent).toHaveBeenCalledTimes(2)
    // Its bytes are acknowledged only once it ended: a reconnect reads it again from its start.
    expect(record.mock.calls).toEqual([
      [{ stdout: before.length, stderr: 0 }, read.events.slice(0, 1)],
      [{ stdout: before.length + long.length + after.length, stderr: 0 }, read.events.slice(1)],
    ])
  })

  it.each([
    [
      'OpenCode: the output of a tool in one tool_use row',
      createOpencodeDriver({ image }),
      (output: string) => {
        const tokens = { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
        const row = (type: string, part: object) => ({ type, sessionID: 'ses_test', part })
        return [
          row('step_start', { type: 'step-start' }),
          row('tool_use', {
            type: 'tool',
            tool: 'bash',
            callID: 'call_1',
            state: { status: 'completed', input: { command: 'cat style.css' }, output },
          }),
          row('step_finish', { type: 'step-finish', reason: 'tool-calls', tokens }),
          row('step_start', { type: 'step-start' }),
          row('text', { type: 'text', text: finalResult }),
          row('step_finish', { type: 'step-finish', reason: 'stop', tokens }),
        ]
      },
    ],
  ])(
    'keeps the result of a turn whose agent printed 1 MiB in one line (%s)',
    async (_, cli, rows) => {
      const stdout = Buffer.from(
        rows('x'.repeat(1024 * 1024))
          .map((row) => JSON.stringify(row) + '\n')
          .join(''),
      )
      const read = await readTurnOutput(
        handle(chunked(stdout)),
        cli,
        vi.fn(async () => {}),
        () => {},
      )
      expect(read.events).toContainEqual({ type: 'message', text: SKIPPED_LINE_MESSAGE })
      expect(cli.extractResult(read.events, null)).toEqual(JSON.parse(finalResult))
    },
  )

  it('never lets an over-long final line revive an older result', async () => {
    for (const ending of ['\n', '']) {
      const stdout = Buffer.concat([
        line(result),
        Buffer.alloc(256 * 1024 + 1, 'x'),
        Buffer.from(ending),
      ])
      const read = await readTurnOutput(
        handle(chunked(stdout)),
        driver,
        vi.fn(async () => {}),
        () => {},
      )
      // The last message is the one left in place of the skipped line, never the older result.
      expect(read.events.findLast((event) => event.type === 'message')).toEqual({
        type: 'message',
        text: SKIPPED_LINE_MESSAGE,
      })
      expect(() => JSON.parse(SKIPPED_LINE_MESSAGE) as unknown).toThrow()
      expect(read.cursor.stdout).toBe(stdout.length)
    }
  })

  it('still reads a line of exactly the size the parsers accept', async () => {
    const text = 'x'.repeat(256 * 1024 - JSON.stringify({ type: 'message', text: '' }).length)
    const stdout = Buffer.from(JSON.stringify({ type: 'message', text }))
    expect(stdout.length).toBe(256 * 1024)
    const read = await readTurnOutput(
      handle(chunked(stdout)),
      { parseEvent: (value) => [{ type: 'message', text: String(value.length) }] },
      vi.fn(async () => {}),
      () => {},
    )
    expect(read.events).toEqual([{ type: 'message', text: String(256 * 1024) }])
  })

  it('reports output over its limits as too large (413)', async () => {
    // A skipped line still counts against everything one turn may print.
    const megabyte = Buffer.alloc(1024 * 1024, 'x')
    const endless: ExecChunk[] = Array.from({ length: 33 }, (_, index) => ({
      stream: 'stdout',
      offset: index * megabyte.length,
      data: megabyte,
    }))
    await expect(readTurnOutput(handle(endless), driver, vi.fn(), () => {})).rejects.toMatchObject({
      ...tooLarge,
      message: 'Agent output limit exceeded',
    })
    const many = Buffer.from(
      `${JSON.stringify({ type: 'completed' })}\n`.repeat(agentOutputLimits.turnEvents + 1),
    )
    await expect(
      readTurnOutput(
        handle([{ stream: 'stdout', offset: 0, data: many }]),
        driver,
        vi.fn(async () => {}),
        () => {},
      ),
    ).rejects.toMatchObject({ ...tooLarge, message: 'Agent event limit exceeded' })
  })

  it('continues from the journal cursor after a reconnect', async () => {
    const line = Buffer.from(JSON.stringify({ type: 'completed' }) + '\n')
    const record = vi.fn(async () => {})
    const start = { cursor: { stdout: 100, stderr: 7 }, eventCount: 3 }
    const read = await readTurnOutput(
      handle([{ stream: 'stdout', offset: 100, data: line }]),
      driver,
      record,
      () => {},
      [],
      start,
    )
    expect(read).toEqual({
      events: [{ type: 'completed' }],
      cursor: { stdout: 100 + line.length, stderr: 7 },
    })
    expect(record).toHaveBeenCalledWith({ stdout: 100 + line.length, stderr: 7 }, read.events)
    // The replayed stream must start exactly at the cursor.
    await expect(
      readTurnOutput(
        handle([{ stream: 'stdout', offset: 0, data: line }]),
        driver,
        vi.fn(),
        () => {},
        [],
        start,
      ),
    ).rejects.toMatchObject(rejected)
  })

  it('counts events journaled before a reconnect against the limit of the turn', async () => {
    const two = Buffer.from(`${JSON.stringify({ type: 'completed' })}\n`.repeat(2))
    await expect(
      readTurnOutput(
        handle([{ stream: 'stdout', offset: 0, data: two }]),
        driver,
        vi.fn(async () => {}),
        () => {},
        [],
        { cursor: { stdout: 0, stderr: 0 }, eventCount: agentOutputLimits.turnEvents - 1 },
      ),
    ).rejects.toMatchObject({ ...tooLarge, message: 'Agent event limit exceeded' })
  })
})
