import type { AttemptCreditBudget } from '@repo/billing'
import {
  Money,
  toCredits,
  toTurnPlan,
  turnCredentialPolicySchema,
  turnPlanLimits,
  type AgentDriver,
  type LlmBackend,
  type TurnPlan,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  sampleBackendId,
  sampleDriverId,
  sampleModelSlug,
  sampleProviderModelId,
  sampleRoutePath,
} from '../testing/ids.ts'
import { llmGatewayBaseUrl } from '../llm/backends.ts'
import { CONTINUE_PROMPT } from './turn-instructions.ts'
import {
  planTurn,
  promptOf,
  SANDBOX_GATEWAY_URL,
  type ClientRequest,
  type FinishedTurn,
  type PassFacts,
  type PlannerEnvironment,
} from './turn-planner.ts'

const TASK = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const SITE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const WORKSPACE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a62'
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const MAIN = 'a'.repeat(40)
const HEAD1 = 'b'.repeat(40)
const HEAD2 = 'c'.repeat(40)
const home = { root: `/agent-home/${sampleDriverId}`, include: ['session.db'], exclude: [] }

const driver = {
  id: sampleDriverId,
  image,
  cliVersion: '1.0.0',
  capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
  prepare: vi.fn(),
  command: vi.fn(),
  parseEvent: vi.fn(),
  sessionState: vi.fn(() => home),
  extractResult: vi.fn(),
} satisfies AgentDriver
// The planner reads a backend's id and its one route; a synthetic backend of the test gives both.
const backend = {
  id: sampleBackendId,
  routes: [{ method: 'POST', path: sampleRoutePath }],
} as unknown as LlmBackend
/** The base URL a CLI gets for that backend, as the planner builds it. */
const GATEWAY_LLM_URL = llmGatewayBaseUrl(SANDBOX_GATEWAY_URL, backend)

const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 10, minute))
const request = (
  id: number,
  kind: string,
  text: string | null,
  minute: number,
  command: string | null = null,
): ClientRequest => ({
  id: BigInt(id),
  kind,
  text,
  command,
  createdAt: at(minute),
})

const budget = (patch: Partial<AttemptCreditBudget> = {}): AttemptCreditBudget => ({
  attempt: 1,
  chainAttempts: 1,
  step: toCredits(45),
  reserved: toCredits(45),
  used: new Money(0),
  spendableNow: toCredits(30),
  customerLeftRub: '270.0000000000',
  ceilingLeftRub: '270.0000000000',
  finishRub: '12.5000000000',
  openReservedRub: '0.0000000000',
  budgetRub: '270.00',
  ...patch,
})

function facts(patch: Partial<PassFacts> = {}): PassFacts {
  return {
    task: {
      id: TASK,
      workspaceId: WORKSPACE,
      siteId: SITE,
      attempt: 1,
      turnNo: 0,
      modelClass: 'standard',
    },
    repo: { provider: 'gitea', owner: 'sites', name: `site-${SITE}`, defaultBranch: 'main' },
    rules: { protectedPaths: ['wp-config.php'] },
    requests: [
      request(10, 'first', 'Поменяйте телефон в шапке', 0),
      request(11, 'command', null, 1, 'reset'),
    ],
    committedAt: at(0),
    turns: new Map(),
    writtenHead: null,
    candidate: null,
    preview: { state: 'serving', origin: 'http://site-1a2b3c4d-chat-abc123.localhost:8090' },
    profile: {
      backend: sampleBackendId,
      modelSlug: sampleModelSlug,
      providerModelId: sampleProviderModelId,
    },
    budget: { kind: 'credits', budget: budget() },
    now: at(40),
    ...patch,
  }
}

const env = (
  patch: Partial<PlannerEnvironment> = {},
  branch: string | null = null,
): PlannerEnvironment => ({
  driver,
  backends: [backend],
  runtime: 'runc',
  mainHead: vi.fn(async () => MAIN),
  branchHead: vi.fn(async () => branch),
  ...patch,
})

