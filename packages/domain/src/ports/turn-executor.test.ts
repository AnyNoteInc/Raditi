import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  BROWSER_ONLY,
  PLAIN_CHAT,
  REPOSITORY_ONLY,
  requirementsOf,
} from '../tasks/task-requirements.ts'
import { SANDBOX_WORKSPACE_TMPFS_BYTES } from './sandbox-provider.ts'
import {
  assertTurnInbox,
  assertTurnProjectFiles,
  turnProjectFileName,
  turnProjectFilesLimits,
  turnProjectPath,
  turnWorkspaceBudget,
  turnMayHoldInbox,
  toTurnPlan,
  turnInboxAttachmentId,
  turnInboxLimits,
  turnInboxPath,
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

  it('keeps the egress proxy of client variables and never their values (Р13)', () => {
    const original = request()
    original.sandbox.network = {
      mode: 'gateway',
      routes: ['llm', 'mcp'],
      egress: ['api.example.ru:443'],
    }
    original.context.egressProxy = 'http://sandbox-gw:3128'
    original.context.envValues = { PAYMENT_KEY: 'pay-secret-0001' }
    const unkeyed = withoutTurnCredentials(original)
    expect(unkeyed.context).not.toHaveProperty('envValues')
    const plan = toTurnPlan(unkeyed, 'opencode')
    expect(JSON.stringify(plan)).not.toContain('pay-secret-0001')
    expect(plan.context.egressProxy).toBe('http://sandbox-gw:3128')
    expect(plan.sandbox.network).toEqual(original.sandbox.network)
    // A request that still carries the values is not a plan.
    expect(() => toTurnPlan(original, 'opencode')).toThrow('Invalid turn plan')
    const restored = turnPlanSchema.parse(JSON.parse(JSON.stringify(plan)))
    expect(
      withTurnCredentials(restored, {
        llmApiKey: 'sk-turn-llm-key',
        mcpToken: 'mcp-turn-token',
        envValues: { PAYMENT_KEY: 'pay-secret-0001' },
      }),
    ).toEqual(original)
    // No variables: no field at all, as before Р13.
    const bare = withTurnCredentials(restored, { llmApiKey: 'k', mcpToken: 't', envValues: {} })
    expect(bare.context).not.toHaveProperty('envValues')
    expect(() =>
      toTurnPlan(
        { ...unkeyed, context: { ...unkeyed.context, egressProxy: 'http://u:p@sandbox-gw:3128' } },
        'opencode',
      ),
    ).toThrow('Invalid turn plan')
  })

  it('keeps the open internet and the skills of a turn, only with the egress proxy (26.10.2026)', () => {
    const original = request()
    original.sandbox.network = { mode: 'gateway', routes: ['llm', 'mcp'], internet: true }
    original.context.egressProxy = 'http://sandbox-gw:3128'
    original.context.internet = true
    original.context.skills = [
      { name: 'context7', kind: 'remote', url: 'https://mcp.context7.com/mcp' },
      { name: 'playwright', kind: 'local' },
    ]
    const plan = toTurnPlan(withoutTurnCredentials(original), 'opencode')
    expect(plan.context).toMatchObject({ internet: true, skills: original.context.skills })
    expect(plan.sandbox.network).toEqual(original.sandbox.network)
    const restored = turnPlanSchema.parse(JSON.parse(JSON.stringify(plan)))
    expect(
      withTurnCredentials(restored, { llmApiKey: 'sk-turn-llm-key', mcpToken: 'mcp-turn-token' }),
    ).toEqual(original)
    const unkeyed = withoutTurnCredentials(original)
    const refused = (context: Partial<typeof unkeyed.context>) =>
      expect(() =>
        toTurnPlan({ ...unkeyed, context: { ...unkeyed.context, ...context } }, 'opencode'),
      ).toThrow('Invalid turn plan')
    refused({ egressProxy: undefined })
    refused({ internet: undefined })
    refused({ skills: [{ name: 'docs', kind: 'remote', url: 'http://docs.example.org/mcp' }] })
    refused({ skills: [{ name: 'raditi', kind: 'remote', url: 'https://docs.example.org/mcp' }] })
    refused({ skills: [{ name: 'selenium', kind: 'local' } as never] })
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

  it('refuses a plan of a turn with a repository, as one stored before plan 83 was', () => {
    const stored = JSON.parse(JSON.stringify(toTurnPlan(request(), 'opencode')))
    for (const legacy of [
      { workspace: { branch: `agent/${taskId}` } },
      { replacesTurn: 1 },
      { rebased: true },
      { requirements: REPOSITORY_ONLY },
    ])
      expect(turnPlanSchema.safeParse({ ...stored, ...legacy }).success).toBe(false)
    // Without requirements a plan needs nothing.
    expect(requirementsOf(turnPlanSchema.parse(stored))).toEqual(PLAIN_CHAT)
  })

  it('keeps the repository of a turn of a project (docs/plan/84-projects.md, §4.3)', () => {
    const repo: TurnRequest = {
      ...request(),
      requirements: REPOSITORY_ONLY,
      repository: repositoryBlock(),
    }
    const plan = turnPlanSchema.parse(
      JSON.parse(JSON.stringify(toTurnPlan(withoutTurnCredentials(repo), 'opencode'))),
    )
    expect(plan.repository).toEqual(repositoryBlock())
    expect(withTurnCredentials(plan, { llmApiKey: 'k', mcpToken: 't' }).repository).toEqual(
      repositoryBlock(),
    )
    // A token or an address of the repository is never kept in the plan.
    for (const extra of [{ token: 'glpat-x' }, { cloneUrl: 'https://gitlab.com/a/b.git' }])
      expect(
        turnPlanSchema.safeParse({ ...plan, repository: { ...plan.repository, ...extra } }).success,
      ).toBe(false)
    expect(
      turnPlanSchema.safeParse({
        ...plan,
        repository: { ...plan.repository, hiddenPaths: Array(201).fill('.env') },
      }).success,
    ).toBe(false)
  })

  it('keeps a turn of a chat with the browser: its requirements carried both ways', () => {
    const browser: TurnRequest = { ...request(), requirements: BROWSER_ONLY }
    const unkeyed = withoutTurnCredentials(browser)
    expect(unkeyed.requirements).toEqual(BROWSER_ONLY)
    const plan = toTurnPlan(unkeyed, 'opencode')
    expect(plan).not.toHaveProperty('workspace')
    expect(plan.requirements).toEqual({ repository: false, browser: true })
    expect(JSON.stringify(plan)).not.toMatch(/sk-turn-llm-key|mcp-turn-token/)
    const restored = turnPlanSchema.parse(JSON.parse(JSON.stringify(plan)))
    expect(requirementsOf(restored)).toEqual(BROWSER_ONLY)
    // The previous turn's snapshot chains the session as before.
    expect(restored.previous).toEqual(browser.previous)
    expect(
      withTurnCredentials(restored, { llmApiKey: 'sk-turn-llm-key', mcpToken: 'mcp-turn-token' }),
    ).toEqual(browser)
  })

  it('keeps a turn that needs nothing: a chat without the browser', () => {
    const chat: TurnRequest = { ...request(), requirements: PLAIN_CHAT }
    const plan = toTurnPlan(withoutTurnCredentials(chat), 'opencode')
    expect(plan).not.toHaveProperty('workspace')
    expect(plan.requirements).toEqual(PLAIN_CHAT)
    expect(requirementsOf(turnPlanSchema.parse(JSON.parse(JSON.stringify(plan))))).toEqual(
      PLAIN_CHAT,
    )
  })

  it('keeps «rewound» of a turn after `/undo`, absent otherwise', () => {
    const chat: TurnRequest = { ...request(), requirements: PLAIN_CHAT, rewound: true }
    const plan = turnPlanSchema.parse(toTurnPlan(withoutTurnCredentials(chat), 'opencode'))
    expect(plan.rewound).toBe(true)
    expect(withTurnCredentials(plan, { llmApiKey: 'k', mcpToken: 't' }).rewound).toBe(true)
    expect(toTurnPlan(withoutTurnCredentials(request()), 'opencode')).not.toHaveProperty('rewound')
  })

  it.each([
    ['«rewound» that is not true', { requirements: BROWSER_ONLY, rewound: false }, ['rewound']],
    ['a repository without its block', { requirements: REPOSITORY_ONLY }, []],
    ['a block of a repository it does not need', { repository: repositoryBlock() }, []],
    ['an unknown need', { requirements: { ...PLAIN_CHAT, database: true } }, ['requirements']],
  ])('refuses %s', (_label, change, path) => {
    const plan = { ...toTurnPlan(request(), 'opencode'), ...change }
    const stored = JSON.parse(JSON.stringify(plan))
    const result = turnPlanSchema.safeParse(stored)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([path])
    expect(() => toTurnPlan({ ...request(), ...change } as TurnRequest, 'opencode')).toThrow(
      'Invalid turn plan',
    )
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

describe('files of the client in a turn', () => {
  const id = '0199a3f2-0000-7000-8000-0000000000F1'
  const file = (index: number, sizeBytes = 1024) => ({
    path: turnInboxPath(`0199a3f2-0000-7000-8000-${String(index).padStart(12, '0')}`, 'a.png')!,
    sizeBytes,
  })
  const refusal = (run: () => void) => {
    try {
      run()
    } catch (error) {
      return isDomainError(error) ? error.code : 'other'
    }
    return null
  }

  it('puts each file in a folder of its id, under the name the client gave it', () => {
    const path = turnInboxPath(id, 'Фото 1, меню.png')
    expect(path).toBe('/workspace/inbox/0199a3f2-0000-7000-8000-0000000000f1/Фото 1, меню.png')
    expect(turnInputSchema.shape.attachments.safeParse([path]).success).toBe(true)
    expect(turnInboxAttachmentId(path!)).toBe(id.toLowerCase())
  })

  it.each([
    ['an id that is not one', 'not-an-id', 'a.png'],
    ['a name with a separator', id, 'a/b.png'],
    ['a parent segment', id, '..'],
    ['a control character', id, 'a\u0007.png'],
  ])('refuses %s', (_label, attachmentId, name) => {
    expect(turnInboxPath(attachmentId, name)).toBeNull()
  })

  it.each([
    ['another folder', '/workspace/repo/a.png'],
    ['no name', `/workspace/inbox/${id.toLowerCase()}`],
    ['a nested name', `/workspace/inbox/${id.toLowerCase()}/a/b.png`],
    ['an uppercase id', `/workspace/inbox/${id}/a.png`],
  ])('names no attachment by %s', (_label, path) => {
    expect(turnInboxAttachmentId(path)).toBeNull()
  })

  it('takes the files of a turn within the limits', () => {
    const full = Array.from({ length: 10 }, (_, index) => file(index, 20 * 1024 * 1024))
    expect(refusal(() => assertTurnInbox(full, true))).toBeNull()
    expect(refusal(() => assertTurnInbox([], false))).toBeNull()
  })

  it('lets the turn of their chat hold them, never one under another lease (К16)', () => {
    expect(turnMayHoldInbox({ siteId: 'task-id', taskId: 'task-id' })).toBe(true)
    expect(turnMayHoldInbox({ siteId: 'other-id', taskId: 'task-id' })).toBe(false)
  })

  it.each([
    ['a turn of another lease', [file(1)], false],
    ['a path twice', [file(1), file(1)], true],
    ['a path of no attachment', [{ path: '/workspace/inbox/x', sizeBytes: 1 }], true],
    ['an empty file', [file(1, 0)], true],
    ['a file over the limit of one', [file(1, 20 * 1024 * 1024 + 1)], true],
    [
      'more files than a turn holds',
      Array.from({ length: turnInboxLimits.files + 1 }, (_, index) => file(index)),
      true,
    ],
    [
      'more bytes than a turn holds',
      Array.from({ length: 11 }, (_, index) => file(index, 20 * 1024 * 1024)),
      true,
    ],
  ])('refuses %s', (_label, files, mayHold) => {
    expect(refusal(() => assertTurnInbox(files, mayHold))).toBe('BAD_REQUEST')
  })
})

describe('files of the project in a turn (docs/plan/84-projects.md, ПР8)', () => {
  const MIB = 1024 * 1024
  const file = (name: string, sizeBytes = 1024) => ({ path: turnProjectPath(name)!, sizeBytes })
  const refusal = (run: () => void) => {
    try {
      run()
    } catch (error) {
      return isDomainError(error) ? error.code : 'other'
    }
    return null
  }

  it('puts each file at its path under /workspace/project, folders kept', () => {
    expect(turnProjectPath('Фото/витрина.jpg')).toBe('/workspace/project/Фото/витрина.jpg')
    expect(turnProjectFileName('/workspace/project/Фото/витрина.jpg')).toBe('Фото/витрина.jpg')
    expect(turnInputSchema.shape.projectFiles.safeParse(['/workspace/project/a.pdf']).success).toBe(
      true,
    )
    for (const path of [
      '/workspace/project/../inbox/a.pdf',
      '/workspace/project/.hidden',
      '/workspace/project/',
      '/workspace/projectx/a.pdf',
      '/workspace/inbox/a.pdf',
    ])
      expect(turnProjectFileName(path), path).toBeNull()
    expect(turnProjectPath('../a.pdf')).toBeNull()
  })

  it('keeps a plan of before the files valid: `projectFiles` is optional', () => {
    expect(turnInputSchema.safeParse({ prompt: 'x', attachments: [] }).success).toBe(true)
  })

  it('takes a full project — 100 files of 1 MiB — for the turn of its chat', () => {
    const full = Array.from({ length: turnProjectFilesLimits.files }, (_, i) =>
      file(`f${i}.pdf`, MIB),
    )
    expect(refusal(() => assertTurnProjectFiles(full, true))).toBeNull()
    expect(refusal(() => assertTurnProjectFiles([], false))).toBeNull()
  })

  it.each([
    ['a turn of another lease', [file('a.pdf')], false],
    ['a path twice', [file('a.pdf'), file('a.pdf')], true],
    ['a file and a folder of one path', [file('Фото'), file('Фото/a.jpg')], true],
    ['a path outside the project', [{ path: '/workspace/inbox/a.pdf', sizeBytes: 1 }], true],
    ['an empty file', [file('a.pdf', 0)], true],
    ['a file over 20 MiB', [file('a.pdf', 20 * MIB + 1)], true],
    [
      'more files than a project holds',
      Array.from({ length: 101 }, (_, i) => file(`f${i}.pdf`, 1)),
      true,
    ],
    ['more than 100 MiB', Array.from({ length: 6 }, (_, i) => file(`f${i}.pdf`, 20 * MIB)), true],
  ])('refuses %s', (_label, files, mayHold) => {
    expect(refusal(() => assertTurnProjectFiles(files, mayHold))).toBe('BAD_REQUEST')
  })

  it('shares /workspace so the agent keeps at least 568 MiB for its checks (§4.7, plan 97)', () => {
    const plain = turnWorkspaceBudget({ repository: false })
    expect(plain).toEqual({
      workspace: SANDBOX_WORKSPACE_TMPFS_BYTES,
      repository: 0,
      inbox: 200 * MIB,
      project: 100 * MIB,
      skills: 64 * MIB,
      agent: 660 * MIB,
    })
    expect(SANDBOX_WORKSPACE_TMPFS_BYTES).toBe(1024 * MIB)
    expect(plain.inbox).toBe(turnInboxLimits.bytes)
    const repo = turnWorkspaceBudget({ repository: true })
    expect(repo).toMatchObject({ repository: 192 * MIB, inbox: 100 * MIB, project: 100 * MIB })
    expect(repo.agent).toBe(568 * MIB)
    for (const budget of [plain, repo])
      expect(budget.repository + budget.inbox + budget.project + budget.skills + budget.agent).toBe(
        budget.workspace,
      )
  })
})

function repositoryBlock() {
  return {
    projectId: '0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
    projectRepositoryId: '0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c',
    provider: 'gitlab' as const,
    baseSha: 'b'.repeat(40),
    sandboxBaseSha: 'd'.repeat(40),
    branch: 'raditi/chat-0193a1b2c3d4',
    mode: 'write' as const,
    expectedRef: null,
    bundleSha256: 'e'.repeat(64),
    bundleBytes: 1024,
    hiddenPaths: ['.env'],
  }
}
