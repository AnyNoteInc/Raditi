import { Buffer } from 'node:buffer'

import { agentOutputLimits, ENV_VALUE_MASK, type ExecChunk, type ExecHandle } from '@repo/domain'
import { createOpencodeDriver } from '@repo/agent-drivers'
import { describe, expect, it, vi } from 'vitest'

import { readTurnOutput, SKIPPED_LINE_MESSAGE } from '@repo/local-turns'

import { maskTurnEvents } from './turn-events-mask.ts'

// The output of a turn read with the real driver of the agent; the cases of the reader alone are
// those of @repo/local-turns (src/turn-output.test.ts), which reaches no agent driver.

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

const handle = (chunks: ExecChunk[]): Pick<ExecHandle, 'output'> => ({
  output: async function* () {
    yield* chunks
  },
})

describe('bounded turn output', () => {
  /** `stdout` as the exec yields it: chunks of at most `size` bytes, one after another. */
  const chunked = (stdout: Buffer, size = 64 * 1024): ExecChunk[] => {
    const chunks: ExecChunk[] = []
    for (let offset = 0; offset < stdout.length; offset += size)
      chunks.push({ stream: 'stdout', offset, data: stdout.subarray(offset, offset + size) })
    return chunks
  }

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
})

describe('the client variables of a turn in its events (plan 53, Р13)', () => {
  const value = "pay-se'cret-0001"

  it('masks each line before the driver parses it: a long text is clipped after the mask', async () => {
    const opencode = createOpencodeDriver({ image })
    // Fewer letters than the mask, more bytes than the shortest value: «[скрыто]» is longer.
    const short = 'пароль-1'
    const limit = agentOutputLimits.messageText
    const text = `${short} `.repeat(Math.ceil(limit / short.length) + 5)
    // A value cut at the limit of the event would leave its first letters unmasked.
    const straddling = `${'x'.repeat(limit - 4)}${value} tail`
    const line = (part: string) =>
      JSON.stringify({ type: 'text', part: { type: 'text', text: part } })
    const bytes = Buffer.from(`${line(text)}\n${line(straddling)}\n`)
    const read = await readTurnOutput(
      handle([{ stream: 'stdout', offset: 0, data: bytes }]),
      opencode,
      async () => {},
      () => {},
      [],
      undefined,
      [short, value],
    )
    expect(read.events).toHaveLength(2)
    for (const event of read.events) {
      expect(event.type).toBe('message')
      const shown = (event as { text: string }).text
      expect(shown.length).toBeLessThanOrEqual(limit)
      expect(shown).not.toContain(short)
      expect(shown).not.toContain(value.slice(0, 4))
    }
    expect((read.events[0] as { text: string }).text.startsWith(`${ENV_VALUE_MASK} `)).toBe(true)
    // Nothing is left for core to mask, so nothing grows past its schema there.
    expect(maskTurnEvents(read.events, [short, value])).toEqual(read.events)
  })
})
