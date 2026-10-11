import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  toTurnPlan,
  turnInputSchema,
  turnPlanSchema,
  withTurnCredentials,
  withoutTurnCredentials,
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
    llm: { baseUrl: 'http://sandbox-gw:8080/llm', apiKey: 'sk-turn-llm-key', model: 'glm-5.3' },
    mcp: { url: 'http://sandbox-gw:8080/mcp', token: 'mcp-turn-token' },
    instructions: 'Отвечайте клиенту по-русски.',
    nativeSessionId: 'ses_0001',
  },
  input: { prompt: 'Поменяйте цену на главной', attachments: ['/workspace/inbox/price.pdf'] },
  driverVersion: '1.18.34',
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
    driver: { id: 'opencode', version: '1.18.34' },
    home: {
      root: '/agent-home/opencode',
      include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
      exclude: [],
    },
  },
})

describe('turn plan', () => {
  it('starts with an unkeyed request and preserves the original when issuing fresh values', () => {
    const original = request()
    const unkeyed = withoutTurnCredentials(original)
    expect(unkeyed.context.llm).not.toHaveProperty('apiKey')
    expect(unkeyed.context.mcp).not.toHaveProperty('token')
    const plan = toTurnPlan(unkeyed, 'opencode')
    expect(plan).toEqual(toTurnPlan(original, 'opencode'))
    const keyed = withTurnCredentials(plan, { llmApiKey: 'fresh-llm', mcpToken: 'fresh-mcp' })
    expect(keyed.context.llm.apiKey).toBe('fresh-llm')
    expect(keyed.context.mcp.token).toBe('fresh-mcp')
    expect(original.context.llm.apiKey).toBe('sk-turn-llm-key')
    expect(plan.context.llm).not.toHaveProperty('apiKey')
  })
  it('keeps everything of the request except its LLM key and MCP token', () => {
    const plan = toTurnPlan(request(), 'opencode')
    expect(JSON.stringify(plan)).not.toMatch(/sk-turn-llm-key|mcp-turn-token/)
    expect(plan.context.llm).toEqual({ baseUrl: 'http://sandbox-gw:8080/llm', model: 'glm-5.3' })
    expect(plan.context.mcp).toEqual({ url: 'http://sandbox-gw:8080/mcp' })
    expect(plan.driverId).toBe('opencode')
    expect(
      withTurnCredentials(plan, { llmApiKey: 'sk-turn-llm-key', mcpToken: 'mcp-turn-token' }),
    ).toEqual(request())
  })

  it.each(['medium', 'provider-specific-effort', null, undefined])(
    'preserves reasoning effort %s through persistence and credential recovery',
    (reasoningEffort) => {
      const original = request()
      if (reasoningEffort !== undefined) original.context.llm.reasoningEffort = reasoningEffort
      const plan = toTurnPlan(withoutTurnCredentials(original), 'opencode')
      const restored = turnPlanSchema.parse(JSON.parse(JSON.stringify(plan)))
      const recovered = withTurnCredentials(restored, {
        llmApiKey: original.context.llm.apiKey,
        mcpToken: original.context.mcp.token,
      })
      expect(recovered).toEqual(original)
      expect(restored.context.llm.reasoningEffort).toBe(reasoningEffort)
      expect(JSON.stringify(restored)).not.toMatch(/sk-turn-llm-key|mcp-turn-token/)
      if (reasoningEffort === undefined)
        expect(restored.context.llm).not.toHaveProperty('reasoningEffort')
    },
  )

  it.each(['', 'x'.repeat(33), true, 1, {}, []])(
    'refuses invalid reasoning effort %# in the request and the saved plan',
    (reasoningEffort) => {
      const original = request()
      Object.assign(original.context.llm, { reasoningEffort })
      expect(() => toTurnPlan(original, 'opencode')).toThrow('Invalid turn plan')
      const plan = toTurnPlan(request(), 'opencode')
      expect(
        turnPlanSchema.safeParse({
          ...plan,
          context: { ...plan.context, llm: { ...plan.context.llm, reasoningEffort } },
        }).success,
      ).toBe(false)
    },
  )

  it('refuses to store a credential or an unknown field', () => {
    const plan = toTurnPlan(request(), 'opencode')
    for (const context of [
      { ...plan.context, llm: { ...plan.context.llm, apiKey: 'sk-turn-llm-key' } },
      { ...plan.context, mcp: { ...plan.context.mcp, token: 'mcp-turn-token' } },
      { ...plan.context, extra: true },
    ])
      expect(turnPlanSchema.safeParse({ ...plan, context }).success).toBe(false)
    expect(turnPlanSchema.safeParse({ ...plan, credentials: ['x'] }).success).toBe(false)
    expect(turnPlanSchema.safeParse({ ...plan, driverId: 'other' }).success).toBe(false)
  })

  // The plan of a turn of a removed shell stays in turn_assignments as history: it is never
  // read back as a plan, so recovery cannot pick a driver for it.
  it.each(['gigacode', 'codex', 'kimi', 'qwen'])(
    'refuses a stored plan of the removed driver %s',
    (driverId) => {
      const plan = toTurnPlan(request(), 'opencode')
      const result = turnPlanSchema.safeParse({ ...plan, driverId })
      expect(result.success).toBe(false)
      if (!result.success)
        expect(result.error.issues.map((issue) => issue.path)).toEqual([['driverId']])
      const previous = { ...plan.previous, driver: { ...plan.previous?.driver, id: driverId } }
      const earlier = turnPlanSchema.safeParse({ ...plan, previous })
      expect(earlier.success).toBe(false)
      if (!earlier.success)
        expect(earlier.error.issues.map((issue) => issue.path)).toEqual([
          ['previous', 'driver', 'id'],
        ])
    },
  )

  it('refuses a credential hidden in the LLM or MCP address', () => {
    for (const url of [
      'http://turn:sk-turn-llm-key@sandbox-gw:8080/llm',
      'http://sk-turn-llm-key@sandbox-gw:8080/llm',
      'http://sandbox-gw:8080/llm?api_key=sk-turn-llm-key',
      'http://sandbox-gw:8080/llm#sk-turn-llm-key',
    ]) {
      const llm = request()
      llm.context.llm.baseUrl = url
      const mcp = request()
      mcp.context.mcp.url = url.replace('/llm', '/mcp')
      for (const unsafe of [llm, mcp]) {
        let error: unknown
        try {
          toTurnPlan(unsafe, 'opencode')
        } catch (e) {
          error = e
        }
        expect(isDomainError(error) && error.code).toBe('BAD_REQUEST')
        expect(String((error as Error).message)).not.toContain('sk-turn-llm-key')
      }
    }
    const plan = toTurnPlan(request(), 'opencode')
    const stored = { ...plan.context, mcp: { url: 'http://sandbox-gw:8080/mcp?token=mcp-turn' } }
    expect(turnPlanSchema.safeParse({ ...plan, context: stored }).success).toBe(false)
  })

  it('refuses turn secrets in the sandbox spec and an invalid request without echoing it', () => {
    const withSecret = request()
    withSecret.sandbox.secrets = [{ path: '/run/raditi/secrets/llm', value: 'sk-turn-llm-key' }]
    let error: unknown
    try {
      toTurnPlan(withSecret, 'opencode')
    } catch (e) {
      error = e
    }
    expect(isDomainError(error) && error.code).toBe('BAD_REQUEST')
    expect(String((error as Error).message)).not.toContain('sk-turn-llm-key')
    const badUrl = request()
    badUrl.context.llm.baseUrl = 'file:///etc/passwd'
    expect(() => toTurnPlan(badUrl, 'opencode')).toThrow('Invalid turn plan')
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
