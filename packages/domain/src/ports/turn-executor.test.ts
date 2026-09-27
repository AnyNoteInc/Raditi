import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  toTurnPlan,
  turnInputSchema,
  turnPlanSchema,
  withTurnCredentials,
  type TurnRequest,
} from './turn-executor.ts'

const digest = 'a'.repeat(64)
const taskId = '11111111-1111-4111-8111-111111111111'
const siteId = '22222222-2222-4222-8222-222222222222'

const request = (): TurnRequest => ({
  sandbox: {
    image: `registry.local/raditi/sbx-wordpress@sha256:${digest}`,
    labels: { workspaceId: 'ws-1', siteId, taskId, sessionId: 'session-1', turn: 2 },
    runtime: 'runsc',
    resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
    user: { uid: 10001, gid: 10001 },
    env: { LANG: 'C.UTF-8' },
    secrets: [],
    network: { mode: 'gateway', routes: ['llm', 'mcp'] },
    hardTimeoutMs: 20 * 60_000,
  },
  context: {
    taskId,
    sessionId: 'session-1',
    turn: 2,
    llm: { baseUrl: 'http://sandbox-gw:8080/llm', apiKey: 'sk-turn-llm-key', model: 'kimi-k2.6' },
    mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'mcp-turn-token' },
    instructions: 'Отвечайте клиенту по-русски.',
    nativeSessionId: 'thread-1',
  },
  input: { prompt: 'Поменяйте цену на главной', attachments: ['/workspace/inbox/price.pdf'] },
  driverVersion: '0.157.1',
  workspace: {
    repo: { provider: 'gitea', owner: 'sites', name: 'shop' },
    branch: `agent/${taskId}`,
    expectedBaseSha: 'b'.repeat(40),
    protectedPaths: ['wp-config.php'],
  },
  committedAt: '2026-09-27T10:00:00.000Z',
  previous: {
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    turn: 1,
    image: `registry.local/raditi/sbx-wordpress@sha256:${digest}`,
    driver: { id: 'kimi', version: '0.157.1' },
    home: { root: '/agent-home/kimi', include: ['sessions'], exclude: [] },
  },
})

describe('turn plan', () => {
  it('keeps everything of the request except its LLM key and MCP token', () => {
    const plan = toTurnPlan(request(), 'kimi')
    expect(JSON.stringify(plan)).not.toMatch(/sk-turn-llm-key|mcp-turn-token/)
    expect(plan.context.llm).toEqual({ baseUrl: 'http://sandbox-gw:8080/llm', model: 'kimi-k2.6' })
    expect(plan.context.mcp).toEqual({ url: 'http://sandbox-gw:8080/mcp' })
    expect(plan.driverId).toBe('kimi')
    expect(
      withTurnCredentials(plan, { llmApiKey: 'sk-turn-llm-key', mcpToken: 'mcp-turn-token' }),
    ).toEqual(request())
  })

  it('refuses to store a credential or an unknown field', () => {
    const plan = toTurnPlan(request(), 'kimi')
    for (const context of [
      { ...plan.context, llm: { ...plan.context.llm, apiKey: 'sk-turn-llm-key' } },
      { ...plan.context, mcp: { ...plan.context.mcp, token: 'mcp-turn-token' } },
      { ...plan.context, extra: true },
    ])
      expect(turnPlanSchema.safeParse({ ...plan, context }).success).toBe(false)
    expect(turnPlanSchema.safeParse({ ...plan, credentials: ['x'] }).success).toBe(false)
    expect(turnPlanSchema.safeParse({ ...plan, driverId: 'other' }).success).toBe(false)
  })

  it('refuses turn secrets in the sandbox spec and an invalid request without echoing it', () => {
    const withSecret = request()
    withSecret.sandbox.secrets = [{ path: '/run/raditi/secrets/llm', value: 'sk-turn-llm-key' }]
    let error: unknown
    try {
      toTurnPlan(withSecret, 'kimi')
    } catch (e) {
      error = e
    }
    expect(isDomainError(error) && error.code).toBe('BAD_REQUEST')
    expect(String((error as Error).message)).not.toContain('sk-turn-llm-key')
    const badUrl = request()
    badUrl.context.llm.baseUrl = 'file:///etc/passwd'
    expect(() => toTurnPlan(badUrl, 'kimi')).toThrow('Invalid turn plan')
  })

  it.each([
    [{ prompt: '', attachments: [] }],
    [{ prompt: 'x', attachments: ['/workspace/repo/a'] }],
    [{ prompt: 'x', attachments: ['/workspace/inbox/../repo/a'] }],
    [{ prompt: 'x', attachments: ['/workspace/inbox/a\nb'] }],
    [{ prompt: 'x'.repeat(100_001), attachments: [] }],
  ])('refuses the turn input %#', (input) => {
    expect(turnInputSchema.safeParse(input).success).toBe(false)
  })
})
