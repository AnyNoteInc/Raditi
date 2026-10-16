import { describe, expect, it } from 'vitest'

import { isDomainError, isTooLarge } from '../errors.ts'
import { agentOutputLimits, preparedRunLimits } from '../ports/agent-driver.ts'
import { SANDBOX_SECRETS_DIR } from '../ports/sandbox-provider.ts'
import { isSnapshotCredential } from '../ports/turn-runner.ts'
import {
  coreStopping,
  isCoreStopping,
  parseRunnerToken,
  runnerApiErrors,
  runnerBundlePath,
  runnerCandidatePath,
  runnerCommandSchema,
  runnerConflictSchema,
  runnerErrorSchema,
  runnerFailure,
  runnerFailureCodes,
  runnerIdSchema,
  runnerKeyPath,
  runnerLimits,
  runnerPollRequestSchema,
  runnerPollResponseSchema,
  runnerReportSchema,
  runnerUnavailable,
} from './protocol.ts'

const digest = 'a'.repeat(64)
const ids = {
  site: '22222222-2222-4222-8222-222222222222',
  task: '11111111-1111-4111-8111-111111111111',
  assignment: '33333333-3333-4333-8333-333333333333',
  command: '44444444-4444-4444-8444-444444444444',
  session: '55555555-5555-4555-8555-555555555555',
}
const fence = { siteId: ids.site, taskId: ids.task, operation: 'turn', epoch: 7 } as const
const labels = {
  workspaceId: 'ws-1',
  siteId: ids.site,
  taskId: ids.task,
  sessionId: 'session-1',
  turn: 2,
  leaseEpoch: 7,
}
const envelope = { commandId: ids.command, assignmentId: ids.assignment, fence, ttlMs: 30_000 }
const get = (key: string) => ({
  method: 'GET',
  url: `https://s3.local/raditi-sessions/${key}?X-Amz-Signature=abc`,
  headers: {},
})
const manifest = {
  schemaVersion: 1,
  workspaceId: 'ws-1',
  sessionId: 'session-1',
  turn: 1,
  createdAt: '2026-09-27T10:00:00.000Z',
  image: `registry.local/raditi/sbx@sha256:${digest}`,
  driver: { id: 'opencode', version: '1.18.34' },
  home: {
    root: '/agent-home/opencode',
    include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
    exclude: [],
  },
  git: { provider: 'gitea', branch: 'agent/t', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
  parts: (['home', 'untracked', 'patch'] as const).map((name) => ({
    name,
    key: `sessions/session-1/turns/0001/${{ home: 'home.tar.zst', untracked: 'untracked.tar.zst', patch: 'patch.diff' }[name]}`,
    sha256: 'd'.repeat(64),
    sizeBytes: 10,
    encryption: {
      algorithm: 'aes-256-gcm',
      keyId: 'ws-ws-1',
      wrappedKey: 'vault:v1:wrapped',
      iv: 'e'.repeat(24),
      tag: 'f'.repeat(32),
    },
  })),
}
const prepare = () => ({
  ...envelope,
  type: 'prepare',
  sandbox: {
    image: `registry.local/raditi/sbx@sha256:${digest}`,
    labels,
    runtime: 'runsc',
    resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
    user: { uid: 10001, gid: 10001 },
    env: {},
    secrets: [],
    network: { mode: 'gateway', routes: ['llm', 'mcp'] },
    hardTimeoutMs: 600_000,
  },
  remainingMs: 600_000,
  bundle: { baseSha: 'b'.repeat(40), branch: `agent/${ids.task}`, sha256: digest, sizeBytes: 1024 },
  restore: {
    manifest,
    parts: {
      home: get('sessions/session-1/turns/0001/home.tar.zst'),
      untracked: get('sessions/session-1/turns/0001/untracked.tar.zst'),
      patch: get('sessions/session-1/turns/0001/patch.diff'),
    },
  },
  driverId: 'opencode',
  prepared: {
    files: [
      { path: '/agent-home/opencode/.config/opencode/opencode.json', content: '{"model":"m"}' },
    ],
    env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    secrets: [{ path: '/run/raditi/secrets/llm', content: 'sk-turn-llm-key' }],
  },
  argv: ['opencode', 'run', 'task'],
  credentials: ['sk-turn-llm-key', 'mcp-turn-token'],
})
const sealCommand = () => {
  const { parts: _parts, ...base } = manifest
  return {
    ...envelope,
    type: 'seal',
    base: {
      ...base,
      turn: 2,
      git: { ...manifest.git, publication: { taskId: ids.task, committedAt: manifest.createdAt } },
    },
    sizeBytes: 10,
    put: {
      method: 'PUT',
      url: 'https://s3.local/raditi-sessions/sessions/session-1/turns/0002/home.tar.zst?X-Amz-Signature=abc',
      headers: { 'if-none-match': '*' },
    },
  }
}

describe('runner commands', () => {
  // Ids the platform once had: the three shells removed with the move to one shell, and the two
  // provider ids of theirs, which were never a driver.
  it.each(['gigacode', 'sourcecraft', 'codex', 'kimi', 'qwen', 'openai-chatgpt', 'kimi-code'])(
    'refuses removed driver %s when preparing or adopting work',
    (driverId) => {
      const commands = [
        { value: { ...prepare(), driverId }, path: ['driverId'] },
        {
          value: {
            ...envelope,
            type: 'adopt',
            containerId: 'c1',
            labels,
            purpose: 'work',
            work: { remainingMs: 60_000, driverId },
          },
          path: ['work', 'driverId'],
        },
      ]
      for (const { value, path } of commands) {
        const result = runnerCommandSchema.safeParse(value)
        expect(result.success).toBe(false)
        if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([path])
      }
    },
  )
  it('accepts a full prepare and every other command', () => {
    expect(runnerCommandSchema.parse(prepare())).toMatchObject({ type: 'prepare' })
    for (const cmd of [
      { ...envelope, type: 'launch', timeoutMs: 420_000 },
      {
        ...envelope,
        type: 'resume',
        execId: 'exec-1',
        cursor: { stdout: 10, stderr: 0 },
        eventCount: 3,
      },
      { ...envelope, type: 'quiesce' },
      {
        ...envelope,
        type: 'capture',
        home: {
          root: '/agent-home/opencode',
          include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
          exclude: [],
        },
        baseSha: 'b'.repeat(40),
      },
      sealCommand(),
      { ...envelope, type: 'abort' },
      { ...envelope, type: 'destroy', reason: 'timeout' },
      { ...envelope, type: 'adopt', containerId: 'c1', labels, purpose: 'removal' },
      {
        ...envelope,
        type: 'adopt',
        containerId: 'c1',
        labels,
        purpose: 'work',
        work: { remainingMs: 60_000, driverId: 'opencode' },
      },
    ])
      expect(runnerCommandSchema.safeParse(cmd).success, JSON.stringify(cmd.type)).toBe(true)
  })

  it.each([
    ['an unknown field', { ...prepare(), debug: true }],
    ['an unknown type', { ...envelope, type: 'exec', argv: ['sh'] }],
    [
      'turn secrets in the sandbox spec',
      {
        ...prepare(),
        sandbox: { ...prepare().sandbox, secrets: [{ path: '/run/raditi/secrets/x', value: 'v' }] },
      },
    ],
    [
      'labels of another site',
      {
        ...prepare(),
        sandbox: { ...prepare().sandbox, labels: { ...labels, siteId: ids.task } },
      },
    ],
    [
      'labels of another epoch',
      {
        ...prepare(),
        sandbox: { ...prepare().sandbox, labels: { ...labels, leaseEpoch: 6 } },
      },
    ],
    ['a container outliving the turn', { ...prepare(), remainingMs: 599_999 }],
    [
      'a restore part as PUT',
      {
        ...prepare(),
        restore: {
          ...prepare().restore,
          parts: { ...prepare().restore.parts, home: { ...get('k'), method: 'PUT' } },
        },
      },
    ],
    [
      'a presigned URL with credentials',
      {
        ...prepare(),
        restore: {
          ...prepare().restore,
          parts: {
            ...prepare().restore.parts,
            patch: { ...get('k'), url: 'https://user:pass@s3.local/k' },
          },
        },
      },
    ],
    [
      'a presigned request that is not a URL',
      {
        ...prepare(),
        restore: {
          ...prepare().restore,
          parts: { ...prepare().restore.parts, patch: { ...get('k'), url: 'not a url' } },
        },
      },
    ],
    [
      'a presigned file URL',
      {
        ...prepare(),
        restore: {
          ...prepare().restore,
          parts: { ...prepare().restore.parts, patch: { ...get('k'), url: 'file:///etc/passwd' } },
        },
      },
    ],
    [
      'a driver file in the working copy',
      {
        ...prepare(),
        prepared: {
          ...prepare().prepared,
          files: [{ path: '/workspace/repo/AGENTS.md', content: 'x' }],
        },
      },
    ],
    [
      'a bundle above its limit',
      { ...prepare(), bundle: { ...prepare().bundle, sizeBytes: 64 * 1024 * 1024 + 1 } },
    ],
    [
      'a bundle branch that git would read as an option',
      { ...prepare(), bundle: { ...prepare().bundle, branch: '--upload-pack=touch' } },
    ],
    ['no credentials', { ...prepare(), credentials: [] }],
    [
      'a stale fence field',
      { ...prepare(), fence: { ...fence, expiresAt: '2026-09-27T10:00:00Z' } },
    ],
    [
      'a seal PUT that may overwrite',
      { ...sealCommand(), put: { ...sealCommand().put, headers: {} } },
    ],
    [
      'a seal base with parts',
      { ...sealCommand(), base: { ...sealCommand().base, parts: manifest.parts } },
    ],
    [
      'a seal base without headSha',
      {
        ...sealCommand(),
        base: { ...sealCommand().base, git: { ...manifest.git, headSha: undefined } },
      },
    ],
    [
      'adoption for work without its state',
      { ...envelope, type: 'adopt', containerId: 'c1', labels, purpose: 'work' },
    ],
    [
      'a removal with turn state',
      {
        ...envelope,
        type: 'adopt',
        containerId: 'c1',
        labels,
        purpose: 'removal',
        work: { remainingMs: 60_000, driverId: 'opencode' },
      },
    ],
  ])('refuses %s', (_label, cmd) => {
    expect(runnerCommandSchema.safeParse(cmd).success).toBe(false)
  })
})

describe('runner credentials', () => {
  it('carry every credential a checked prepared run can have, and no more', () => {
    const secrets = Array.from({ length: preparedRunLimits.secretFiles }, (_, i) => ({
      path: `${SANDBOX_SECRETS_DIR}/s${i}`,
      content: `${i}`.padEnd(preparedRunLimits.secretChars, 'x'),
    }))
    const credentials = [
      'k'.repeat(preparedRunLimits.secretChars),
      'mcp-turn-token',
      ...secrets.map((file) => file.content),
    ]
    expect(credentials).toHaveLength(runnerLimits.credentials)
    const full = { ...prepare(), prepared: { ...prepare().prepared, secrets }, credentials }
    expect(runnerCommandSchema.safeParse(full).success).toBe(true)
    const adopt = (values: string[]) => ({
      ...envelope,
      type: 'adopt',
      containerId: 'c1',
      labels,
      purpose: 'work',
      work: { remainingMs: 1_000, driverId: 'opencode', credentials: values },
    })
    expect(runnerCommandSchema.safeParse(adopt(credentials)).success).toBe(true)
    for (const values of [
      [...credentials, 'one more'],
      ['k'.repeat(preparedRunLimits.secretChars + 1)],
    ]) {
      expect(runnerCommandSchema.safeParse({ ...full, credentials: values }).success).toBe(false)
      expect(runnerCommandSchema.safeParse(adopt(values)).success).toBe(false)
    }
  })
})

describe('runner events of a turn', () => {
  it('are bounded by the per-turn limit both executors apply', () => {
    expect(runnerLimits.events).toBe(agentOutputLimits.turnEvents)
    const resume = (eventCount: number) => ({
      ...envelope,
      type: 'resume',
      execId: 'exec-1',
      cursor: { stdout: 0, stderr: 0 },
      eventCount,
    })
    expect(runnerCommandSchema.safeParse(resume(agentOutputLimits.turnEvents)).success).toBe(true)
    expect(runnerCommandSchema.safeParse(resume(agentOutputLimits.turnEvents + 1)).success).toBe(
      false,
    )
  })
})

describe('runner reports', () => {
  const base = { runnerSession: ids.session, assignmentId: ids.assignment, epoch: 7 }
  const output = (events: unknown[], to = { stdout: 20, stderr: 5 }) => ({
    ...base,
    type: 'output',
    execId: 'exec-1',
    from: { stdout: 10, stderr: 5 },
    to,
    events,
  })

  it('accepts every report kind', () => {
    for (const value of [
      { ...base, type: 'created', commandId: ids.command, containerId: 'c1' },
      { ...base, type: 'prepared', commandId: ids.command, containerId: 'c1' },
      { ...base, type: 'running', commandId: ids.command, execId: 'exec-1' },
      output([{ type: 'message', text: 'Готово' }]),
      output([], { stdout: 10, stderr: 5 }),
      { ...base, type: 'exited', execId: 'exec-1', exit: { code: 0, reason: 'exited' } },
      { ...base, type: 'quiesced', commandId: ids.command },
      {
        ...base,
        type: 'captured',
        commandId: ids.command,
        homeBytes: 100,
        patch: { sha256: digest, sizeBytes: 0 },
        untracked: { sha256: digest, sizeBytes: 50 },
      },
      {
        ...base,
        type: 'sealed',
        commandId: ids.command,
        sha256: digest,
        sizeBytes: 100,
        iv: 'e'.repeat(24),
        tag: 'f'.repeat(32),
      },
      { ...base, type: 'destroyed', containerId: 'c1' },
      { ...base, type: 'failed', code: 'EXEC_LOST' },
    ])
      expect(runnerReportSchema.safeParse(value).success, value.type).toBe(true)
  })

  it('refuses a cursor that moves backwards, an oversized batch and invalid events', () => {
    expect(runnerReportSchema.safeParse(output([], { stdout: 9, stderr: 5 })).success).toBe(false)
    const text = 'x'.repeat(20_000)
    const events = Array.from({ length: 60 }, () => ({ type: 'message', text }))
    expect(runnerReportSchema.safeParse(output(events)).success).toBe(false)
    expect(runnerReportSchema.safeParse(output(events.slice(0, 50))).success).toBe(true)
    expect(runnerReportSchema.safeParse(output([{ type: 'shell', command: 'rm' }])).success).toBe(
      false,
    )
  })

  it('takes `absent` only as the answer to a command', () => {
    const failed = { ...base, type: 'failed', code: 'SANDBOX_COMMAND_FAILED', absent: true }
    expect(runnerReportSchema.safeParse({ ...failed, commandId: ids.command }).success).toBe(true)
    expect(runnerReportSchema.safeParse(failed).success).toBe(false)
    expect(
      runnerReportSchema.safeParse({ ...failed, commandId: ids.command, absent: false }).success,
    ).toBe(false)
  })

  it('refuses free text in a failure and parts above their limits', () => {
    expect(
      runnerReportSchema.safeParse({ ...base, type: 'failed', code: 'EXEC_LOST', message: 'x' })
        .success,
    ).toBe(false)
    expect(runnerReportSchema.safeParse({ ...base, type: 'failed', code: 'OOPS' }).success).toBe(
      false,
    )
    expect(
      runnerReportSchema.safeParse({
        ...base,
        type: 'captured',
        commandId: ids.command,
        homeBytes: 100,
        patch: { sha256: digest, sizeBytes: 8 * 1024 * 1024 + 1 },
        untracked: { sha256: digest, sizeBytes: 0 },
      }).success,
    ).toBe(false)
  })
})

describe('runner poll and answers', () => {
  it('bounds the poll and requires a session per process', () => {
    const poll = {
      runnerSession: ids.session,
      capacity: 1,
      inventory: [{ containerId: 'c1', labels, ageMs: 1000 }],
      active: [{ assignmentId: ids.assignment, epoch: 7, phase: 'running' }],
    }
    expect(runnerPollRequestSchema.safeParse(poll).success).toBe(true)
    expect(runnerPollRequestSchema.safeParse({ ...poll, runnerSession: 'r1' }).success).toBe(false)
    expect(runnerPollRequestSchema.safeParse({ ...poll, capacity: 65 }).success).toBe(false)
    expect(runnerLimits.capacity).toBe(64)
  })

  it('bounds an answer and leaves each command to its own check', () => {
    // One command the runner cannot read does not drop the others with it.
    expect(runnerPollResponseSchema.safeParse({ commands: [{ type: 'unknown' }] }).success).toBe(
      true,
    )
    expect(
      runnerPollResponseSchema.safeParse({ commands: Array(runnerLimits.commands + 1).fill({}) })
        .success,
    ).toBe(false)
    expect(runnerPollResponseSchema.safeParse({ commands: [], extra: true }).success).toBe(false)
  })

  it('knows the four conflicts', () => {
    expect(runnerConflictSchema.parse({ error: 'FENCE_SUPERSEDED', fence })).toEqual({
      error: 'FENCE_SUPERSEDED',
      fence,
    })
    expect(runnerConflictSchema.safeParse({ error: 'LEASE_LOST' }).success).toBe(true)
    expect(
      runnerConflictSchema.safeParse({
        error: 'CURSOR_MISMATCH',
        expected: { stdout: 1, stderr: 0 },
      }).success,
    ).toBe(true)
    expect(runnerConflictSchema.safeParse({ error: 'LEASE_LOST', fence }).success).toBe(false)
    expect(runnerConflictSchema.parse({ error: 'SESSION_RETIRED' })).toEqual({
      error: 'SESSION_RETIRED',
    })
    expect(runnerConflictSchema.safeParse({ error: 'SESSION_RETIRED', fence }).success).toBe(false)
  })

  it('answers every other refusal with a bare code', () => {
    expect(runnerErrorSchema.parse({ error: 'COMMAND_CLOSED' })).toEqual({
      error: 'COMMAND_CLOSED',
    })
    expect(runnerApiErrors.COMMAND_CLOSED).toBe(410)
    expect(runnerErrorSchema.safeParse({ error: 'COMMAND_CLOSED', detail: 'x' }).success).toBe(
      false,
    )
    expect(runnerErrorSchema.safeParse({ error: 'LEASE_LOST' }).success).toBe(false)
  })

  it('builds endpoint paths only from an assignment uuid', () => {
    expect(runnerBundlePath(ids.assignment)).toBe(`/runner/v1/assignments/${ids.assignment}/bundle`)
    expect(runnerKeyPath(ids.assignment, 'seal')).toBe(
      `/runner/v1/assignments/${ids.assignment}/keys/seal`,
    )
    expect(runnerCandidatePath(ids.assignment, 'patch')).toBe(
      `/runner/v1/assignments/${ids.assignment}/candidate/patch`,
    )
    expect(() => runnerBundlePath('../poll')).toThrow()
  })
})

describe('runner identity', () => {
  const secret = 'A'.repeat(42) + 'g'
  it('reads the runner id from a well-formed token only', () => {
    expect(parseRunnerToken(`rnr_sandbox-1.${secret}`)).toEqual({ runnerId: 'sandbox-1' })
    expect(runnerIdSchema.safeParse('sandbox-1').success).toBe(true)
    expect(runnerIdSchema.safeParse('Sandbox_1').success).toBe(false)
    for (const token of [
      `rnr_sandbox-1.${secret.slice(1)}`,
      `rnr_Sandbox.${secret}`,
      `rnr_-x.${secret}`,
      `rnr_sandbox-1.${secret}\n`,
      `sandbox-1.${secret}`,
      `rnr_sandbox-1.${secret.slice(1)}=`,
    ])
      expect(parseRunnerToken(token)).toBeNull()
  })
})

describe('runner errors', () => {
  it('maps every failure code to a domain error with a message of core', () => {
    for (const code of runnerFailureCodes) {
      const error = runnerFailure(code)
      expect(isDomainError(error)).toBe(true)
      expect(error.httpStatus).toBeGreaterThanOrEqual(409)
    }
    expect(isSnapshotCredential(runnerFailure('SNAPSHOT_CREDENTIAL'))).toBe(true)
    expect(isTooLarge(runnerFailure('SNAPSHOT_TOO_LARGE'))).toBe(true)
    expect(runnerFailure('CREDENTIALS_LOST')).toMatchObject({ code: 'EXEC_LOST', httpStatus: 502 })
    expect(runnerUnavailable()).toMatchObject({ code: 'RUNNER_UNAVAILABLE', httpStatus: 503 })
  })

  it('tells a stopping core from a runner that cannot be reached', () => {
    expect(coreStopping()).toMatchObject({ code: 'CORE_STOPPING', httpStatus: 503 })
    expect(isCoreStopping(coreStopping())).toBe(true)
    expect(isCoreStopping(runnerUnavailable('Core is shutting down'))).toBe(false)
    expect(isCoreStopping(new Error('CORE_STOPPING'))).toBe(false)
  })
})
