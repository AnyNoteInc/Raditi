import type { AttemptCreditBudget } from '@repo/billing'
import {
  BROWSER_ONLY,
  Money,
  PLAIN_CHAT,
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
import { CHAT_TITLE_SECTION, CONTINUE_PROMPT, INIT_PROMPT } from './turn-instructions.ts'
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
const WORKSPACE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a62'
const FILE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a70'
const OLDER = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a71'
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const home = { root: `/agent-home/${sampleDriverId}`, include: ['session.db'], exclude: [] }

const driver = {
  id: sampleDriverId,
  image,
  cliVersion: '1.0.0',
  capabilities: {
    resume: true,
    jsonEvents: true,
    outputSchema: false,
    mcp: true,
    images: false,
    reasoningEvents: false,
    compaction: false,
  },
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
const GATEWAY_LLM_URL = llmGatewayBaseUrl(SANDBOX_GATEWAY_URL, backend)

const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 10, minute))
const request = (
  id: number,
  kind: string,
  text: string | null,
  minute: number,
  command: string | null = null,
): ClientRequest => ({ id: BigInt(id), kind, text, command, createdAt: at(minute) })

const budget = (patch: Partial<AttemptCreditBudget> = {}): AttemptCreditBudget => ({
  attempt: 1,
  chainAttempts: 1,
  reserved: toCredits(1),
  used: new Money(0),
  spendableNow: toCredits(44),
  debt: toCredits(0),
  customerLeftRub: '270.0000000000',
  finishRub: '12.5000000000',
  openReservedRub: '0.0000000000',
  budgetRub: '270.00',
  ...patch,
})

