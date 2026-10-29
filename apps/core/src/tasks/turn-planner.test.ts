import type { AttemptCreditBudget } from '@repo/billing'
import {
  BROWSER_ONLY,
  Money,
  REPOSITORY_ONLY,
  toCredits,
  toTurnPlan,
  turnCredentialPolicySchema,
  turnPlanLimits,
  type AgentDriver,
  type LlmBackend,
  type TurnPlan,
  type TurnSkill,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { llmGatewayBaseUrl } from '../llm/backends.ts'
import {
  sampleBackendId,
  sampleDriverId,
  sampleModelSlug,
  sampleProviderModelId,
  sampleRoutePath,
} from '../testing/ids.ts'
import { CONTINUE_PROMPT } from './turn-instructions.ts'
import {
  planTurn,
  promptOf,
  turnInboxOf,
  SANDBOX_EGRESS_PROXY_URL,
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
    requirements: { ...REPOSITORY_ONLY },
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
  internet: false,
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
    // A repository task's plan keeps the shape of before the requirements (plan 57, Б3).
    expect(turn).not.toHaveProperty('requirements')
    expect(plan.requirements).toEqual(REPOSITORY_ONLY)
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
    // The agent is told the same: where it writes, where media goes, that the root is not its.
    expect(plan.request.context.instructions).toContain(
      'only these parts of the site: wp-content/themes/.',
    )
    expect(plan.request.context.instructions).toContain('go only to wp-content/uploads/raditi/')
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

  it('opens the internet of a repository turn through the egress proxy, with the skills (26.10.2026)', async () => {
    const skills: TurnSkill[] = [
      { name: 'context7', kind: 'remote', url: 'https://mcp.context7.com/mcp' },
      { name: 'playwright', kind: 'local' },
    ]
    const plan = await planTurn(
      facts({ skills, egress: ['api.example.ru:443'], variables: ['API_TOKEN'] }),
      env({ internet: true }),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.sandbox.network).toEqual({
      mode: 'gateway',
      routes: ['llm', 'mcp'],
      egress: ['api.example.ru:443'],
      internet: true,
    })
    expect(plan.request.context).toMatchObject({
      egressProxy: 'http://sandbox-gw:3128',
      internet: true,
      skills,
    })
    const { instructions } = plan.request.context
    expect(instructions).toContain('## The internet')
    expect(instructions).toContain('context7, playwright')
    expect(instructions).toContain('Never send a secret')
    expect(instructions).toContain('Those commands reach the internet as the section below says.')
    expect(instructions).not.toContain('only to api.example.ru:443')
    // The plan keeps the policy and the skills: recovery runs the turn as it was planned.
    const kept = toTurnPlan(plan.request, sampleDriverId)
    expect(kept.sandbox.network).toEqual(plan.request.sandbox.network)
    expect(kept.context.skills).toEqual(skills)
    // Without skills the internet is open all the same; `off` is the turn as before.
    const bare = await planTurn(facts({ skills: [] }), env({ internet: true }))
    if (bare.kind !== 'turn') throw new Error(`expected a turn, got ${bare.kind}`)
    expect(bare.request.context).not.toHaveProperty('skills')
    expect(bare.request.context.egressProxy).toBe('http://sandbox-gw:3128')
    const off = await planTurn(facts({ skills }), env())
    if (off.kind !== 'turn') throw new Error(`expected a turn, got ${off.kind}`)
    expect(off.request.sandbox.network).toEqual({ mode: 'gateway', routes: ['llm', 'mcp'] })
    expect(off.request.context).not.toHaveProperty('internet')
    expect(off.request.context).not.toHaveProperty('skills')
    expect(off.request.context.instructions).not.toContain('## The internet')
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
    expect(plan.request.workspace?.expectedBaseSha).toBe(HEAD1)
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
    expect(continued.request.workspace?.expectedBaseSha).toBe(HEAD2)
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
    expect(plan.request.workspace?.expectedBaseSha).toBe(HEAD2)
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

describe('planTurn of a repository task with files of the client', () => {
  const MIB = 1024 * 1024
  const fileOf = (index: number, fileName = `photo-${index}.jpg`, sizeBytes = MIB) => ({
    id: `0199b2f4-6c1e-7a52-9f3d-${String(index).padStart(12, '0')}`,
    fileName,
    contentType: 'image/jpeg',
    sizeBytes,
  })
  const pathOf = (index: number, fileName = `photo-${index}.jpg`) =>
    `/workspace/inbox/0199b2f4-6c1e-7a52-9f3d-${String(index).padStart(12, '0')}/${fileName}`

  it('puts the files of the task into the sandbox by path and tells the agent of them', async () => {
    const files = [fileOf(1, 'Меню кафе.pdf'), fileOf(2)]
    const plan = await planTurn(
      facts({
        attachments: files,
        rules: { protectedPaths: [], addOnlyPaths: ['wp-content/uploads/raditi/'] },
      }),
      env(),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.input.attachments).toEqual([pathOf(1, 'Меню кафе.pdf'), pathOf(2)])
    expect(() => toTurnPlan(plan.request, sampleDriverId)).not.toThrow()
    const instructions = plan.request.context.instructions
    expect(instructions).toContain('## Files from the client')
    expect(instructions).toContain('they are in /workspace/inbox')
    expect(instructions).toContain('copy it into wp-content/uploads/raditi/ under a new name')
    expect(instructions).not.toContain('earlier files of the dialog are not here')
    // Never a key of the inbox: only paths of the sandbox.
    expect(JSON.stringify(plan.request)).not.toContain(`inbox/${WORKSPACE}/`)
  })

  it('says nothing of files to a turn of a task that has none', async () => {
    const plan = await planTurn(facts(), env())
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.input.attachments).toEqual([])
    expect(plan.request.context.instructions).not.toContain('## Files from the client')
  })

  it('tells the agent how many earlier files one turn did not take', async () => {
    const files = Array.from({ length: 12 }, (_, index) => fileOf(index, undefined, 20 * MIB))
    const plan = await planTurn(facts({ attachments: files }), env())
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.input.attachments).toHaveLength(10)
    expect(plan.request.context.instructions).toContain(
      '- 2 earlier files of the dialog are not here',
    )
  })

  it('takes the latest files, as many as one turn holds, in the order they were sent', () => {
    // A full message of ten files of 20 MiB always fits: the earlier one does not.
    const full = [fileOf(0, 'old.pdf', MIB), ...Array.from({ length: 10 }, (_, i) => fileOf(i + 1, undefined, 20 * MIB))]
    expect(turnInboxOf(full)).toEqual({
      paths: Array.from({ length: 10 }, (_, i) => pathOf(i + 1)),
      omitted: 1,
    })
    const many = Array.from({ length: 60 }, (_, index) => fileOf(index, undefined, 1024))
    const taken = turnInboxOf(many)
    expect(taken.paths).toEqual(Array.from({ length: 50 }, (_, i) => pathOf(i + 10)))
    expect(taken.omitted).toBe(10)
    // A name the plan's rule refuses is left out, the rest still go.
    expect(turnInboxOf([fileOf(1, 'a\u0007.png'), fileOf(2)])).toEqual({
      paths: [pathOf(2)],
      omitted: 1,
    })
    expect(turnInboxOf([])).toEqual({ paths: [], omitted: 0 })
  })
})

describe('planTurn of a task in the cloud browser (docs/plan/57-browser-tasks.md)', () => {
  const ATTACHMENT = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a70'
  const browser = {
    siteUrl: 'https://example.ru/',
    agentNotes: 'Вход по адресу /login',
    attachments: [
      { id: ATTACHMENT, fileName: 'фото.jpg', contentType: 'image/jpeg', sizeBytes: 250_000 },
    ],
    saved: [],
    guide: '- Open the list of posts first.',
  }
  const browserFacts = (patch: Partial<PassFacts> = {}) =>
    facts({
      requirements: { ...BROWSER_ONLY },
      browser,
      repo: null,
      rules: { protectedPaths: [] },
      requests: [request(10, 'first', 'Добавьте новость о скидках', 0)],
      egress: ['api.example.ru:443'],
      variables: ['API_TOKEN'],
      ...patch,
    })

  /** A finished turn of the task whose saved plan has no repository. */
  function finishedInBrowser(turnNo: number, status: FinishedTurn['status']): FinishedTurn {
    const { plan } = finished(turnNo, status, {})
    const { workspace: _workspace, ...rest } = plan!
    return {
      ...finished(turnNo, status, {}),
      headSha: null,
      plan: { ...rest, requirements: { ...BROWSER_ONLY } },
    }
  }

  it('plans a first turn without a repository: no git, the browser rules and the site', async () => {
    const e = env()
    const plan = await planTurn(browserFacts(), e)
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    const { request: turn } = plan
    expect(() => toTurnPlan(turn, sampleDriverId)).not.toThrow()
    expect(plan.requirements).toEqual(BROWSER_ONLY)
    expect(turn.requirements).toEqual(BROWSER_ONLY)
    expect(turn).not.toHaveProperty('workspace')
    expect(turn.previous).toBeUndefined()
    // No branch is read for a task that has none.
    expect(e.mainHead).not.toHaveBeenCalled()
    expect(e.branchHead).not.toHaveBeenCalled()
    // The browser rules and the stack's guide, never the repository's.
    expect(turn.context.instructions).toContain('cloud browser')
    expect(turn.context.instructions).toContain('web_help')
    expect(turn.context.instructions).toContain('- Open the list of posts first.')
    expect(turn.context.instructions).not.toContain('repository working copy')
    // The client's variables reach no command of a turn in the browser.
    expect(turn.sandbox.network).toEqual({ mode: 'gateway', routes: ['llm', 'mcp'] })
    expect(turn.context.egressProxy).toBeUndefined()
    expect(turn.context.instructions).not.toContain('## The internet')
    // The internet is open to it too (owner's decision of 26.10.2026), with the skills, while
    // the admin pages stay reachable through the `web` tools alone.
    const open = await planTurn(
      browserFacts({ skills: [{ name: 'playwright', kind: 'local' }] }),
      env({ internet: true }),
    )
    if (open.kind !== 'turn') throw new Error(`expected a turn, got ${open.kind}`)
    expect(() => toTurnPlan(open.request, sampleDriverId)).not.toThrow()
    expect(open.request.sandbox.network).toEqual({
      mode: 'gateway',
      routes: ['llm', 'mcp'],
      internet: true,
    })
    expect(open.request.context).toMatchObject({
      internet: true,
      egressProxy: SANDBOX_EGRESS_PROXY_URL,
      skills: [{ name: 'playwright', kind: 'local' }],
    })
    expect(open.request.context.instructions).toContain('## The internet')
    expect(open.request.context.instructions).toContain(
      "The site's admin pages are reached through the browser tools alone",
    )
    expect(open.request.context.instructions).toContain('web_help')
    expect(turn.context.instructions).not.toContain('API_TOKEN')
    // Its files go to the browser worker, never into the sandbox (Б26).
    expect(turn.input.attachments).toEqual([])
    expect(turn.context.instructions).not.toContain('## Files from the client')
    const prompt = turn.input.prompt
    expect(prompt.startsWith('Добавьте новость о скидках\n\n---\n')).toBe(true)
    expect(prompt).toContain('The site of this task: https://example.ru/')
    expect(prompt).toContain('Вход по адресу /login')
    expect(prompt).toContain(`- ${ATTACHMENT}: фото.jpg, image/jpeg, 244.1 KiB`)
    // Never a key or an address of a file: only the worker reads it.
    expect(prompt).not.toMatch(/inbox\/|s3|https?:\/\/(?!example\.ru)/)
  })

  it('continues a completed turn from its snapshot, with the words that came after it', async () => {
    const last = finishedInBrowser(1, 'completed')
    const e = env()
    const plan = await planTurn(
      browserFacts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, last]]),
        requests: [
          request(10, 'first', 'Добавьте новость', 0),
          request(12, 'resume', null, 20),
          request(13, 'answer', 'Опубликуйте её', 21),
        ],
      }),
      e,
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.turn).toBe(2)
    expect(plan.request.previous).toMatchObject({ sessionId: TASK, turn: 1 })
    expect(plan.request.input.prompt.split('\n\n---\n')[0]).toBe('Опубликуйте её')
    expect(() => toTurnPlan(plan.request, sampleDriverId)).not.toThrow()
    expect(e.branchHead).not.toHaveBeenCalled()
  })

  it('asks to go on when the client only gave the browser back', async () => {
    const plan = await planTurn(
      browserFacts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finishedInBrowser(1, 'completed')]]),
        requests: [request(10, 'first', 'Добавьте новость', 0), request(12, 'resume', null, 20)],
      }),
      env(),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.input.prompt.startsWith(`${CONTINUE_PROMPT}\n\n---\n`)).toBe(true)
  })

  it('starts a new session after an unsuccessful turn: nothing is replaced', async () => {
    const plan = await planTurn(
      browserFacts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finishedInBrowser(1, 'failed')]]),
        requests: [request(10, 'first', 'Добавьте новость', 0), request(12, 'continue', null, 20)],
      }),
      env(),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.previous).toBeUndefined()
    expect(plan.request.replacesTurn).toBeUndefined()
    expect(plan.request.input.prompt.startsWith('Добавьте новость\n\n')).toBe(true)
  })

  // docs/plan/57, Б22: a new session does not remember what an earlier turn saved on the site.
  it('lists what the task saved on the site to a new session after a failed turn', async () => {
    const saved = [
      {
        kind: 'post' as const,
        objectId: '41',
        state: 'verified' as const,
        title: 'Скидки\nна «зиму»\u202e',
        status: 'draft' as const,
        editPath: '/wp-admin/post.php',
      },
      { kind: 'post' as const, objectId: '42', state: 'unverified' as const, editPath: '/p' },
      // A title left out: it may hold a contact (savedObjectOf).
      {
        kind: 'post' as const,
        objectId: '44',
        state: 'verified' as const,
        status: 'publish' as const,
        editPath: '/p',
      },
      { kind: 'post' as const, objectId: '43', state: 'missing' as const, editPath: '/p' },
    ]
    const plan = await planTurn(
      browserFacts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finishedInBrowser(1, 'failed')]]),
        requests: [request(10, 'first', 'Добавьте новость', 0), request(12, 'continue', null, 20)],
        browser: { ...browser, saved },
      }),
      env(),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.previous).toBeUndefined()
    const prompt = plan.request.input.prompt
    expect(prompt.startsWith('Добавьте новость\n\n---\n')).toBe(true)
    const block = prompt.slice(prompt.indexOf('Already saved on the site by this task'))
    expect(block).toContain('never create another one for the same request')
    // One line per object, in the order the task saved them; a title stays on its line.
    expect(block).toContain(
      '- post 41: verified, title "Скидки на «зиму»", status draft; editor /wp-admin/post.php',
    )
    expect(block).toMatch(/- post 42: saved, the site has not confirmed it yet — call web_verify/)
    expect(block).toContain('- post 44: verified, title not shown, status publish; editor /p')
    expect(block).toMatch(
      /- post 43: the last check did not find it .* ask the client with web_help/,
    )
    expect(block.indexOf('post 41')).toBeLessThan(block.indexOf('post 43'))
    // The files still come after it.
    expect(block).toContain(`- ${ATTACHMENT}: фото.jpg`)
    expect(() => toTurnPlan(plan.request, sampleDriverId)).not.toThrow()

    // A continued session is told of them too: what the site holds now is the platform's word.
    const continued = await planTurn(
      browserFacts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finishedInBrowser(1, 'completed')]]),
        requests: [request(10, 'first', 'Добавьте новость', 0), request(12, 'resume', null, 20)],
        browser: { ...browser, saved },
      }),
      env(),
    )
    if (continued.kind !== 'turn') throw new Error(`expected a turn, got ${continued.kind}`)
    expect(continued.request.previous).toBeDefined()
    expect(continued.request.input.prompt).toContain('- post 42: saved')
  })

  it('lists at most the latest saved objects, and none when the task saved nothing', async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      kind: 'post' as const,
      objectId: String(100 + index),
      state: 'verified' as const,
      title: 'я'.repeat(500),
      status: 'publish' as const,
      editPath: '/wp-admin/post.php',
    }))
    const plan = await planTurn(browserFacts({ browser: { ...browser, saved: many } }), env())
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    const prompt = plan.request.input.prompt
    expect(prompt).toContain('- 5 earlier objects are not listed')
    expect(prompt).not.toContain('post 104:')
    expect(prompt).toContain('post 105:')
    expect(prompt).toContain('post 144:')
    // A long title is cut to one short line.
    expect(prompt).toContain(`title "${'я'.repeat(120)}", status publish`)

    const none = await planTurn(browserFacts(), env())
    if (none.kind !== 'turn') throw new Error(`expected a turn, got ${none.kind}`)
    expect(none.request.input.prompt).not.toContain('Already saved')
  })

  it('keeps the latest words within the prompt limit next to the site', async () => {
    const long = 'я'.repeat(turnPlanLimits.prompt - 10)
    const plan = await planTurn(
      browserFacts({
        requests: [request(10, 'first', 'старое', 0), request(11, 'answer', long, 1)],
      }),
      env(),
    )
    if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
    expect(plan.request.input.prompt.length).toBeLessThanOrEqual(turnPlanLimits.prompt)
    expect(plan.request.input.prompt).toContain('The site of this task')
    expect(() => toTurnPlan(plan.request, sampleDriverId)).not.toThrow()
  })

  it('refuses a task it cannot run in the browser', async () => {
    // Both at once are not taken yet (Б3).
    expect(
      await planTurn(browserFacts({ requirements: { repository: true, browser: true } }), env()),
    ).toEqual({ kind: 'refused', code: 'not_accepted' })
    // A stack without browser support.
    expect(await planTurn(browserFacts({ browser: { ...browser, guide: null } }), env())).toEqual({
      kind: 'refused',
      code: 'not_accepted',
    })
    // A completed turn whose plan no longer reads cannot be continued.
    expect(
      await planTurn(
        browserFacts({
          task: { ...facts().task, turnNo: 1 },
          turns: new Map([[1, { ...finishedInBrowser(1, 'completed'), plan: null }]]),
        }),
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
