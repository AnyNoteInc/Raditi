import { ENV_VALUE_MASK, agentOutputLimits, type AgentEvent } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { maskTurnEvents } from './turn-events-mask.ts'

describe('the client variables of a turn in its events (plan 53, Р13)', () => {
  const value = "pay-se'cret-0001"

  it('masks every value in every string of every event, and keeps the rest', () => {
    const events: AgentEvent[] = [
      { type: 'started', nativeSessionId: 'native1' },
      { type: 'message', text: `ключ ${value}, снова ${value}` },
      { type: 'reasoning', text: `подумаю о ${value}` },
      { type: 'failed', reason: `HTTP 401 for ${JSON.stringify(value)}` },
      { type: 'completed' },
    ]
    expect(maskTurnEvents(events, [value])).toEqual([
      events[0],
      { type: 'message', text: `ключ ${ENV_VALUE_MASK}, снова ${ENV_VALUE_MASK}` },
      { type: 'reasoning', text: `подумаю о ${ENV_VALUE_MASK}` },
      { type: 'failed', reason: `HTTP 401 for "${ENV_VALUE_MASK}"` },
      events[4],
    ])
    expect(maskTurnEvents(events, [])).toEqual(events)
  })

  it("masks what a command printed, the chat shows it (owner's request of 09.11.2026)", () => {
    const command: AgentEvent = {
      type: 'command',
      command: 'printenv PAY_KEY',
      exitCode: 0,
      output: `${value}\n`,
      outputCut: false,
    }
    expect(maskTurnEvents([command], [value])).toEqual([
      { ...command, output: `${ENV_VALUE_MASK}\n` },
    ])
  })

  it('clips a command output the mask made longer, rather than fail the turn', () => {
    const short = 'ключ'
    const output = short.repeat(Math.floor(agentOutputLimits.commandOutput / short.length))
    const [masked] = maskTurnEvents(
      [{ type: 'command', command: 'cat .env', exitCode: 0, output }],
      [short],
    )
    expect(masked).toMatchObject({ type: 'command', outputCut: true })
    const shown = (masked as { output: string }).output
    expect(shown.length).toBeLessThanOrEqual(agentOutputLimits.commandOutput)
    expect(shown).not.toContain(short)
  })

  it('masks a value inside an item of the plan, the client sees it beside the chat (plan 89, ТД14)', () => {
    const plan: AgentEvent = {
      type: 'todo_list',
      items: [
        { text: `Проверяем оплату ключом ${value}`, status: 'completed' },
        { text: 'Готовим текст страницы', status: 'in_progress' },
      ],
      omitted: { completed: 2, other: 1 },
    }
    expect(maskTurnEvents([plan], [value])).toEqual([
      {
        ...plan,
        items: [
          { text: `Проверяем оплату ключом ${ENV_VALUE_MASK}`, status: 'completed' },
          plan.items[1],
        ],
      },
    ])
  })

  it('cuts an item the mask made longer back to its limit, rather than fail the turn', () => {
    const short = 'ключ'
    const limit = agentOutputLimits.todoText
    const [masked] = maskTurnEvents(
      [
        {
          type: 'todo_list',
          items: [
            { text: short.repeat(limit / short.length), status: 'in_progress' },
            // Astral letters take two units each: the cut keeps them whole.
            { text: `${short}${'😀'.repeat((limit - short.length) / 2)}`, status: 'pending' },
          ],
        },
      ],
      [short],
    )
    const items = (masked as { items: { text: string; status: string }[] }).items
    expect(items.map((item) => item.status)).toEqual(['in_progress', 'pending'])
    for (const item of items) {
      expect(item.text.length).toBeLessThanOrEqual(limit)
      expect(item.text.endsWith('…')).toBe(true)
      expect(item.text).not.toContain(short)
      expect(item.text).not.toMatch(/\p{Cs}/u)
    }
    expect(items[0]!.text.startsWith(ENV_VALUE_MASK)).toBe(true)
  })

  it('keeps an item of the plan as it is when the mask has nothing to hide in it', () => {
    const plan: AgentEvent = {
      type: 'todo_list',
      items: [
        { text: 'Собираем цены', status: 'completed' },
        { text: 'Я'.repeat(agentOutputLimits.todoText), status: 'pending' },
      ],
    }
    const before = structuredClone(plan)
    // A value shorter than the masked minimum: masking hands the very event back, untouched.
    expect(maskTurnEvents([plan], ['ab'])).toEqual([before])
    expect(maskTurnEvents([plan], [value])).toEqual([before])
    expect(plan).toEqual(before)
  })

  it('refuses a masked event its schema no longer takes, rather than keep it', () => {
    // A short value of wide letters: the mask is longer than the text it replaces.
    const short = 'ключ'
    const limit = agentOutputLimits.messageText
    const text = short.repeat(Math.floor(limit / short.length))
    expect(() => maskTurnEvents([{ type: 'message', text }], [short])).toThrow(
      'Agent event failed its schema',
    )
  })
})
