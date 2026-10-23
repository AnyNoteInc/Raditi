// Synthetic host execution against disposable real WordPress, PostgreSQL, S3 and OpenBao.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { PostgresSiteLeaseStore, PostgresTaskTurnAssignmentStore } from '@repo/db'
import { PostgresMcpAccess } from '../dist/access/mcp-access.js'
import { PostgresMcpJournal } from '../dist/content/mcp-journal.js'
import { McpContentService } from '../dist/content/mcp-content.js'
import { ContentSnapshotStorage } from '../dist/content/content-snapshots.js'
import { ContentPrivacy } from '../dist/privacy/content-privacy.js'
import { McpTurnContentRollback } from '../dist/content/mcp-turn-content-rollback.js'
// The turn supervisor of core's build drives the trusted rollback of this app in one process:
// no network channel from core reaches the role yet (N8).
import { TurnSupervisor } from '../../core/dist/turns/turn-supervisor.js'
import { TaskEventTurnJournal } from '../../core/dist/turns/turn-journal.js'
import { LiveTurns } from '../../core/dist/turns/live-turns.js'
import { sampleBackendId, sampleDriverId } from '../src/testing/ids.ts'
import { verifyContentLifecycle } from './verify-content-lifecycle.mjs'
import { verifyContentUndo } from './verify-content-undo.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')