/** A finished turn whose saved plan is the plan of `turn` with the given base and checkpoint. */
function finished(
  turnNo: number,
  status: FinishedTurn['status'],
  patch: {
    headSha?: string | null
    base?: string
    previous?: TurnPlan['previous']
    rejected?: boolean
  },
): FinishedTurn {
  const plan = toTurnPlan(
    {
      sandbox: {
        image,
        labels: {
          workspaceId: WORKSPACE,
          siteId: SITE,
          taskId: TASK,
          sessionId: TASK,
          turn: turnNo,
        },
        runtime: 'runc',
        resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
        user: { uid: 10001, gid: 10001 },
        env: {},
        secrets: [],
        network: { mode: 'gateway', routes: ['llm', 'mcp'] },
        hardTimeoutMs: 1_200_000,
      },
      context: {
        taskId: TASK,
        sessionId: TASK,
        turn: turnNo,
        llm: {
          baseUrl: GATEWAY_LLM_URL,
          model: sampleProviderModelId,
          reasoningEffort: 'high',
        },
        mcp: { url: 'http://sandbox-gw:8080/mcp' },
        instructions: 'rules',
      },
      input: { prompt: 'words', attachments: [] },
      driverVersion: driver.cliVersion,
      workspace: {
        repo: { provider: 'gitea', owner: 'sites', name: `site-${SITE}` },
        branch: `agent/${TASK}`,
        expectedBaseSha: patch.base ?? MAIN,
        protectedPaths: [],
      },
      committedAt: at(0).toISOString(),
      ...(patch.previous ? { previous: patch.previous } : {}),
    },
    sampleDriverId,
  )
  return {
    turnNo,
    status,
    rejected: patch.rejected ?? false,
    headSha: patch.headSha === undefined ? HEAD1 : patch.headSha,
    startedAt: at(turnNo * 10),
    nativeSessionId: 'ses_prior',
    plan,
  }
}

