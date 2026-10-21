import { ENV_VALUE_MASK, agentOutputLimits, type AgentEvent } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { maskTurnEvents } from './turn-events-mask.ts'

describe('the client variables of a turn in its events (plan 53, Р13)', () => {
  const value = "pay-se'cret-0001"

  it('masks every value in every string of every event, and keeps the rest', () => {
    const events: AgentEvent[] = [
      { type: 'started', nativeSessionId: 'native1' },
      { type: 'message', text: `ключ ${value}, снова ${value}` },
      { type: 'failed', reason: `HTTP 401 for ${JSON.stringify(value)}` },
      { type: 'completed' },
    ]
    expect(maskTurnEvents(events, [value])).toEqual([
      events[0],
      { type: 'message', text: `ключ ${ENV_VALUE_MASK}, снова ${ENV_VALUE_MASK}` },
      { type: 'failed', reason: `HTTP 401 for "${ENV_VALUE_MASK}"` },
      events[3],
    ])
    expect(maskTurnEvents(events, [])).toEqual(events)
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