export async function verifyContentTurns({
  db,
  workspaceId,
  siteId,
  modelId,
  accountId,
  storage,
  secrets,
  observer,
  gateway,
  pageIds,
  origin,
  roleContent,
}) {
  const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
  await db.agentDriver.upsert({
    where: { id: sampleDriverId },
    update: {},
    create: {
      id: sampleDriverId,
      image,
      capabilities: {},
      enabled: true,
    },
  })
  const task = await db.task.create({ data: { workspaceId, siteId, status: 'running' } })
  const sessionId = randomUUID()
  const plan = {
    sandbox: {
      image,
      labels: { workspaceId, siteId, taskId: task.id, sessionId, turn: 1 },
      runtime: 'runc',
      resources: { cpu: 1, memoryMiB: 256, pids: 64 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'none' },
      hardTimeoutMs: 600_000,
    },
    context: {
      taskId: task.id,
      sessionId,
      turn: 1,
      llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' },
      mcp: { url: 'http://synthetic.invalid/mcp' },
      instructions: 'Synthetic content replacement',
    },
    input: { prompt: 'Synthetic', attachments: [] },
    driverId: sampleDriverId,
    driverVersion: '1.0.0',
    workspace: {
      repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
      branch: `agent/${task.id}`,
      expectedBaseSha: 'b'.repeat(40),
      protectedPaths: [],
    },
    committedAt: new Date().toISOString(),
  }
  const leases = new PostgresSiteLeaseStore(db)
  const assignments = new PostgresTaskTurnAssignmentStore(db)
  const journal = new PostgresMcpJournal(db)
  const access = new PostgresMcpAccess(db)
  const turnJournal = new TaskEventTurnJournal(db)
  let rejectSecondRestore = true,
    restoreNo = 0,
    prepared = 0
  const content = new McpContentService(
    journal,
    new ContentSnapshotStorage(storage, secrets),
    new ContentPrivacy(secrets),
    async () => ({
      read: (ref) => gateway.read(ref),
      operation: (id) => gateway.operation(id),
      reconcileOperation: (request) => gateway.reconcileOperation(request),
      forgetOperation: (request) => gateway.forgetOperation(request),
      conditionalWrite: async (input) => {
        if (input.mode === 'restore' && rejectSecondRestore && ++restoreNo === 2)
          return { version: 1, kind: 'rejected', code: 'invalid' }
        return gateway.conditionalWrite(input)
      },
    }),
  )
  // The replacement runs get a key with no MCP access at all: their rollback is admitted by the
  // fence of the site lease, so the token the supervisor was issued must open nothing.
  let mcpAccess = true
  const issuedTokens = []
  const issue = async (ref, grant) => {
    const mcpToken = `mcp_${randomBytes(32).toString('hex')}`
    const llmApiKey = `sk_${randomBytes(32).toString('hex')}`
    issuedTokens.push(mcpToken)
    await db.llmKey.create({
      data: {
        keyHash: hash(llmApiKey),
        mcpTokenHash: mcpAccess ? hash(mcpToken) : null,
        taskId: task.id,
        taskAttempt: 1,
        sessionId,
        turnNo: ref.turn,
        firstEpoch: ref.epoch,
        driverId: sampleDriverId,
        modelId,
        subscriptionAccountId: accountId,
        budgetRub: '100',
        issuedAt: new Date(),
        expiresAt: grant.deadlineAt,
        validUntil: grant.deadlineAt,
      },
    })
    return { mcpToken, llmApiKey }
  }
  const revoke = async (ref) => {
    await db.llmKey.updateMany({
      where: { taskId: task.id, sessionId, turnNo: ref.turn, firstEpoch: ref.epoch },
      data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
    })
  }
  const firstLease = await leases.acquire({
    siteId,
    taskId: task.id,
    operation: 'turn',
    ttlMs: 720_000,
  })
  assert(firstLease)
  const first = await assignments.open({
    fence: firstLease,
    sessionId,
    turn: 1,
    executor: 'local',
    plan,
    remainingMs: 600_000,
  })
  assert(first)
  const firstRef = { taskId: task.id, sessionId, turn: 1, epoch: first.firstEpoch }
  const firstCredentials = await issue(firstRef, first)
  const scope = await access.authenticate(firstCredentials.mcpToken)
  assert(scope)
  const original = await Promise.all(pageIds.map((id) => gateway.read(`page:${id}`)))
  for (const id of pageIds) {
    const result = await content.wpRest(scope, {
      method: 'POST',
      route: `/wp/v2/pages/${id}`,
      body: { title: `Synthetic replacement ${id}` },
      idempotencyKey: `replace:${id}`,
    })
    assert.equal(result.result, 'ok')
  }
  await turnJournal.record({
    fence: firstLease,
    sessionId,
    turn: 1,
    sequence: 1,
    phase: 'completed',
    candidateHeadSha: 'b'.repeat(40),
    nativeSessionId: randomUUID(),
  })
  await revoke(firstRef)
  assert(await leases.release(firstLease))
  assert(await assignments.finish({ id: first.id, epoch: firstLease.epoch, outcome: 'completed' }))
  const persisted = await db.taskTurn.findFirstOrThrow({ where: { taskId: task.id } })
  assert.equal(persisted.status, 'completed')
  assert.equal(persisted.modelId, modelId)
  assert(persisted.nativeSessionId)
  assert(persisted.finishedAt)
  const supervisor = new TurnSupervisor({
    leases,
    assignments,
    journal: turnJournal,
    live: new LiveTurns(),
    credentials: { issue, revoke, recover: async () => null },
    contentRollback: new McpTurnContentRollback(journal, content),
    driver: {
      id: sampleDriverId,
      prepare: async (context) => ({ context, files: [], env: {}, secrets: [] }),
      command: () => ['synthetic-agent'],
    },
    executor: {
      kind: 'local',
      prepare: async () => {
        prepared++
        // The undo is over and the token of this turn never admitted anything.
        assert.equal(await access.authenticate(issuedTokens.at(-1)), null)
        for (const state of original) assert.deepEqual(await gateway.read(state.objectRef), state)
        // The gate passed. No actual sandbox is needed for this host-undo fixture.
        throw new Error('synthetic_gate_passed')
      },
    },
    workspace: {
      buildBaseBundle: async () => ({ bytes: Buffer.alloc(0), baseSha: 'b'.repeat(40) }),
    },
    snapshots: {},
    logger: { warn: () => {} },
  })
  const policy = {
    driverId: sampleDriverId,
    backend: sampleBackendId,
    modelSlug: 'synthetic',
    modelClass: 'standard',
    reasoningEffort: null,
    ttlMs: 600_000,
    budgetRub: '100.00',
  }
  const replace = (turn) => {
    const { driverId: _driverId, ...request } = plan
    return {
      ...request,
      replacesTurn: turn - 1,
      workspace: { ...request.workspace, expectedBranchSha: 'b'.repeat(40) },
      sandbox: { ...plan.sandbox, labels: { ...plan.sandbox.labels, turn } },
      context: { ...plan.context, turn },
    }
  }
  mcpAccess = false
  await assert.rejects(supervisor.run(replace(2), policy), /Turn restore stopped/)
  assert.equal(prepared, 0, 'Agent preparation must wait for every undo')
  const partial = await db.mcpCall.count({
    where: { turn: { taskId: task.id, turnNo: 1 }, revertedAt: { not: null } },
  })
  assert.equal(partial, 1, 'Fixture must fail after one actual restore')
  rejectSecondRestore = false
  await assert.rejects(supervisor.run(replace(3), policy), /synthetic_gate_passed/)
  assert.equal(prepared, 1)
  mcpAccess = true
  // Every restore of the rollback is a call of the host: the holder of the turn lease, no key.
  const restores = await db.mcpCall.findMany({
    where: { turn: { taskId: task.id }, tool: 'restore' },
  })
  assert.equal(restores.length, 3, 'Two restores of the first run, one refused, and its retry')
  for (const call of restores) {
    assert.equal(call.assignmentId, null)
    assert.equal(call.credentialKeyId, null)
    assert.equal(call.hostTaskId, task.id)
    assert.equal(call.hostOperation, 'turn')
  }
  const turns = await db.taskTurn.findMany({
    where: { taskId: task.id },
    orderBy: { turnNo: 'asc' },
  })
  assert.deepEqual(
    turns.map((turn) => turn.status),
    ['completed', 'failed', 'failed'],
  )
  assert(turns.every((turn) => turn.startedAt && turn.finishedAt && turn.driverVersion === '1.0.0'))
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).turnNo, 3)
  // Every edit of the first turn is returned. The restores of the host stand under that turn too.
  assert.equal(
    await db.mcpCall.count({
      where: { turn: { taskId: task.id, turnNo: 1 }, restoresSnapshotId: null, revertedAt: null },
    }),
    0,
  )
  assert.equal(await db.turnAssignment.count({ where: { taskId: task.id, finishedAt: null } }), 0)
  assert.equal((await db.siteLease.findUniqueOrThrow({ where: { siteId } })).holderTaskId, null)
  console.log(
    'PASS product TaskTurn persistence and supervisor undo before replacement by the lease fence, without an MCP token: retry resumes partial real WordPress undo',
  )
  await verifyContentUndo({
    db,
    workspaceId,
    siteId,
    modelId,
    accountId,
    origin,
    content: roleContent,
    gateway,
    pageIds,
    plan: (taskId, session) => ({
      ...plan,
      sandbox: {
        ...plan.sandbox,
        labels: { workspaceId, siteId, taskId, sessionId: session, turn: 1 },
      },
      context: { ...plan.context, taskId, sessionId: session, turn: 1 },
      workspace: { ...plan.workspace, branch: `agent/${taskId}` },
    }),
  })
  await verifyContentLifecycle({
    db,
    taskId: task.id,
    siteId,
    sessionId,
    storage,
    secrets,
    observer,
    gateway,
    issue,
    revoke,
    plan: { ...replace(4), driverId: sampleDriverId },
    pageId: pageIds[0],
  })
}
