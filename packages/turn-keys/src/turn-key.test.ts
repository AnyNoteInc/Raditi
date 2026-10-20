import { describe, expect, it, vi } from 'vitest'

import { sampleBackendId } from './testing.ts'
import {
  LLM_KEY_PATTERN,
  lockSubscriptionPool,
  MCP_TOKEN_PATTERN,
  newTurnKeys,
  parseTurnCredentialPath,
  subscriptionCredentialPath,
  TURN_KEY_IN_TEXT,
  turnCredentialPath,
  turnKeyHash,
} from './turn-key.ts'

const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('turn key conventions', () => {
  it('generates a pair that its own patterns accept, new on every call', () => {
    const first = newTurnKeys()
    const second = newTurnKeys()
    expect(Object.keys(first).sort()).toEqual(['llmApiKey', 'mcpToken'])
    // 32 random bytes each: 43 base64url characters and 64 hex digits.
    expect(first.llmApiKey).toMatch(/^sk-rdt-[A-Za-z0-9_-]{43}$/)
    expect(first.mcpToken).toMatch(/^mcp_[a-f0-9]{64}$/)
    expect(LLM_KEY_PATTERN.test(first.llmApiKey)).toBe(true)
    expect(MCP_TOKEN_PATTERN.test(first.mcpToken)).toBe(true)
    expect(second.llmApiKey).not.toBe(first.llmApiKey)
    expect(second.mcpToken).not.toBe(first.mcpToken)
  })

  it('accepts only a whole key: the patterns are anchored and stateless', () => {
    const { llmApiKey, mcpToken } = newTurnKeys()
    for (const value of [`x${llmApiKey}`, `${llmApiKey}x`, `${llmApiKey}\n`, mcpToken, 'sk-rdt-'])
      expect(LLM_KEY_PATTERN.test(value)).toBe(false)
    for (const value of [`x${mcpToken}`, `${mcpToken}0`, `${mcpToken}\n`, llmApiKey, 'mcp_'])
      expect(MCP_TOKEN_PATTERN.test(value)).toBe(false)
    expect(MCP_TOKEN_PATTERN.test(mcpToken.toUpperCase())).toBe(false)
    // A global or sticky flag would make every second test of the same key fail.
    expect([LLM_KEY_PATTERN.test(llmApiKey), LLM_KEY_PATTERN.test(llmApiKey)]).toEqual([true, true])
    expect([MCP_TOKEN_PATTERN.test(mcpToken), MCP_TOKEN_PATTERN.test(mcpToken)]).toEqual([
      true,
      true,
    ])
  })

  it('finds either secret anywhere in a text, and nothing that only resembles one', () => {
    const { llmApiKey, mcpToken } = newTurnKeys()
    for (const text of [llmApiKey, mcpToken, `Ключ: ${llmApiKey}.`, `<p>x${mcpToken}</p>\n`])
      expect(TURN_KEY_IN_TEXT.test(text)).toBe(true)
    for (const text of [
      '',
      'sk-rdt-short',
      llmApiKey.slice(0, -1),
      mcpToken.slice(0, -1),
      mcpToken.toUpperCase(),
      `mcp_${'g'.repeat(64)}`,
    ])
      expect(TURN_KEY_IN_TEXT.test(text)).toBe(false)
    expect([TURN_KEY_IN_TEXT.test(mcpToken), TURN_KEY_IN_TEXT.test(mcpToken)]).toEqual([true, true])
  })

  it('hashes a key as llm_keys stores it: SHA-256 in lowercase hex', () => {
    expect(turnKeyHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('subscription pool conventions', () => {
  it('names the Vault path of an account by its backend and id', () => {
    expect(subscriptionCredentialPath(sampleBackendId, taskId)).toBe(
      `subs/${sampleBackendId}/${taskId}`,
    )
  })

  it('takes the pool lock in one statement, with the whole key as its only value', async () => {
    const statements: { sql: string; values: unknown[] }[] = []
    const $queryRaw = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: parts.join('?'), values })
      return []
    })
    await lockSubscriptionPool({ $queryRaw } as never, sampleBackendId)
    // Every holder hashes the same text: a key assembled in SQL is a second spelling.
    expect(statements).toEqual([
      {
        sql: 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))::text',
        values: [`pool:${sampleBackendId}`],
      },
    ])
  })
})

describe('turn credential identity', () => {
  it('canonicalizes task identity while retaining the first epoch', () => {
    const path = turnCredentialPath({
      taskId: taskId.toUpperCase(),
      sessionId: 'session',
      turn: 3,
      epoch: 7,
    })
    expect(path).toBe(`turns/t_${taskId}_3_7`)
    expect(parseTurnCredentialPath(path)).toEqual({ taskId, turn: 3, epoch: 7 })
  })

  it.each(['', 'synthetic session', 'synthetic\nsession', 'сессия', '-session', 'x'.repeat(65)])(
    'refuses session label %j before any Vault write',
    (sessionId) => {
      expect(() => turnCredentialPath({ taskId, sessionId, turn: 3, epoch: 7 })).toThrow()
    },
  )

  it.each([
    `t_${taskId}_03_7`,
    `t_${taskId}_3_0`,
    `t_${taskId}_3_2147483648`,
    `t_${taskId}_1000000_7`,
    `t_${taskId}_3_7/`,
    `turns/../t_${taskId}_3_7`,
    `subs/t_${taskId}_3_7`,
    `t_${taskId.toUpperCase()}_3_7`,
  ])('refuses unsafe or ambiguous cleanup path %s', (path) => {
    expect(parseTurnCredentialPath(path)).toBeNull()
  })
})