function facts(patch: Partial<PassFacts> = {}): PassFacts {
  return {
    task: { id: TASK, workspaceId: WORKSPACE, attempt: 1, turnNo: 0, modelClass: 'standard' },
    requirements: { ...PLAIN_CHAT },
    requests: [request(10, 'first', 'Посчитайте смету', 0)],
    committedAt: at(0),
    turns: new Map(),
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

const env = (patch: Partial<PlannerEnvironment> = {}): PlannerEnvironment => ({
  driver,
  backends: [backend],
  runtime: 'runc',
  browser: true,
  ...patch,
})

const checkpointOf = (turn: number) => ({
  workspaceId: WORKSPACE,
  sessionId: TASK,
  turn,
  image,
  driver: { id: sampleDriverId, version: driver.cliVersion },
  home,
})

/** A finished turn of a chat whose saved plan is a plan of that turn. */
function finished(
  turnNo: number,
  status: FinishedTurn['status'],
  patch: { previous?: TurnPlan['previous']; rejected?: boolean; undone?: boolean } = {},
): FinishedTurn {
  const plan = toTurnPlan(
    {
      sandbox: {
        image,
        labels: {
          workspaceId: WORKSPACE,
          siteId: TASK,
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
        hardTimeoutMs: 180_000,
      },
      context: {
        taskId: TASK,
        sessionId: TASK,
        turn: turnNo,
        llm: { baseUrl: GATEWAY_LLM_URL, model: sampleProviderModelId, reasoningEffort: 'high' },
        mcp: { url: 'http://sandbox-gw:8080/mcp' },
        instructions: 'rules',
      },
      input: { prompt: 'words', attachments: [] },
      driverVersion: driver.cliVersion,
      requirements: { ...PLAIN_CHAT },
      committedAt: at(0).toISOString(),
      ...(patch.previous ? { previous: patch.previous } : {}),
    },
    sampleDriverId,
  )
  return {
    turnNo,
    status,
    rejected: patch.rejected ?? false,
    undone: patch.undone ?? false,
    startedAt: at(turnNo * 10),
    nativeSessionId: 'ses_prior',
    plan,
  }
}

const planned = async (given: PassFacts, environment = env()) => {
  const plan = await planTurn(given, environment)
  if (plan.kind !== 'turn') throw new Error(`expected a turn, got ${plan.kind}`)
  return plan
}

describe('planTurn of a chat (docs/plan/83-remove-projects.md)', () => {
  it('plans a first turn with no repository, under the chat’s own lease, as a plan keeps it', async () => {
    const plan = await planned(facts())
    expect(plan.turn).toBe(1)
    expect(plan.requirements).toEqual(PLAIN_CHAT)
    expect(plan.request.requirements).toEqual(PLAIN_CHAT)
    expect(plan.request).not.toHaveProperty('workspace')
    expect(plan.request).not.toHaveProperty('previous')
    // The labels of the sandbox carry the lease, which is the chat's own (БП6).
    expect(plan.request.sandbox.labels).toEqual({
      workspaceId: WORKSPACE,
      siteId: TASK,
      taskId: TASK,
      sessionId: TASK,
      turn: 1,
    })
    expect(plan.request.sandbox.network).toEqual({
      mode: 'gateway',
      routes: ['llm', 'mcp'],
      internet: true,
    })
    expect(plan.request.context).toMatchObject({
      llm: { baseUrl: GATEWAY_LLM_URL, model: sampleProviderModelId, reasoningEffort: 'high' },
      egressProxy: SANDBOX_EGRESS_PROXY_URL,
      internet: true,
    })
    expect(plan.request.context.instructions).toContain(
      'You help a small business owner in a chat.',
    )
    expect(plan.request.context.instructions).not.toContain('web_')
    expect(plan.request.input).toEqual({ prompt: 'Посчитайте смету', attachments: [] })
    expect(turnCredentialPolicySchema.parse(plan.policy)).toMatchObject({
      driverId: sampleDriverId,
      backend: sampleBackendId,
      modelSlug: sampleModelSlug,
      modelClass: 'standard',
      reasoningEffort: 'high',
      budgetRub: '270.00',
    })
    expect(() => toTurnPlan(plan.request, sampleDriverId)).not.toThrow()
  })

  it('asks the first pass of a chat for its name, and no later pass', async () => {
    expect((await planned(facts())).request.context.instructions).toContain(CHAT_TITLE_SECTION)
    const later = await planned(
      facts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finished(1, 'completed')]]),
      }),
    )
    expect(later.request.context.instructions).not.toContain(CHAT_TITLE_SECTION)
  })

  it('gives every chat the skills of its workspace, a relayed server without its address (БП11)', async () => {
    const skills: TurnSkill[] = [
      { name: 'context7', kind: 'remote', url: 'https://mcp.context7.com/mcp' },
      { name: 'playwright', kind: 'local' },
      // A server with a key goes through the relay of the role mcp (plan 81): no address here.
      { name: 'menu', kind: 'relayed' },
    ]
    const plan = await planned(facts({ skills }))
    expect(plan.request.context).toMatchObject({ internet: true, skills })
    expect(plan.request.context.instructions).toContain('context7, playwright, menu')
    expect(toTurnPlan(plan.request, sampleDriverId).context.skills).toEqual(skills)
    const bare = await planned(facts({ skills: [] }))
    expect(bare.request.context).not.toHaveProperty('skills')
  })

  it('names the variables of the workspace to the agent, never their values (БП4)', async () => {
    const plan = await planned(facts({ variables: ['PAYMENT_KEY'] }))
    expect(plan.request.context.instructions).toContain('of the client: PAYMENT_KEY.')
    expect((await planned(facts())).request.context.instructions).not.toContain(
      '## Client variables',
    )
  })

  it('continues the session of a completed turn with the words written after it started', async () => {
    const next = await planned(
      facts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finished(1, 'completed')]]),
        requests: [
          request(10, 'first', 'Посчитайте смету', 0),
          request(12, 'answer', 'И добавьте доставку', 20),
        ],
      }),
    )
    expect(next.turn).toBe(2)
    expect(next.request.previous).toEqual(checkpointOf(1))
    expect(next.request.input.prompt).toBe('И добавьте доставку')
  })

  it('starts a new session after an unsuccessful turn: nothing is replaced', async () => {
    const plan = await planned(
      facts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finished(1, 'failed')]]),
        requests: [request(10, 'first', 'Посчитайте смету', 0), request(11, 'retry', null, 15)],
      }),
    )
    expect(plan.request).not.toHaveProperty('previous')
    expect(plan.request).not.toHaveProperty('replacesTurn')
    expect(plan.request.input.prompt).toBe('Посчитайте смету')
  })

  it('goes back to the checkpoint the undone turn started from, without its words', async () => {
    const plan = await planned(
      facts({
        task: { ...facts().task, turnNo: 2 },
        turns: new Map([
          [1, finished(1, 'completed')],
          [2, finished(2, 'completed', { previous: checkpointOf(1), undone: true })],
        ]),
        requests: [
          request(10, 'first', 'Посчитайте смету', 0),
          request(11, 'answer', 'Уберите доставку', 15),
          request(12, 'command', null, 25, 'turn_undo'),
          request(13, 'answer', 'Лучше округлите суммы', 30),
        ],
      }),
    )
    expect(plan.request.rewound).toBe(true)
    expect(plan.request.previous).toEqual(checkpointOf(1))
    expect(plan.request.input.prompt).toBe('Лучше округлите суммы')
    expect(() => toTurnPlan(plan.request, sampleDriverId)).not.toThrow()
  })

  it('starts a new session after the first turn is undone: its words are gone', async () => {
    const plan = await planned(
      facts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finished(1, 'completed', { undone: true })]]),
        requests: [
          request(10, 'first', 'Удалите смету', 0),
          request(11, 'command', null, 15, 'turn_undo'),
          request(12, 'answer', 'Посчитайте смету', 20),
        ],
      }),
    )
    expect(plan.request.rewound).toBe(true)
    expect(plan.request).not.toHaveProperty('previous')
    expect(plan.request.input.prompt).toBe('Посчитайте смету')
  })

  it('asks the turn for `/compact` over the session of the last turn, and tells it no words', async () => {
    const plan = await planned(
      facts({
        task: { ...facts().task, turnNo: 1 },
        turns: new Map([[1, finished(1, 'completed')]]),
        requests: [
          request(10, 'first', 'Посчитайте смету', 0),
          { ...request(11, 'agent_command', null, 11), action: 'compact' },
        ],
      }),
    )
    expect(plan.request.input.action).toBe('compact')
    expect(plan.request.input.attachments).toEqual([])
    expect(plan.request.input.prompt).not.toContain('смету')
    expect(plan.request.previous?.turn).toBe(1)
  })

  it('puts the files of a chat into the sandbox by path and tells the agent of them', async () => {
    const plan = await planned(
      facts({
        attachments: [
          { id: FILE, fileName: 'смета.pdf', contentType: 'application/pdf', sizeBytes: 2048 },
        ],
      }),
    )
    expect(plan.request.input.attachments).toEqual([`/workspace/inbox/${FILE}/смета.pdf`])
    expect(plan.request.context.instructions).toContain(
      "- The client's files are in /workspace/inbox: read them there.",
    )
    // Without the browser the words stay the client's alone.
    expect(plan.request.input.prompt).toBe('Посчитайте смету')
  })

  it('lists the files of a chat with the browser by path and by the id `web_upload` takes', async () => {
    const plan = await planned(
      facts({
        requirements: { ...BROWSER_ONLY },
        attachments: [
          { id: FILE, fileName: 'смета.pdf', contentType: 'application/pdf', sizeBytes: 2048 },
        ],
      }),
    )
    expect(plan.request.context.instructions).toContain('open any public `https://` site')
    expect(plan.request.input.prompt).toContain(
      `- ${FILE}: смета.pdf, application/pdf, 2.0 KiB, at /workspace/inbox/${FILE}/смета.pdf`,
    )
    // Without files a chat with the browser is told nothing more.
    const bare = await planned(facts({ requirements: { ...BROWSER_ONLY } }))
    expect(bare.request.input.prompt).toBe('Посчитайте смету')
  })

  it('goes on without a word of `web_*` while core has no browser worker (§5.4)', async () => {
    const plan = await planned(
      facts({ requirements: { ...BROWSER_ONLY } }),
      env({ browser: false }),
    )
    expect(plan.request.context.instructions).not.toContain('web_')
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
      question: { v: 1, kind: 'ceiling', turn: 2, reason: 'step', spent: 45, held: 89, left: 44 },
    })
  })

  it('takes the class ceiling for a task that holds no reserve by design', async () => {
    const plan = await planTurn(facts({ budget: { kind: 'quota' } }), env())
    expect(plan.kind === 'turn' && plan.policy.budgetRub).toBe('285.00')
  })

  it('refuses what cannot be planned', async () => {
    expect(await planTurn(facts({ profile: null }), env())).toEqual({
      kind: 'refused',
      code: 'unavailable',
    })
    expect(await planTurn(facts(), env({ backends: [] }))).toEqual({
      kind: 'refused',
      code: 'unavailable',
    })
    // A completed turn whose plan no longer passes its schema cannot be continued.
    const unreadable = { ...finished(1, 'completed'), plan: null }
    expect(
      await planTurn(
        facts({ task: { ...facts().task, turnNo: 1 }, turns: new Map([[1, unreadable]]) }),
        env(),
      ),
    ).toEqual({ kind: 'refused', code: 'technical' })
  })

  it('ends the instructions with the client’s own, absent when the client wrote none (И2)', async () => {
    const plan = await planned(facts({ clientInstructions: 'Мы — кофейня. Отвечайте коротко.' }))
    expect(plan.request.context.instructions).toContain(
      '<client-instructions>\nМы — кофейня. Отвечайте коротко.\n</client-instructions>',
    )
    expect((await planned(facts())).request.context.instructions).not.toContain(
      'client-instructions',
    )
  })
})