describe('planTurn', () => {
  it('plans a first turn on the head of main, as the plan of an assignment keeps it', async () => {
    const plan = await planTurn(facts(), env())
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.turn).toBe(1)
    const { request: turn, policy } = plan
    // Every field passes the strict schema of turn_assignments.plan.
    expect(() => toTurnPlan(turn, sampleDriverId)).not.toThrow()
    expect(turnCredentialPolicySchema.parse(policy)).toEqual({
      driverId: sampleDriverId,
      backend: sampleBackendId,
      modelSlug: sampleModelSlug,
      modelClass: 'standard',
      reasoningEffort: 'high',
      ttlMs: 1_200_000,
      budgetRub: '270.00',
    })
    expect(turn.sandbox).toMatchObject({
      image,
      labels: { workspaceId: WORKSPACE, siteId: SITE, taskId: TASK, sessionId: TASK, turn: 1 },
      runtime: 'runc',
      resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
      user: { uid: 10001, gid: 10001 },
      network: { mode: 'gateway', routes: ['llm', 'mcp'] },
      hardTimeoutMs: 1_200_000,
      env: {},
      secrets: [],
    })
    expect(turn.context.llm).toEqual({
      baseUrl: GATEWAY_LLM_URL,
      model: sampleProviderModelId,
      reasoningEffort: 'high',
    })
    expect(turn.context.mcp).toEqual({ url: 'http://sandbox-gw:8080/mcp' })
    expect(turn.context.instructions).toContain('http://site-1a2b3c4d-chat-abc123.localhost:8090')
    // The client's words only: a command never reaches the agent.
    expect(turn.input).toEqual({ prompt: 'Поменяйте телефон в шапке', attachments: [] })
    expect(turn.workspace).toEqual({
      repo: { provider: 'gitea', owner: 'sites', name: `site-${SITE}` },
      branch: `agent/${TASK}`,
      expectedBaseSha: MAIN,
      protectedPaths: ['wp-config.php'],
    })
    expect(turn.committedAt).toBe(at(0).toISOString())
    expect(turn.previous).toBeUndefined()
    expect(turn.replacesTurn).toBeUndefined()
    expect(turn.rebased).toBeUndefined()
  })

  it('gives the workspace the working set and the media rules of the stack', async () => {
    const workingSet = { include: ['wp-content/themes/'], exclude: [], maxBytes: 64 * 1024 * 1024 }
    const media = {
      extensions: { png: [{ offset: 0, hex: '89504e47' }] },
      refusedNameParts: ['.php'],
      maxFileBytes: 8 * 1024 * 1024,
    }
    const plan = await planTurn(
      facts({
        rules: {
          protectedPaths: ['wp-config.php'],
          workingSet,
          addOnlyPaths: ['wp-content/uploads/raditi/'],
          media,
        },
      }),
      env(),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.workspace).toMatchObject({
      workingSet,
      addOnlyPaths: ['wp-content/uploads/raditi/'],
      media,
    })
    expect(() => toTurnPlan(plan.request, sampleDriverId)).not.toThrow()
  })

  it("tells the agent what the site's adapter says of the database of its stack", async () => {
    const guide = '- On this site: a new page — `wp_rest` POST /wp/v2/pages.\n'
    const plan = await planTurn(facts({ databaseGuide: guide }), env())
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.context.instructions).toContain(guide)
  })

  it("points the agent's commands at the egress proxy for the hosts of the client's variables (Р13)", async () => {
    const egress = ['api.example.ru:443', 'hooks.example.com:8443']
    const plan = await planTurn(facts({ egress, variables: ['HOOK_TOKEN', 'PAYMENT_KEY'] }), env())
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    // The agent learns the names and the hosts, never a value.
    expect(plan.request.context.instructions).toContain(
      'environment variables of the client: HOOK_TOKEN, PAYMENT_KEY.',
    )
    expect(plan.request.context.instructions).toContain(
      'only to api.example.ru:443, hooks.example.com:8443;',
    )
    expect(plan.request.sandbox.network).toEqual({
      mode: 'gateway',
      routes: ['llm', 'mcp'],
      egress,
    })
    expect(plan.request.context.egressProxy).toBe('http://sandbox-gw:3128')
    // The plan keeps the hosts and the proxy, never a value.
    const kept = toTurnPlan(plan.request, sampleDriverId)
    expect(kept.sandbox.network).toEqual(plan.request.sandbox.network)
    expect(kept.context.egressProxy).toBe('http://sandbox-gw:3128')
    // Without hosts no egress and no proxy: the sandbox reaches the gateway alone.
    const bare = await planTurn(facts({ egress: [] }), env())
    if (bare.kind !== 'turn') throw new Error(`expected a turn, got ${bare.kind}`)
    expect(bare.request.sandbox.network).toEqual({ mode: 'gateway', routes: ['llm', 'mcp'] })
    expect(bare.request.context).not.toHaveProperty('egressProxy')
    expect(bare.request.context.instructions).not.toContain('## Client variables')
    // Names without hosts: the commands have the values and no way out.
    const closed = await planTurn(facts({ egress: [], variables: ['LOCAL_KEY'] }), env())
    if (closed.kind !== 'turn') throw new Error(`expected a turn, got ${closed.kind}`)
    expect(closed.request.context.instructions).toContain(
      'Nothing outside the sandbox is reachable from those commands.',
    )
    expect(closed.request.sandbox.network).toEqual({ mode: 'gateway', routes: ['llm', 'mcp'] })
    // More than one gateway variable holds is no turn.
    const many = Array.from({ length: 257 }, (_, i) => `h${i}.example.ru:443`)
    expect(await planTurn(facts({ egress: many }), env())).toEqual({
      kind: 'refused',
      code: 'technical',
    })
  })

  it('continues the session of a completed turn with the words written after it started', async () => {
    const last = finished(1, 'completed', { headSha: HEAD1 })
    const plan = await planTurn(
      facts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, last]]),
        writtenHead: HEAD1,
        requests: [
          request(10, 'first', 'Поменяйте телефон', 0),
          request(12, 'answer', '+7 900 000-00-00', 20),
        ],
      }),
      env({}, HEAD1),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.turn).toBe(2)
    expect(plan.request.workspace.expectedBaseSha).toBe(HEAD1)
    expect(plan.request.previous).toEqual({
      workspaceId: WORKSPACE,
      sessionId: TASK,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: driver.cliVersion },
      home,
    })
    expect(plan.request.input.prompt).toBe('+7 900 000-00-00')
    // The driver session the turn ended with is what sessionState reads.
    expect(driver.sessionState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ nativeSessionId: 'ses_prior' }),
      }),
    )
    expect(env().mainHead).not.toHaveBeenCalled()
  })

  it('replaces an unsuccessful turn from the checkpoint it started with', async () => {
    const first = finished(1, 'completed', { headSha: HEAD1 })
    const previous = {
      workspaceId: WORKSPACE,
      sessionId: TASK,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: driver.cliVersion },
      home,
    }
    const failed = finished(2, 'failed', { headSha: null, base: HEAD1, previous })
    const plan = await planTurn(
      facts({
        task: { ...facts().task, turnNo: 2, attempt: 2 },
        turns: new Map([
          [1, first],
          [2, failed],
        ]),
        writtenHead: HEAD1,
        requests: [request(10, 'first', 'Первая просьба', 0), request(13, 'retry', null, 25)],
      }),
      env({}, HEAD1),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.turn).toBe(3)
    expect(plan.request.replacesTurn).toBe(2)
    expect(plan.request.previous).toEqual(previous)
    expect(plan.request.workspace).toMatchObject({
      expectedBaseSha: HEAD1,
      expectedBranchSha: HEAD1,
    })
    // «Попробовать ещё» carries no words; the session remembers the request.
    expect(plan.request.input.prompt).toBe(CONTINUE_PROMPT)
  })

  // docs/plan/53, «Попробовать ещё (18.10)»: the turn completed and published, but its pass ended
  // in a failure (no readable words, a change refused) and the dialog kept its candidate.
  it('replaces a completed turn whose pass ended in a failure, leased on its head', async () => {
    const first = finished(1, 'completed', { headSha: HEAD1 })
    const previous = {
      workspaceId: WORKSPACE,
      sessionId: TASK,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: driver.cliVersion },
      home,
    }
    const refused = finished(2, 'completed', { headSha: HEAD2, base: HEAD1, previous })
    const of = (rejected: boolean) =>
      facts({
        task: { ...facts().task, turnNo: 2, attempt: 2, modelClass: 'heavy' },
        turns: new Map([
          [1, first],
          [2, { ...refused, rejected }],
        ]),
        writtenHead: HEAD2,
        candidate: { turnNo: 1, headSha: HEAD1 },
        requests: [
          request(10, 'first', 'Первая просьба', 0),
          request(12, 'revision', 'И добавьте год', 15),
          request(13, 'retry', null, 25),
        ],
      })

    const plan = await planTurn(of(true), env({}, HEAD2))
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.turn).toBe(3)
    expect(plan.request.replacesTurn).toBe(2)
    expect(plan.request.previous).toEqual(previous)
    // From the candidate the refused turn started on; the push replaces what it published.
    expect(plan.request.workspace).toMatchObject({
      expectedBaseSha: HEAD1,
      expectedBranchSha: HEAD2,
    })
    // The words of the pass that failed are asked again.
    expect(plan.request.input.prompt).toBe('И добавьте год')
    expect(plan.request.context.llm.reasoningEffort).toBe('max')

    // A turn whose result was taken is continued.
    const continued = await planTurn(of(false), env({}, HEAD2))
    if (continued.kind !== 'turn') throw new Error(`expected a turn, got ${continued.kind}`)
    expect(continued.request.replacesTurn).toBeUndefined()
    expect(continued.request.workspace.expectedBaseSha).toBe(HEAD2)
  })

  it('starts a new session on the candidate «Обновить» moved onto a new main', async () => {
    const last = finished(1, 'completed', { headSha: HEAD1 })
    const plan = await planTurn(
      facts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, last]]),
        writtenHead: HEAD2,
        candidate: { turnNo: 1, headSha: HEAD2 },
        requests: [request(10, 'first', 'Первая', 0), request(14, 'revision', 'Вторая', 30)],
      }),
      env({}, HEAD2),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.rebased).toBe(true)
    expect(plan.request.previous).toBeUndefined()
    expect(plan.request.workspace.expectedBaseSha).toBe(HEAD2)
    // A new session hears the whole dialog.
    expect(plan.request.input.prompt).toBe('Первая\n\nВторая')
  })

  it('replaces the new session after «Обновить», pinned on the head the update wrote', async () => {
    // «Обновить» moved the candidate of turn 1 onto a new main (HEAD2); turn 2, the new session
    // on it, failed after its assignment opened (the pool was busy), and is replaced.
    const rebased = { ...finished(2, 'failed', { headSha: null, base: HEAD2 }) }
    rebased.plan = { ...rebased.plan!, rebased: true }
    const plan = await planTurn(
      facts({
        task: { ...facts().task, turnNo: 2 },
        turns: new Map([
          [1, finished(1, 'completed', { headSha: HEAD1 })],
          [2, rebased],
        ]),
        writtenHead: HEAD2,
        candidate: { turnNo: 1, headSha: HEAD2 },
      }),
      env({}, HEAD2),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request).toMatchObject({ replacesTurn: 2, rebased: true })
    expect(plan.request.previous).toBeUndefined()
    expect(plan.request.workspace).toMatchObject({
      expectedBaseSha: HEAD2,
      expectedBranchSha: HEAD2,
    })
  })

  it('replaces a turn that failed before «Обновить» with a new session on the moved head', async () => {
    // Turn 2 continued turn 1 and failed; the dialog waited with its candidate, and «Обновить»
    // moved it under the task's turn 2 onto a new main (HEAD2). The input of turn 2 stands on
    // the old main: publishing it over HEAD2 would undo the move.
    const previous = {
      workspaceId: WORKSPACE,
      sessionId: TASK,
      turn: 1,
      image,
      driver: { id: sampleDriverId, version: driver.cliVersion },
      home,
    }
    const plan = await planTurn(
      facts({
        task: { ...facts().task, turnNo: 2, attempt: 2 },
        turns: new Map([
          [1, finished(1, 'completed', { headSha: HEAD1 })],
          [2, finished(2, 'failed', { headSha: null, base: HEAD1, previous })],
        ]),
        writtenHead: HEAD2,
        candidate: { turnNo: 2, headSha: HEAD2 },
        requests: [request(10, 'first', 'Первая', 0), request(14, 'revision', 'Вторая', 30)],
      }),
      env({}, HEAD2),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request).toMatchObject({ replacesTurn: 2, rebased: true })
    expect(plan.request.previous).toBeUndefined()
    expect(plan.request.workspace).toMatchObject({
      expectedBaseSha: HEAD2,
      expectedBranchSha: HEAD2,
    })
    // A new session hears the whole dialog.
    expect(plan.request.input.prompt).toBe('Первая\n\nВторая')
  })

  it('runs no turn on a task branch that is not where the platform left it', async () => {
    const continued = facts({
      task: { ...facts().task, turnNo: 1 },
      turns: new Map([[1, finished(1, 'completed', { headSha: HEAD1 })]]),
      writtenHead: HEAD1,
      requests: [
        request(10, 'first', 'Первая', 0),
        request(15, 'command', null, 35, 'update'),
        request(16, 'revision', 'Вторая', 36),
      ],
    })
    // An `/update` written 5 minutes ago may still be moving the branch: it is named.
    expect(await planTurn(continued, env({}, HEAD2))).toEqual({
      kind: 'branch_moved',
      update: '15',
    })
    // Long after it, or without one, nothing can publish there.
    expect(await planTurn({ ...continued, now: at(35 + 121) }, env({}, HEAD2))).toEqual({
      kind: 'branch_moved',
      update: null,
    })
    // The first turn creates the branch: nothing to compare.
    const first = env({}, HEAD2)
    expect((await planTurn(facts(), first)).kind).toBe('turn')
    expect(first.branchHead).not.toHaveBeenCalled()
  })

  it('asks «Продолжить?» when the key cannot cover a first call', async () => {
    const plan = await planTurn(
      facts({
        task: { ...facts().task, turnNo: 2 },
        budget: {
          kind: 'credits',
          budget: budget({
            budgetRub: '3.10',
            finishRub: '12.5000000000',
            used: new Money('44.4'),
            customerLeftRub: '3.1000000000',
          }),
        },
      }),
      env(),
    )
    expect(plan).toEqual({
      kind: 'ceiling',
      question: { v: 1, kind: 'ceiling', turn: 2, reason: 'step', spent: 44, held: 45, left: 1 },
    })
  })

  it('takes the class ceiling for a task that holds no reserve by design', async () => {
    const plan = await planTurn(facts({ budget: { kind: 'quota' } }), env())
    expect(plan.kind === 'turn' && plan.policy.budgetRub).toBe('285.00')
  })

  it('refuses what cannot be planned', async () => {
    expect(await planTurn(facts({ repo: null }), env())).toEqual({
      kind: 'refused',
      code: 'not_accepted',
    })
    expect(await planTurn(facts({ profile: null }), env())).toEqual({
      kind: 'refused',
      code: 'unavailable',
    })
    expect(await planTurn(facts(), env({ backends: [] }))).toEqual({
      kind: 'refused',
      code: 'unavailable',
    })
    expect(await planTurn(facts(), env({ mainHead: async () => null }))).toEqual({
      kind: 'refused',
      code: 'technical',
    })
    // A completed turn whose plan no longer passes its schema cannot be continued.
    const unreadable = { ...finished(1, 'completed', {}), plan: null }
    expect(
      await planTurn(
        facts({ task: { ...facts().task, turnNo: 1 }, turns: new Map([[1, unreadable]]) }),
        env(),
      ),
    ).toEqual({ kind: 'refused', code: 'technical' })
  })
})

describe('promptOf', () => {
  it('keeps the latest words that fit and asks to continue without any', () => {
    const long = 'я'.repeat(turnPlanLimits.prompt - 5)
    expect(promptOf([request(1, 'first', 'старое', 0), request(2, 'answer', long, 1)], null)).toBe(
      long,
    )
    expect(promptOf([request(1, 'retry', null, 0)], null)).toBe(CONTINUE_PROMPT)
    expect(promptOf([request(1, 'first', 'до', 0)], at(5))).toBe(CONTINUE_PROMPT)
  })
})
