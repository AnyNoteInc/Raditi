import { createCodexDriver, createKimiDriver } from '@repo/agent-drivers'
import type { AgentDriver, AgentEvent, TurnResult } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { readTurnResult, resultCandidate } from './turn-result.ts'

const image = `registry.invalid/raditi/sbx@sha256:${'a'.repeat(64)}`
const result: TurnResult = {
  summary: 'Добавил блок отзывов',
  change_type: 'code',
  client_message: 'На главной появится блок «Отзывы».',
  files_changed: ['wp-content/themes/shop/front-page.php'],
  questions: [],
  needs_approval: false,
  risk: 'low',
}
const json = JSON.stringify(result)
const final = (text: string): AgentEvent[] => [
  { type: 'started', nativeSessionId: 'native1' },
  { type: 'message', text },
]
const rejected = {
  code: 'TURN_OUTPUT_REJECTED',
  httpStatus: 502,
  message: 'Agent result failed its schema',
}

describe('the result of a turn', () => {
  const drivers = [
    ['codex', createCodexDriver({ image })],
    ['kimi', createKimiDriver({ image })],
  ] as const

  describe.each(drivers)('read by the %s driver', (_, driver) => {
    it.each([
      ['the bare object', json],
      ['one fenced block', '```json\n' + json + '\n```'],
      ['prose before a fenced block', 'Готово, итог:\n```json\n' + json + '\n```'],
      ['a fenced block inside one line of prose', 'Готово! ```json ' + json + '``` Всё.'],
      ['a fenced block without a language', 'Итог:\n```\n' + json + '\n```\n'],
      ['prose after the object', json + '\n\nЕсли нужно что-то ещё — напишите.'],
      ['prose around the object', 'Вот итог: ' + json + ' — на этом всё.'],
    ])('accepts %s as the final message', (_case, text) => {
      expect(readTurnResult(driver, final(text))).toEqual(result)
    })

    it.each([
      ['no JSON at all', 'Готово, всё сделал.'],
      ['an object that is not a result', 'Итог: {"summary":"Готово"}'],
      ['two fenced blocks', '```json\n' + json + '\n```\nили\n```json\n' + json + '\n```'],
      ['two objects', json + ' и ещё ' + json],
      ['a brace of the prose next to the object', 'Поменял {цену} в шаблоне: ' + json],
      ['a result with a field outside the schema', JSON.stringify({ ...result, extra: true })],
    ])('refuses %s', (_case, text) => {
      expect(() => readTurnResult(driver, final(text))).toThrow(expect.objectContaining(rejected))
    })

    it('never takes the result from a message before the last one', () => {
      const events: AgentEvent[] = [...final(json), { type: 'message', text: 'Что-то ещё.' }]
      expect(() => readTurnResult(driver, events)).toThrow(expect.objectContaining(rejected))
    })

    it('reads nothing from a turn whose agent reported a failure', () => {
      const events: AgentEvent[] = [...final(json), { type: 'failed', reason: 'stream error' }]
      expect(() => readTurnResult(driver, events)).toThrow(expect.objectContaining(rejected))
    })
  })

  it('asks the driver again only for a candidate that differs from the whole message', () => {
    const extractResult = vi.fn<AgentDriver['extractResult']>(() => null)
    expect(() => readTurnResult({ extractResult }, final(json))).toThrow()
    expect(extractResult).toHaveBeenCalledExactlyOnceWith(expect.anything(), null)

    extractResult.mockClear()
    extractResult.mockImplementation((_events, candidate) =>
      candidate === null ? null : (JSON.parse(candidate) as unknown),
    )
    expect(readTurnResult({ extractResult }, final(`Готово.\n${json}`))).toEqual(result)
    expect(extractResult.mock.calls.map(([, candidate]) => candidate)).toEqual([null, json])
  })

  it('says nothing of what the agent wrote when it refuses a result', () => {
    const text = JSON.stringify({ ...result, 'agent-chosen-key': 'agent-chosen-text' })
    let message = ''
    try {
      readTurnResult(createKimiDriver({ image }), final(text))
    } catch (error) {
      message = `${String(error)} ${JSON.stringify(error)}`
    }
    expect(message).toContain('TURN_OUTPUT_REJECTED')
    expect(message).not.toMatch(/agent-chosen/)
  })
})

describe('resultCandidate', () => {
  it('names the body of the only fenced block, else the span of the outermost braces', () => {
    expect(resultCandidate('a ```json\n{"a":1}\n``` b')).toBe('{"a":1}')
    expect(resultCandidate('a ```JSON {"a":1}``` b {x}')).toBe('{"a":1}')
    expect(resultCandidate('a {"a":{"b":2}} b')).toBe('{"a":{"b":2}}')
    expect(resultCandidate('``` one ``` and ``` two ```')).toBeUndefined()
    expect(resultCandidate('no braces')).toBeUndefined()
    expect(resultCandidate('} reversed {')).toBeUndefined()
  })

  it('stays linear on a message of the largest size built to make it backtrack', () => {
    const hostile = '```json'.repeat(2_500) + '{'.repeat(2_500)
    const started = performance.now()
    resultCandidate(hostile)
    resultCandidate('{'.repeat(20_000))
    resultCandidate('```'.repeat(6_666))
    expect(performance.now() - started).toBeLessThan(500)
  })
})