describe('turnInboxOf', () => {
  it('takes the latest files, as many as one turn holds, in the order they were sent', () => {
    const big = { contentType: 'application/pdf', sizeBytes: 20 * 1024 * 1024 }
    const files = [
      { ...big, id: OLDER, fileName: 'старое.pdf' },
      ...Array.from({ length: 10 }, (_, index) => ({
        ...big,
        id: `0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1b${String(index).padStart(2, '0')}`,
        fileName: `файл-${index}.pdf`,
      })),
    ]
    const inbox = turnInboxOf(files)
    expect(inbox.paths).toHaveLength(10)
    expect(inbox.omitted).toBe(1)
    expect(inbox.paths[0]).toContain('файл-0.pdf')
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

  it('does not carry out an old command of the platform again when a new session retells the chat', () => {
    const init = request(12, 'agent_command', INIT_PROMPT, 30)
    const requests = [
      request(10, 'first', 'Телефон', 0),
      init,
      request(13, 'answer', 'Теперь поменяйте адрес', 40),
    ]
    expect(promptOf(requests, null)).toBe('Телефон\n\nТеперь поменяйте адрес')
    expect(promptOf([request(10, 'first', 'Телефон', 0), init], at(20))).toBe(INIT_PROMPT)
  })
})

describe('a pass of a run of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп17, Зп29)', () => {
  it('tells a pass without its client of its task, and asks no name of the chat', async () => {
    const words = [request(10, 'first', 'Пришли курс доллара по ЦБ на сегодня', 0)]
    const plan = await planned(facts({ requests: words, unattended: { name: 'Курс валют' } }))
    const { instructions } = plan.request.context
    expect(instructions).toContain('## A run of a scheduled task')
    expect(instructions).toContain('«Курс валют» started this chat')
    // The chat of a run has the name of its task (Зп17).
    expect(instructions).not.toContain(CHAT_TITLE_SECTION)
    const plain = await planned(facts({ requests: words }))
    expect(plain.request.context.instructions).not.toContain('## A run of a scheduled task')
  })
})
