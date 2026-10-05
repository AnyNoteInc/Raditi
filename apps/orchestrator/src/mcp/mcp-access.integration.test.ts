import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  createPrismaClient,
  PostgresSiteLeaseStore,
  PostgresTurnAssignmentStore,
  type PrismaClient,
} from '@repo/db'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  conflict,
  DomainError,
  publishedContentHashMaterial,
  terminalTaskStatuses,
  type ContentWriteProof,
  type KvSecret,
  type PublishedContentGateway,
  type PublishedContentState,
} from '@repo/domain'

import { PRISMA, SECRET_STORE } from '../infra/tokens.ts'
import { fakeInfra, testMcpConfig } from '../testing/fakes.ts'
import { memoryStorage, memoryTransit } from '../testing/snapshots.ts'
import { PostgresMcpAccess } from './mcp-access.ts'
import { McpAppModule } from './mcp-app.module.ts'
import { ContentSnapshotStorage, CONTENT_SNAPSHOT_TTL_MS } from './content-snapshots.ts'
import {
  CONTENT_PREPARATION_LIMIT_MS,
  PostgresMcpJournal,
  type McpCallReservation,
  type McpMutationCommand,
} from './mcp-journal.ts'
import { mountMcp } from './mcp-server.ts'
import { contentMaskPath, ContentPrivacy } from './content-privacy.ts'
import { McpContentService } from './mcp-content.ts'
import { McpContentMaintenance } from './mcp-content-maintenance.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

describe.skipIf(!enabled)('MCP admission and HTTP with PostgreSQL', () => {
  let db: PrismaClient
  let app: INestApplication | undefined
  let store: PostgresMcpAccess
  let fixture: {
    workspaceId: string
    siteId: string
    taskId: string
    driverId: string
    providerId: string
    modelId: string
    credentialId: string
    accountId: string
    keyId: string
    assignmentId: string
    token: string
  }
  const tracked: (typeof fixture)[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresMcpAccess(db)
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  beforeEach(async () => {
    const suffix = randomBytes(8).toString('hex')
    const token = `mcp_${randomBytes(32).toString('hex')}`
    fixture = await db.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: 'Synthetic MCP', dataClass: 'synthetic' },
      })
      const site = await tx.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic MCP',
          url: `https://${suffix}.example.test`,
          stack: 'wordpress',
          status: 'active',
        },
      })
      const task = await tx.task.create({
        data: { workspaceId: workspace.id, siteId: site.id, status: 'running' },
      })
      const driver = await tx.agentDriver.create({
        data: {
          id: `mcp-${suffix}`,
          image: `synthetic@sha256:${'a'.repeat(64)}`,
          capabilities: {},
          enabled: true,
        },
      })
      const provider = await tx.llmProvider.create({
        data: { slug: `mcp-${suffix}`, name: 'Synthetic', kind: 'subscription' },
      })
      const model = await tx.llmModel.create({
        data: {
          providerId: provider.id,
          slug: `mcp-${suffix}`,
          name: 'Synthetic',
          modelClass: 'standard',
          reserveOutputTokens: 1024,
        },
      })
      const credential = await tx.credentialRef.create({
        data: { kind: 'subscription', vaultPath: `subs/synthetic/${suffix}` },
      })
      const account = await tx.subscriptionAccount.create({
        data: {
          providerId: provider.id,
          driverId: driver.id,
          label: `mcp-${suffix}`,
          plan: 'synthetic',
          credentialRefId: credential.id,
          maxConcurrentTurns: 1,
          maxConcurrentRequests: 1,
        },
      })
      const key = await tx.llmKey.create({
        data: {
          keyHash: hash(randomUUID()),
          mcpTokenHash: hash(token),
          taskId: task.id,
          taskAttempt: 1,
          sessionId: suffix,
          turnNo: 1,
          firstEpoch: 1,
          driverId: driver.id,
          modelId: model.id,
          subscriptionAccountId: account.id,
          budgetRub: '100',
          issuedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 300_000),
          validUntil: new Date(Date.now() + 600_000),
        },
      })
      const assignment = await tx.turnAssignment.create({
        data: {
          taskId: task.id,
          siteId: site.id,
          sessionId: suffix,
          turnNo: 1,
          executor: 'local',
          plan: {},
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date(Date.now() + 600_000),
        },
      })
      await tx.siteLease.create({
        data: {
          siteId: site.id,
          holderTaskId: task.id,
          epoch: 1,
          operation: 'turn',
          expiresAt: new Date(Date.now() + 600_000),
        },
      })
      return {
        workspaceId: workspace.id,
        siteId: site.id,
        taskId: task.id,
        driverId: driver.id,
        providerId: provider.id,
        modelId: model.id,
        credentialId: credential.id,
        accountId: account.id,
        keyId: key.id,
        assignmentId: assignment.id,
        token,
      }
    })
    tracked.push(fixture)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    const fixture = tracked.pop()
    if (!fixture) return
    await db.llmKey.deleteMany({ where: { taskId: fixture.taskId } })
    await db.siteLease.deleteMany({ where: { siteId: fixture.siteId } })
    await db.mcpCall.deleteMany({ where: { turn: { taskId: fixture.taskId } } })
    await db.snapshot.deleteMany({ where: { taskId: fixture.taskId } })
    await db.turnAssignment.deleteMany({ where: { taskId: fixture.taskId } })
    await db.task.delete({ where: { id: fixture.taskId } })
    await db.site.delete({ where: { id: fixture.siteId } })
    await db.workspace.delete({ where: { id: fixture.workspaceId } })
    await db.subscriptionAccount.delete({ where: { id: fixture.accountId } })
    await db.credentialRef.delete({ where: { id: fixture.credentialId } })
    await db.llmModel.delete({ where: { id: fixture.modelId } })
    await db.llmProvider.delete({ where: { id: fixture.providerId } })
    await db.agentDriver.delete({ where: { id: fixture.driverId } })
  })

  async function contentFixture() {
    const scope = await store.authenticate(fixture.token)
    expect(scope).not.toBeNull()
    const turn = await db.taskTurn.create({
      data: {
        taskId: fixture.taskId,
        turnNo: 1,
        status: 'running',
        driverId: fixture.driverId,
        modelId: fixture.modelId,
        image: `synthetic@sha256:${'a'.repeat(64)}`,
      },
    })
    const memory = memoryStorage()
    const transit = memoryTransit()
    const snapshots = new ContentSnapshotStorage(memory.storage, transit.secrets)
    const journal = new PostgresMcpJournal(db)
    const command: McpMutationCommand = {
      tool: 'wp_rest',
      objectRef: 'post:42',
      idempotencyKey: 'synthetic-edit',
      arguments: { title: 'После', content: 'Текст' },
    }
    const fence = {
      siteId: fixture.siteId,
      taskId: fixture.taskId,
      operation: 'turn' as const,
      epoch: 1,
    }
    return {
      scope: scope!,
      turn,
      journal,
      snapshots,
      memory,
      transit,
      command,
      fence,
      leases: new PostgresSiteLeaseStore(db),
    }
  }

  function claimed(reservation: McpCallReservation) {
    expect(reservation.kind).toBe('claimed')
    if (reservation.kind !== 'claimed') throw new Error('Expected a synthetic reservation')
    return reservation
  }

  /** Finishes turn 1 and opens turn 2 of the same task under the same lease. */
  async function nextTurn() {
    await db.turnAssignment.update({
      where: { id: fixture.assignmentId },
      data: { finishedAt: new Date(), outcome: 'completed' },
    })
    await db.taskTurn.updateMany({
      where: { taskId: fixture.taskId, turnNo: 1 },
      data: { status: 'completed', finishedAt: new Date() },
    })
    const key = await db.llmKey.findUniqueOrThrow({ where: { id: fixture.keyId } })
    const token = `mcp_${randomBytes(32).toString('hex')}`
    await db.llmKey.create({
      data: {
        ...key,
        id: randomUUID(),
        keyHash: hash(randomUUID()),
        mcpTokenHash: hash(token),
        turnNo: 2,
      },
    })
    await db.turnAssignment.create({
      data: {
        taskId: fixture.taskId,
        siteId: fixture.siteId,
        sessionId: key.sessionId,
        turnNo: 2,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 600_000),
      },
    })
    await db.taskTurn.create({
      data: {
        taskId: fixture.taskId,
        turnNo: 2,
        status: 'running',
        driverId: fixture.driverId,
        modelId: fixture.modelId,
        image: `synthetic@sha256:${'a'.repeat(64)}`,
      },
    })
    const scope = await store.authenticate(token)
    expect(scope).toMatchObject({ turn: 2 })
    return scope!
  }

  async function publishedFixture() {
    const base = await contentFixture()
    const records = new Map<string, KvSecret>()
    const secrets = {
      ...base.transit.secrets,
      kvRead: vi.fn(async (path: string) => records.get(path) ?? null),
      kvDestroyAll: vi.fn(async (path: string) => {
        records.delete(path)
      }),
      kvWrite: vi.fn(
        async (path: string, data: Record<string, string>, options?: { cas?: number }) => {
          const version = records.get(path)?.version ?? 0
          if (options?.cas !== version) throw conflict('Synthetic CAS mismatch')
          records.set(path, { data, version: version + 1 })
          return { version: version + 1 }
        },
      ),
    }
    const hashed = (fields: Omit<PublishedContentState, 'stateHash'>): PublishedContentState => ({
      ...fields,
      stateHash: hash(publishedContentHashMaterial(fields)),
    })
    const initial = (objectRef: string) =>
      hashed({
        version: 1,
        objectRef,
        kind: 'post',
        title: 'До',
        content: '<p>original contact@example.test +7 (999) 123-45-67</p>',
        excerpt: '',
      })
    const original = initial('post:42')
    const states = new Map<string, PublishedContentState>()
    const stateOf = (objectRef: string) => states.get(objectRef) ?? initial(objectRef)
    const operations = new Map<string, ContentWriteProof>()
    let loseAcknowledgement = false
    const gateway: PublishedContentGateway = {
      read: vi.fn(async (objectRef: string) => ({ ...stateOf(objectRef) })),
      conditionalWrite: vi.fn<PublishedContentGateway['conditionalWrite']>(async (input) => {
        const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
        expect(lease.inflightMcpCallId).toBe(input.callId)
        const call = await db.mcpCall.findUniqueOrThrow({
          where: { id: input.callId },
          include: { snapshot: true },
        })
        expect(call.snapshot?.payloadSha256).toMatch(/^[a-f0-9]{64}$/)
        expect(base.memory.objects.has(call.snapshot!.s3Key)).toBe(true)
        // The deadline and the time left of it are both PostgreSQL's.
        expect(input.deadlineAt).toBe(call.writeDeadlineAt!.getTime())
        expect(Number.isInteger(input.ttlMs)).toBe(true)
        expect(input.ttlMs).toBeGreaterThan(2000)
        expect(input.ttlMs).toBeLessThanOrEqual(15_000)
        const current = stateOf(input.objectRef)
        if (current.stateHash !== input.expectedStateHash)
          return { version: 1, kind: 'rejected', code: 'conflict' }
        const state = hashed({ ...current, ...input.fields })
        states.set(input.objectRef, state)
        const proof: ContentWriteProof = {
          version: 1,
          kind: 'committed',
          callId: input.callId,
          siteId: input.siteId,
          epoch: input.epoch,
          requestHash: input.requestHash,
          objectRef: input.objectRef,
          stateHash: state.stateHash,
        }
        operations.set(input.callId, proof)
        if (loseAcknowledgement) throw new Error('Synthetic lost site acknowledgement')
        return proof
      }),
      operation: vi.fn(async (callId) => operations.get(callId) ?? null),
      reconcileOperation: vi.fn(
        async (input) =>
          operations.get(input.callId) ?? { version: 1 as const, kind: 'unknown' as const },
      ),
      forgetOperation: vi.fn(async (input) => {
        operations.delete(input.callId)
      }),
    }
    const service = () =>
      new McpContentService(
        base.journal,
        base.snapshots,
        new ContentPrivacy(secrets),
        async () => gateway,
      )
    const edit = (key: string, fields = { title: key }, scope = base.scope, post = 42) =>
      service().wpRest(scope, {
        method: 'POST',
        route: `/wp/v2/posts/${post}`,
        body: fields,
        idempotencyKey: key,
      })
    return {
      ...base,
      original,
      gateway,
      service,
      edit,
      operations,
      records,
      secrets,
      state: () => stateOf('post:42'),
      stateOf,
      drift: () => {
        states.set('post:42', hashed({ ...stateOf('post:42'), content: '<p>Later human edit</p>' }))
      },
      loseAcknowledgement: () => {
        loseAcknowledgement = true
      },
    }
  }

  it('masks public contacts, stores encrypted state before writing and replays without another write', async () => {
    const f = await publishedFixture()
    const read = await f.service().wpRest(f.scope, { method: 'GET', route: '/wp/v2/posts/42' })
    expect(JSON.stringify(read.response)).not.toMatch(/contact@example|123-45-67/)
    const body = read.response as { content: string }
    const outcome = await f.service().wpRest(f.scope, {
      method: 'POST',
      route: '/wp/v2/posts/42',
      body: { content: body.content.replace('original', 'after') },
      idempotencyKey: 'masked-edit',
    })
    expect(outcome.result).toBe('ok')
    expect(f.state().content).toContain('after contact@example.test +7 (999) 123-45-67')
    expect(
      JSON.stringify(
        await db.mcpCall.findMany({ where: { turnId: f.turn.id }, select: { response: true } }),
      ),
    ).not.toContain('contact@example')
    expect(
      [...f.memory.objects.values()].every(
        (bytes) => !Buffer.from(bytes).toString().includes('contact@example'),
      ),
    ).toBe(true)
    const replay = await f.service().wpRest(f.scope, {
      method: 'POST',
      route: '/wp/v2/posts/42',
      body: { content: body.content.replace('original', 'after') },
      idempotencyKey: 'masked-edit',
    })
    expect(replay).toEqual(outcome)
    expect(f.gateway.conditionalWrite).toHaveBeenCalledOnce()
  })

  it('undoes a turn in reverse admission order, including successive edits of the same object', async () => {
    const f = await publishedFixture()
    await f.edit('B')
    await f.edit('C')
    expect(f.state().title).toBe('C')
    const undone = await f.service().rollbackTurn(f.scope, 1)
    expect(undone).toHaveLength(2)
    expect(f.state()).toEqual(f.original)
    expect(
      await db.mcpCall.count({
        where: { turnId: f.turn.id, tool: 'wp_rest', revertedAt: { not: null } },
      }),
    ).toBe(2)
    expect(
      await db.snapshot.count({ where: { taskId: fixture.taskId, restoredAt: { not: null } } }),
    ).toBe(2)
    expect(await f.service().rollbackTurn(f.scope, 1)).toEqual([])
  })

  it('refuses an older restore before the later edit, then replays the completed restore', async () => {
    const f = await publishedFixture()
    const first = (await f.edit('B')).response as { snapshotId: string }
    const second = (await f.edit('C')).response as { snapshotId: string }
    await expect(
      f.service().restore(f.scope, { snapshotId: first.snapshotId, idempotencyKey: 'old' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const restored = await f
      .service()
      .restore(f.scope, { snapshotId: second.snapshotId, idempotencyKey: 'latest' })
    expect(restored.result).toBe('ok')
    expect(
      await f
        .service()
        .restore(f.scope, { snapshotId: second.snapshotId, idempotencyKey: 'latest' }),
    ).toEqual(restored)
    expect(f.state().title).toBe('B')
    expect(f.gateway.conditionalWrite).toHaveBeenCalledTimes(3)
  })

  it('stops undo at an external edit and does not mark its source reverted', async () => {
    const f = await publishedFixture()
    await f.edit('B')
    f.drift()
    await expect(f.service().rollbackTurn(f.scope, 1)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.state().content).toContain('Later human edit')
    expect(f.gateway.conditionalWrite).toHaveBeenCalledOnce()
    expect(
      await db.mcpCall.count({ where: { turnId: f.turn.id, revertedAt: { not: null } } }),
    ).toBe(0)
  })

  it('holds an ambiguous write, then closes it from durable site evidence after token revocation', async () => {
    const f = await publishedFixture()
    f.loseAcknowledgement()
    await expect(f.edit('B')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    expect(lease.heldForOperator).toBe(true)
    expect(lease.inflightMcpCallId).not.toBeNull()
    const revokedAt = new Date()
    await db.llmKey.update({
      where: { id: fixture.keyId },
      data: { revokeRequestedAt: revokedAt, revokedAt },
    })
    expect(await f.service().recoverWrite(f.scope, lease.inflightMcpCallId!)).toBe('completed')
    const recovered = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    expect(recovered.inflightMcpCallId).toBeNull()
    expect(recovered.heldForOperator).toBe(true)
    expect(
      (await db.mcpCall.findUniqueOrThrow({ where: { id: lease.inflightMcpCallId! } })).result,
    ).toBe('ok')
    expect(f.gateway.conditionalWrite).toHaveBeenCalledOnce()
  })

  it('never releases an ambiguous writer just because its site receipt is absent', async () => {
    const f = await publishedFixture()
    f.loseAcknowledgement()
    await expect(f.edit('B')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    f.operations.clear()
    expect(await f.service().recoverWrite(f.scope, lease.inflightMcpCallId!)).toBe('unknown')
    expect(
      (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }))
        .inflightMcpCallId,
    ).toBe(lease.inflightMcpCallId)
  })

  it('prevents turn recovery from changing epoch while the site has an unresolved content writer', async () => {
    const f = await publishedFixture()
    f.loseAcknowledgement()
    await expect(f.edit('B')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const assignments = new PostgresTurnAssignmentStore(db)
    expect(
      await assignments.takeOver({ id: fixture.assignmentId, fence: f.fence, ttlMs: 60_000 }),
    ).toBeNull()
    expect(
      (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })).epoch,
    ).toBe(1)
    const callId = (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }))
      .inflightMcpCallId!
    expect(await f.service().recoverWrite(f.scope, callId)).toBe('completed')
    expect(await f.leases.free(f.fence)).toBe(true)
  })

  it('keeps an orphaned hold with a content writer until proven completion', async () => {
    const f = await publishedFixture()
    f.loseAcknowledgement()
    await expect(f.edit('B')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const callId = (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }))
      .inflightMcpCallId!
    const assignments = new PostgresTurnAssignmentStore(db)
    expect(await assignments.finish({ id: fixture.assignmentId, epoch: 1, outcome: 'lost' })).toBe(
      true,
    )
    await assignments.freeOrphanedHolds()
    expect(
      (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }))
        .inflightMcpCallId,
    ).toBe(callId)
    expect(await f.service().recoverWrite(f.scope, callId)).toBe('completed')
    await assignments.freeOrphanedHolds()
    expect(
      (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })).holderTaskId,
    ).toBeNull()
  })

  it('does not close or retry a writer when beginWrite acknowledgement is lost', async () => {
    const f = await publishedFixture()
    const begin = f.journal.beginWrite.bind(f.journal)
    vi.spyOn(f.journal, 'beginWrite').mockImplementation(async (scope, callId) => {
      expect(await begin(scope, callId)).toBe(true)
      throw new Error('Synthetic lost admission acknowledgement')
    })
    await expect(f.edit('B')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    expect(f.gateway.conditionalWrite).not.toHaveBeenCalled()
    const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    expect(lease.heldForOperator).toBe(true)
    expect(lease.inflightMcpCallId).not.toBeNull()
    expect(
      (await db.mcpCall.findUniqueOrThrow({ where: { id: lease.inflightMcpCallId! } })).result,
    ).toBeNull()
  })

  it('closes a revoked capture before any dispatch and prevents a late beginWrite', async () => {
    const f = await publishedFixture()
    const capture = claimed(await f.journal.reserve(f.scope, f.command))
    expect(await f.journal.recoverCaptures(fixture.siteId)).toBe(0)
    await db.llmKey.update({
      where: { id: fixture.keyId },
      data: { revokeRequestedAt: new Date() },
    })
    expect(await new PostgresMcpJournal(db).recoverCaptures(fixture.siteId)).toBe(1)
    expect(await f.service().recoverWrite(f.scope, capture.callId)).toBe('not_committed')
    await expect(f.journal.beginWrite(f.scope, capture.callId)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
    expect(f.gateway.reconcileOperation).not.toHaveBeenCalled()
    expect(f.gateway.conditionalWrite).not.toHaveBeenCalled()
  })

  it('recovers abandoned captures after the old lease is released', async () => {
    const f = await publishedFixture()
    const capture = claimed(await f.journal.reserve(f.scope, f.command))
    expect(await f.leases.release(f.fence)).toBe(true)
    expect(await f.journal.recoverCaptures(fixture.siteId)).toBe(1)
    expect(
      (await db.mcpCall.findUniqueOrThrow({ where: { id: capture.callId } })).response,
    ).toEqual({ code: 'CONTENT_PREPARATION_INTERRUPTED' })
    expect(f.gateway.conditionalWrite).not.toHaveBeenCalled()
  })

  it('serializes capture recovery against a concurrent writer admission', async () => {
    const f = await publishedFixture()
    const capture = claimed(await f.journal.reserve(f.scope, f.command))
    const receipt = await f.snapshots.save(capture.snapshot, Buffer.from('synthetic'))
    await f.journal.attachSnapshot(f.scope, capture.callId, receipt)
    const [admitted, recovered] = await Promise.all([
      f.journal.beginWrite(f.scope, capture.callId),
      f.service().recoverWrite(f.scope, capture.callId),
    ])
    const call = await db.mcpCall.findUniqueOrThrow({ where: { id: capture.callId } })
    const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    if (admitted) {
      expect(recovered).toBe('unknown')
      expect(call.result).toBeNull()
      expect(lease.inflightMcpCallId).toBe(capture.callId)
    } else {
      expect(recovered).toBe('not_committed')
      expect(call.result).toBe('error')
      expect(lease.inflightMcpCallId).toBeNull()
    }
  })

  it('requires a matching negative site proof before clearing a lost admission marker', async () => {
    const f = await publishedFixture()
    const begin = f.journal.beginWrite.bind(f.journal)
    vi.spyOn(f.journal, 'beginWrite').mockImplementation(async (scope, id) => {
      await begin(scope, id)
      throw new Error('Synthetic lost admission acknowledgement')
    })
    await expect(f.edit('never-dispatched')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    const id = lease.inflightMcpCallId!
    // A site keeps the identity of the operation in its proof, never the time it was given.
    vi.mocked(f.gateway.reconcileOperation).mockImplementationOnce(
      async ({ ttlMs: _ttlMs, ...ref }) => ({
        ...ref,
        version: 1,
        kind: 'not_committed',
        deadlineAt: ref.deadlineAt + 1,
      }),
    )
    await expect(f.service().recoverWrite(f.scope, id)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(
      (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }))
        .inflightMcpCallId,
    ).toBe(id)
    vi.mocked(f.gateway.reconcileOperation).mockImplementationOnce(
      async ({ ttlMs: _ttlMs, ...ref }) => ({ ...ref, version: 1, kind: 'not_committed' }),
    )
    expect(await f.service().recoverWrite(f.scope, id)).toBe('not_committed')
    const final = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    expect(final.inflightMcpCallId).toBeNull()
    expect(final.heldForOperator).toBe(true)
    expect((await db.mcpCall.findUniqueOrThrow({ where: { id } })).result).toBe('error')
    expect(f.gateway.conditionalWrite).not.toHaveBeenCalled()
  })

  it('never reconciles an external operation under a different epoch', async () => {
    const f = await publishedFixture()
    f.loseAcknowledgement()
    await expect(f.edit('B')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const callId = (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }))
      .inflightMcpCallId!
    await db.siteLease.update({ where: { siteId: fixture.siteId }, data: { epoch: 2 } })
    await expect(f.service().recoverWrite(f.scope, callId)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
    expect(f.gateway.reconcileOperation).not.toHaveBeenCalled()
  })

  it('closes a call whose write admission was refused instead of leaving the site blocked', async () => {
    const f = await publishedFixture()
    const begin = f.journal.beginWrite.bind(f.journal)
    vi.spyOn(f.journal, 'beginWrite').mockImplementationOnce(async (scope, id) => {
      // The turn is about to end: admission refuses inside its transaction.
      await db.turnAssignment.update({
        where: { id: fixture.assignmentId },
        data: { deadlineAt: new Date(Date.now() + 1500) },
      })
      return begin(scope, id)
    })
    expect(await f.edit('B')).toEqual({
      result: 'error',
      response: { code: 'CONTENT_PREPARATION_FAILED' },
    })
    expect(f.gateway.conditionalWrite).not.toHaveBeenCalled()
    expect(
      await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
    ).toMatchObject({ heldForOperator: false, inflightMcpCallId: null })
    await db.turnAssignment.update({
      where: { id: fixture.assignmentId },
      data: { deadlineAt: new Date(Date.now() + 600_000) },
    })
    expect((await f.edit('C')).result).toBe('ok')
  })

  it('closes an abandoned preparation under the lease lock when the next owner reserves', async () => {
    const f = await contentFixture()
    const abandoned = claimed(await f.journal.reserve(f.scope, f.command))
    // The owner crashed during capture; turn recovery rebinds the assignment to a new epoch.
    await db.siteLease.update({ where: { siteId: fixture.siteId }, data: { epoch: 2 } })
    await db.turnAssignment.update({ where: { id: fixture.assignmentId }, data: { leaseEpoch: 2 } })
    const next = { ...f.scope, epoch: 2 }
    const fresh = claimed(
      await f.journal.reserve(next, { ...f.command, idempotencyKey: 'after-crash' }),
    )
    expect(await db.mcpCall.findUniqueOrThrow({ where: { id: abandoned.callId } })).toMatchObject({
      result: 'error',
      response: { code: 'CONTENT_PREPARATION_INTERRUPTED' },
      writeStartedAt: null,
    })
    await f.journal.finish(next, fresh.callId, {
      result: 'denied',
      response: { code: 'SYNTHETIC_STOP' },
    })
  })

  it('reconciles an ambiguous write past its deadline from maintenance without another dispatch', async () => {
    const f = await publishedFixture()
    f.loseAcknowledgement()
    await expect(f.edit('B')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const callId = (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }))
      .inflightMcpCallId!
    const maintenance = () =>
      new McpContentMaintenance(db, f.memory.storage, f.secrets, async () => f.gateway)
    // Before its deadline a site cannot prove absence; nothing is visited.
    expect(await maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
      visited: 0,
    })
    await db.mcpCall.update({
      where: { id: callId },
      data: {
        writeStartedAt: new Date(Date.now() - 30_000),
        writeDeadlineAt: new Date(Date.now() - 15_000),
      },
    })
    expect(await maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
      visited: 1,
      completed: 1,
      failed: 0,
    })
    expect((await db.mcpCall.findUniqueOrThrow({ where: { id: callId } })).result).toBe('ok')
    const [reconciled] = vi.mocked(f.gateway.reconcileOperation).mock.lastCall!
    expect(Number.isInteger(reconciled.ttlMs)).toBe(true)
    expect(reconciled.ttlMs).toBeLessThan(-10_000)
    expect(
      await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
    ).toMatchObject({ inflightMcpCallId: null, heldForOperator: true })
    expect(f.gateway.conditionalWrite).toHaveBeenCalledOnce()
    // The existing turn recovery then releases the orphaned hold.
    const assignments = new PostgresTurnAssignmentStore(db)
    await assignments.finish({ id: fixture.assignmentId, epoch: 1, outcome: 'lost' })
    expect(await assignments.freeOrphanedHolds()).toBe(1)
    expect(await maintenance().recoverWrites({ siteId: fixture.siteId })).toMatchObject({
      visited: 0,
    })
  })

  it.each([
    [{ code: 'invalid', reason: 'markup' }, 'CONTENT_MARKUP_UNSUPPORTED'],
    [{ code: 'invalid', reason: 'size' }, 'CONTENT_TOO_LARGE'],
    [{ code: 'invalid', reason: 'storage' }, 'CONTENT_STORAGE_MISMATCH'],
    [{ code: 'invalid' }, 'CONTENT_WRITE_REJECTED'],
    [{ code: 'fenced' }, 'CONTENT_WRITE_REJECTED'],
    [{ code: 'unavailable' }, 'CONTENT_SITE_UNAVAILABLE'],
    [{ code: 'conflict' }, 'CONTENT_CONFLICT'],
  ])('reports a site refusal %j to the agent as %s', async (refusal, code) => {
    const f = await publishedFixture()
    vi.mocked(f.gateway.conditionalWrite).mockResolvedValueOnce({
      version: 1,
      kind: 'rejected',
      ...refusal,
    } as Awaited<ReturnType<PublishedContentGateway['conditionalWrite']>>)
    expect(await f.edit('B')).toEqual({ result: 'error', response: { code } })
    expect(
      await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
    ).toMatchObject({ heldForOperator: false, inflightMcpCallId: null })
  })

  it.each(['CONTENT_TOO_LARGE', 'CONTENT_OBJECT_UNAVAILABLE'])(
    'keeps the fixed read refusal %s of a preparation',
    async (code) => {
      const f = await publishedFixture()
      vi.mocked(f.gateway.read).mockRejectedValueOnce(new DomainError(code, 'synthetic', 413))
      expect(await f.edit('B')).toEqual({ result: 'error', response: { code } })
      vi.mocked(f.gateway.read).mockRejectedValueOnce(new Error(`private ${code}`))
      expect(await f.edit('C')).toEqual({
        result: 'error',
        response: { code: 'CONTENT_PREPARATION_FAILED' },
      })
    },
  )

  it('stops a turn undo with a retryable code when the site is unavailable', async () => {
    const f = await publishedFixture()
    await f.edit('B')
    vi.mocked(f.gateway.read).mockRejectedValueOnce(
      new DomainError('CONTENT_GATEWAY_UNAVAILABLE', 'synthetic', 502),
    )
    await expect(f.service().rollbackTurn(f.scope, 1)).rejects.toMatchObject({
      code: 'CONTENT_RESTORE_FAILED',
    })
    expect(f.state().title).toBe('B')
  })

  it('does not count the host undo of a replaced turn against the 20-object limit', async () => {
    const f = await publishedFixture()
    for (let post = 1; post <= 20; post++)
      expect((await f.edit(`edit-${post}`, { title: 'Правка' }, f.scope, post)).result).toBe('ok')
    const replacement = await nextTurn()
    expect(await f.service().rollbackTurn(replacement, 1)).toHaveLength(20)
    expect(f.stateOf('post:20').title).toBe('До')
    // Twenty other objects remain the new turn's own allowance.
    for (let post = 21; post <= 40; post++)
      expect((await f.edit(`other-${post}`, { title: 'Другая' }, replacement, post)).result).toBe(
        'ok',
      )
    await expect(f.edit('too-many', { title: 'Лишняя' }, replacement, 41)).rejects.toMatchObject({
      code: 'MCP_APPROVAL_REQUIRED',
    })
  }, 30_000)

  it('lets only the trusted turn undo restore a snapshot of an earlier turn', async () => {
    const f = await publishedFixture()
    const source = (await f.edit('B')).response as { snapshotId: string }
    const next = await nextTurn()
    await expect(
      f.service().restore(next, { snapshotId: source.snapshotId, idempotencyKey: 'cross-turn' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.state().title).toBe('B')
    expect(await f.service().rollbackTurn(next, 1)).toEqual([source.snapshotId])
    expect(f.state()).toEqual(f.original)
    // Within its own turn the agent may still undo its edit.
    const own = (await f.edit('C', { title: 'C' }, next)).response as { snapshotId: string }
    expect(
      (await f.service().restore(next, { snapshotId: own.snapshotId, idempotencyKey: 'own' }))
        .result,
    ).toBe('ok')
  })

  it('treats edits of every content tool alike in turn undo', async () => {
    const f = await contentFixture()
    const command = { ...f.command, tool: 'site_edit' }
    const reservation = claimed(await f.journal.reserve(f.scope, command))
    await f.journal.attachSnapshot(
      f.scope,
      reservation.callId,
      await f.snapshots.save(reservation.snapshot, Buffer.from('before')),
    )
    expect(await f.journal.beginWrite(f.scope, reservation.callId)).toBe(true)
    await f.journal.finish(f.scope, reservation.callId, {
      result: 'ok',
      response: { updated: true },
      appliedStateHash: 'b'.repeat(64),
    })
    expect(await f.journal.turnSnapshots(f.scope, 1)).toEqual([reservation.snapshot.id])
    expect((await f.journal.restoreSource(f.scope, reservation.snapshot.id)).receipt.id).toBe(
      reservation.snapshot.id,
    )
  })

  it('restores a live task snapshot past its capture expiry until it is purged', async () => {
    const f = await publishedFixture()
    const source = (await f.edit('B')).response as { snapshotId: string }
    const restore = (key: string) => ({
      tool: 'restore',
      objectRef: 'post:42',
      idempotencyKey: key,
      arguments: { snapshotId: source.snapshotId },
    })
    // The undo window counts from the end of the task, not from the edit.
    await db.snapshot.update({
      where: { id: source.snapshotId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const reservation = claimed(
      await f.journal.reserve(f.scope, restore('late'), source.snapshotId),
    )
    await f.journal.finish(f.scope, reservation.callId, {
      result: 'denied',
      response: { code: 'SYNTHETIC_STOP' },
    })
    await db.snapshot.update({
      where: { id: source.snapshotId },
      data: { purgeRequestedAt: new Date() },
    })
    await expect(
      f.journal.reserve(f.scope, restore('purged'), source.snapshotId),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('reports the time left of a write on the PostgreSQL clock', async () => {
    const f = await contentFixture()
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    await f.journal.attachSnapshot(
      f.scope,
      reservation.callId,
      await f.snapshots.save(reservation.snapshot, Buffer.from('before')),
    )
    expect(await f.journal.beginWrite(f.scope, reservation.callId)).toBe(true)
    const intent = await f.journal.writeIntent(f.scope, reservation.callId)
    expect(intent.ttlMs).toBeGreaterThan(2000)
    expect(intent.ttlMs).toBeLessThanOrEqual(15_000)
    await db.mcpCall.update({
      where: { id: reservation.callId },
      data: {
        writeStartedAt: new Date(Date.now() - 30_000),
        writeDeadlineAt: new Date(Date.now() - 15_000),
      },
    })
    const recovery = await f.journal.recoveryIntent(f.scope, reservation.callId)
    expect(recovery).toMatchObject({ kind: 'write' })
    expect(recovery.kind === 'write' && recovery.ttlMs).toBeLessThan(-10_000)
    await f.journal.finish(f.scope, reservation.callId, {
      result: 'error',
      response: { code: 'SYNTHETIC_STOP' },
    })
  })

  async function retentionFixture() {
    const f = await publishedFixture()
    await f.service().wpRest(f.scope, { method: 'GET', route: '/wp/v2/posts/42' })
    const result = await f.edit('retention')
    const snapshotId = (result.response as { snapshotId: string }).snapshotId
    const call = await db.mcpCall.findFirstOrThrow({ where: { snapshotId } })
    await db.mcpCall.update({
      where: { id: call.id },
      data: {
        writeStartedAt: new Date(Date.now() - 30_000),
        writeDeadlineAt: new Date(Date.now() - 15_000),
      },
    })
    await f.leases.release(f.fence)
    await new PostgresTurnAssignmentStore(db).finish({
      id: fixture.assignmentId,
      epoch: 1,
      outcome: 'completed',
    })
    await db.llmKey.update({
      where: { id: fixture.keyId },
      data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
    })
    await db.task.update({
      where: { id: fixture.taskId },
      data: { status: 'done', finishedAt: new Date(Date.now() - 8 * 86400_000) },
    })
    await db.snapshot.update({
      where: { id: snapshotId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const maintenance = () =>
      new McpContentMaintenance(db, f.memory.storage, f.secrets, async () => f.gateway)
    return { ...f, snapshotId, call, maintenance, page: { siteId: fixture.siteId } }
  }

  it('purges expired external data while retaining snapshot metadata and journal results', async () => {
    const f = await retentionFixture()
    const mapPaths = [...f.records.keys()]
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({
      purged: 1,
      receipts: 1,
      failed: 0,
    })
    const snapshot = await db.snapshot.findUniqueOrThrow({ where: { id: f.snapshotId } })
    expect(snapshot.purgeRequestedAt).not.toBeNull()
    expect(snapshot.purgedAt).not.toBeNull()
    expect(snapshot.payloadSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(f.memory.objects.has(snapshot.s3Key)).toBe(false)
    const journaled = await db.mcpCall.findUniqueOrThrow({ where: { id: f.call.id } })
    expect(journaled.result).toBe('ok')
    // A receipt is retired only past its write deadline: the site is told no time is left.
    expect(f.gateway.forgetOperation).toHaveBeenCalledExactlyOnceWith({
      callId: f.call.id,
      siteId: fixture.siteId,
      epoch: 1,
      requestHash: journaled.requestHash,
      objectRef: 'post:42',
      deadlineAt: journaled.writeDeadlineAt!.getTime(),
      ttlMs: 0,
    })
    expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ purged: 1, failed: 0 })
    expect(f.records.size).toBe(0)
    // The very path the map was written to, outside the access secrets of the site.
    expect(mapPaths).toEqual([`kv/content-masks/${fixture.siteId}/${fixture.taskId}`])
    expect(f.secrets.kvDestroyAll).toHaveBeenCalledExactlyOnceWith(mapPaths[0])
    expect(mapPaths[0]).toBe(contentMaskPath({ siteId: fixture.siteId, taskId: fixture.taskId }))
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ visited: 0 })
    expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ visited: 0 })
  })

  it('resumes snapshot GC after a lost S3 deletion acknowledgement', async () => {
    const f = await retentionFixture()
    const remove = f.memory.storage.delete.getMockImplementation()!
    f.memory.storage.delete.mockImplementationOnce(async (...args) => {
      await remove(...args)
      throw new Error('Synthetic lost S3 deletion acknowledgement')
    })
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ failed: 1 })
    const pending = await db.snapshot.findUniqueOrThrow({ where: { id: f.snapshotId } })
    expect(pending.purgeRequestedAt).not.toBeNull()
    expect(pending.purgedAt).toBeNull()
    expect(f.memory.objects.has(pending.s3Key)).toBe(false)
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({
      purged: 1,
      receipts: 1,
      failed: 0,
    })
  })

  it('resumes site receipt GC after a lost acknowledgement without losing the journal', async () => {
    const f = await retentionFixture()
    vi.mocked(f.gateway.forgetOperation).mockImplementationOnce(async (input) => {
      f.operations.delete(input.callId)
      throw new Error('Synthetic lost site receipt deletion acknowledgement')
    })
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ purged: 1, failed: 1 })
    expect(
      (await db.mcpCall.findUniqueOrThrow({ where: { id: f.call.id } })).receiptPurgedAt,
    ).toBeNull()
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({
      purged: 0,
      receipts: 1,
      failed: 0,
    })
    expect((await db.mcpCall.findUniqueOrThrow({ where: { id: f.call.id } })).result).toBe('ok')
  })

  it('retires the privacy map even when the site never confirms receipt removal', async () => {
    const f = await retentionFixture()
    vi.mocked(f.gateway.forgetOperation).mockRejectedValue(new Error('Synthetic refused forget'))
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({
      purged: 1,
      receipts: 0,
      failed: 1,
    })
    expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ purged: 1, failed: 0 })
    expect(f.records.size).toBe(0)
    // The receipt holds no personal data; its removal keeps being retried on its own.
    expect(
      (await db.mcpCall.findUniqueOrThrow({ where: { id: f.call.id } })).receiptPurgedAt,
    ).toBeNull()
    vi.mocked(f.gateway.forgetOperation).mockResolvedValue(undefined)
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ receipts: 1, failed: 0 })
  })

  it('keeps the snapshots of an unfinished or recently finished task', async () => {
    const f = await retentionFixture()
    await db.task.update({
      where: { id: fixture.taskId },
      data: { status: 'awaiting_user', finishedAt: null },
    })
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ purged: 0 })
    await db.task.update({
      where: { id: fixture.taskId },
      data: { status: 'done', finishedAt: new Date(Date.now() - 86400_000) },
    })
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ purged: 0 })
    expect(f.memory.storage.delete).not.toHaveBeenCalled()
    await db.task.update({
      where: { id: fixture.taskId },
      data: { finishedAt: new Date(Date.now() - 8 * 86400_000) },
    })
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ purged: 1 })
  })

  it('purges at the undo window the journal promises, after every final status', async () => {
    const f = await retentionFixture()
    const finished = (status: (typeof terminalTaskStatuses)[number], agoMs: number) =>
      db.task.update({
        where: { id: fixture.taskId },
        data: { status, finishedAt: new Date(Date.now() - agoMs) },
      })
    // An hour inside the window «Отменить» still works, whatever the final status is.
    for (const status of terminalTaskStatuses) {
      await finished(status, CONTENT_SNAPSHOT_TTL_MS - 3_600_000)
      expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ visited: 0 })
      expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ visited: 0 })
    }
    expect(f.memory.storage.delete).not.toHaveBeenCalled()
    expect(f.secrets.kvDestroyAll).not.toHaveBeenCalled()
    await finished('rolled_back', CONTENT_SNAPSHOT_TTL_MS + 3_600_000)
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ purged: 1, failed: 0 })
    expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ purged: 1, failed: 0 })
  })

  it('makes privacy retirement durable before deleting Vault versions, including an acknowledgement loss', async () => {
    const f = await retentionFixture()
    await f.maintenance().sweepSnapshots(f.page)
    f.secrets.kvDestroyAll.mockImplementationOnce(async (path) => {
      f.records.delete(path)
      throw new Error('Synthetic lost Vault deletion acknowledgement')
    })
    expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ purged: 0, failed: 1 })
    const task = await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.contentRetiredAt).not.toBeNull()
    expect(task.contentMasksPurgedAt).toBeNull()
    // Even a future requeue cannot revive the expired content context.
    await db.task.update({ where: { id: task.id }, data: { status: 'running' } })
    await db.llmKey.update({
      where: { id: fixture.keyId },
      data: { revokeRequestedAt: null, revokedAt: null },
    })
    await db.turnAssignment.update({
      where: { id: fixture.assignmentId },
      data: { finishedAt: null, outcome: null },
    })
    await db.siteLease.update({
      where: { siteId: fixture.siteId },
      data: { holderTaskId: task.id, operation: 'turn', expiresAt: new Date(Date.now() + 60_000) },
    })
    expect(await store.authenticate(fixture.token)).toBeNull()
    await expect(
      f.journal.reserve(f.scope, { ...f.command, idempotencyKey: 'retired' }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ purged: 1, failed: 0 })
  })

  it('retains unknown writes and operator-held sites even when snapshots are expired', async () => {
    const f = await publishedFixture()
    f.loseAcknowledgement()
    await expect(f.edit('unknown')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    await db.snapshot.updateMany({
      where: { taskId: fixture.taskId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const maintenance = new McpContentMaintenance(
      db,
      f.memory.storage,
      f.secrets,
      async () => f.gateway,
    )
    expect(await maintenance.recoverCaptures(fixture.siteId)).toBe(0)
    expect(await maintenance.sweepSnapshots({ siteId: fixture.siteId })).toMatchObject({
      purged: 0,
      receipts: 0,
      failed: 0,
    })
    expect(f.memory.storage.delete).not.toHaveBeenCalled()
    expect(f.gateway.forgetOperation).not.toHaveBeenCalled()
  })

  it('does not retire live snapshots or a recently finished privacy map', async () => {
    const f = await retentionFixture()
    await db.snapshot.update({
      where: { id: f.snapshotId },
      data: { expiresAt: new Date(Date.now() + 600_000) },
    })
    expect(await f.maintenance().sweepSnapshots(f.page)).toMatchObject({ visited: 0 })
    expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ purged: 0 })
    expect(f.secrets.kvDestroyAll).not.toHaveBeenCalled()
    await db.snapshot.update({
      where: { id: f.snapshotId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await f.maintenance().sweepSnapshots(f.page)
    await db.task.update({ where: { id: fixture.taskId }, data: { finishedAt: new Date() } })
    expect(await f.maintenance().sweepMasks(f.page)).toMatchObject({ visited: 0 })
  })

  it('walks past a full page of legacy rows instead of starving eligible cleanup', async () => {
    const f = await retentionFixture()
    await db.snapshot.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        siteId: fixture.siteId,
        taskId: fixture.taskId,
        objectRef: 'post:42',
        s3Key: `legacy/${fixture.taskId}/${index}`,
        expiresAt: new Date(Date.now() - 1000),
      })),
    })
    const first = await f.maintenance().sweepSnapshots({ ...f.page, limit: 100 })
    expect(first).toMatchObject({ visited: 100, purged: 0, failed: 0 })
    expect(first.nextAfter).not.toBeNull()
    expect(
      await f.maintenance().sweepSnapshots({ ...f.page, after: first.nextAfter! }),
    ).toMatchObject({ purged: 1, receipts: 1, failed: 0 })
  })

  it('enforces durable retention claims and completed receipt GC at the SQL boundary', async () => {
    const f = await contentFixture()
    const capture = claimed(await f.journal.reserve(f.scope, f.command))
    await expect(
      db.snapshot.update({ where: { id: capture.snapshot.id }, data: { purgedAt: new Date() } }),
    ).rejects.toThrow()
    await expect(
      db.snapshot.update({
        where: { id: capture.snapshot.id },
        data: { purgeRequestedAt: new Date() },
      }),
    ).rejects.toThrow()
    await expect(
      db.mcpCall.update({ where: { id: capture.callId }, data: { receiptPurgedAt: new Date() } }),
    ).rejects.toThrow()
    await expect(
      db.task.update({ where: { id: fixture.taskId }, data: { contentMasksPurgedAt: new Date() } }),
    ).rejects.toThrow()
  })

  it('does not retire a task that never accessed content', async () => {
    await db.task.update({
      where: { id: fixture.taskId },
      data: { status: 'done', finishedAt: new Date(Date.now() - 8 * 86400_000) },
    })
    const memory = memoryStorage()
    const secrets = { kvDestroyAll: vi.fn() }
    const maintenance = new McpContentMaintenance(db, memory.storage, secrets, async () => {
      throw new Error('Unused synthetic resolver')
    })
    expect(await maintenance.sweepMasks({ siteId: fixture.siteId })).toMatchObject({
      visited: 0,
      purged: 0,
    })
    expect(secrets.kvDestroyAll).not.toHaveBeenCalled()
    expect(
      (await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).contentRetiredAt,
    ).toBeNull()
  })

  it('rejects a content completion hash on an unfinished call at the database boundary', async () => {
    const f = await contentFixture()
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    const receipt = await f.snapshots.save(reservation.snapshot, Buffer.from('synthetic'))
    await f.journal.attachSnapshot(f.scope, reservation.callId, receipt)
    await f.journal.beginWrite(f.scope, reservation.callId)
    await expect(
      db.mcpCall.update({
        where: { id: reservation.callId },
        data: { appliedStateHash: 'a'.repeat(64) },
      }),
    ).rejects.toThrow()
  })

  it('refuses a foreign or purged restore source before touching the site', async () => {
    const f = await publishedFixture()
    const source = (await f.edit('B')).response as { snapshotId: string }
    await expect(
      f.service().restore(f.scope, { snapshotId: randomUUID(), idempotencyKey: 'foreign' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await db.snapshot.update({
      where: { id: source.snapshotId },
      data: { expiresAt: new Date(Date.now() - 1000), purgeRequestedAt: new Date() },
    })
    await expect(
      f.service().restore(f.scope, { snapshotId: source.snapshotId, idempotencyKey: 'expired' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.gateway.conditionalWrite).toHaveBeenCalledOnce()
  })

  it('requires a persisted task turn before reserving a mutation', async () => {
    const scope = (await store.authenticate(fixture.token))!
    await expect(
      new PostgresMcpJournal(db).reserve(scope, {
        tool: 'wp_rest',
        objectRef: 'post:42',
        idempotencyKey: 'synthetic',
        arguments: {},
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'MCP mutation requires a persisted task turn',
    })
    expect(await db.mcpCall.count({ where: { turn: { taskId: fixture.taskId } } })).toBe(0)
    expect(await db.snapshot.count({ where: { taskId: fixture.taskId } })).toBe(0)
  })

  it('admits one concurrent call, binds reordered input, rejects key reuse with changed content', async () => {
    const f = await contentFixture()
    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => f.journal.reserve(f.scope, f.command)),
    )
    expect(reservations.filter((r) => r.kind === 'claimed')).toHaveLength(1)
    expect(reservations.filter((r) => r.kind === 'pending')).toHaveLength(7)
    const first = claimed(reservations.find((r) => r.kind === 'claimed')!)
    expect(new Set(reservations.map((r) => r.callId)).size).toBe(1)
    expect(
      await f.journal.reserve(f.scope, {
        ...f.command,
        arguments: { content: 'Текст', title: 'После' },
      }),
    ).toMatchObject({ kind: 'pending', callId: first.callId, stage: 'capture', stale: false })
    await expect(
      f.journal.reserve(f.scope, { ...f.command, arguments: { title: 'Другое' } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      f.journal.reserve(f.scope, { ...f.command, idempotencyKey: 'another-call' }),
    ).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const snapshot = await db.snapshot.findUniqueOrThrow({ where: { id: first.snapshot.id } })
    expect(
      snapshot.expiresAt.getTime() -
        (await db.mcpCall.findUniqueOrThrow({ where: { id: first.callId } })).createdAt.getTime(),
    ).toBeGreaterThan(CONTENT_SNAPSHOT_TTL_MS - 1000)
    const call = await db.mcpCall.findUniqueOrThrow({ where: { id: first.callId } })
    expect(call).toMatchObject({
      assignmentId: fixture.assignmentId,
      credentialKeyId: fixture.keyId,
      leaseEpoch: 1,
    })
    expect(
      JSON.stringify(call, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toMatch(/synthetic-edit|После|Текст|mcp_/)
    expect(await db.snapshot.count({ where: { taskId: fixture.taskId } })).toBe(1)
  })

  /** Moves the admission of a call into the past, on the PostgreSQL clock. */
  const aged = (callId: string, ms: number) =>
    db.$executeRaw`UPDATE mcp_calls
      SET created_at = clock_timestamp() - make_interval(secs => ${ms / 1000}::double precision)
      WHERE id = ${callId}::uuid`

  it('blocks on a capture of the running turn only while a preparation can still last', async () => {
    const f = await contentFixture()
    const first = claimed(await f.journal.reserve(f.scope, f.command))
    const another = { ...f.command, idempotencyKey: 'another-call' }
    // Just inside the limit the first request may still be reading the site or storing the snapshot.
    await aged(first.callId, CONTENT_PREPARATION_LIMIT_MS - 5000)
    expect(await f.journal.reserve(f.scope, f.command)).toEqual({
      kind: 'pending',
      callId: first.callId,
      stage: 'capture',
      recoveryRequired: false,
      stale: false,
    })
    await expect(f.journal.reserve(f.scope, another)).rejects.toMatchObject({
      code: 'MCP_CALL_IN_FLIGHT',
    })
    expect(await f.journal.recoverCaptures(fixture.siteId)).toBe(0)
    // Past it no step of a preparation is still running: the call is reported as stale to its
    // own key, and another key closes it under the lease lock and goes on.
    await aged(first.callId, CONTENT_PREPARATION_LIMIT_MS + 1000)
    expect(await f.journal.reserve(f.scope, f.command)).toMatchObject({
      kind: 'pending',
      callId: first.callId,
      stage: 'capture',
      recoveryRequired: false,
      stale: true,
    })
    const next = claimed(await f.journal.reserve(f.scope, another))
    expect(await db.mcpCall.findUniqueOrThrow({ where: { id: first.callId } })).toMatchObject({
      result: 'error',
      response: { code: 'CONTENT_PREPARATION_INTERRUPTED' },
      writeStartedAt: null,
    })
    // The late first request can neither record its snapshot nor open a write.
    const receipt = await f.snapshots.save(first.snapshot, Buffer.from('late'))
    await expect(f.journal.attachSnapshot(f.scope, first.callId, receipt)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(await f.journal.beginWrite(f.scope, first.callId)).toBe(false)
    expect(
      await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
    ).toMatchObject({ inflightMcpCallId: null, heldForOperator: false })
    expect(await f.journal.reserve(f.scope, f.command)).toMatchObject({
      kind: 'replay',
      completion: { result: 'error', response: { code: 'CONTENT_PREPARATION_INTERRUPTED' } },
    })
    await f.journal.finish(f.scope, next.callId, {
      result: 'denied',
      response: { code: 'SYNTHETIC_STOP' },
    })
  })

  it('never takes a call whose write has started for a stale preparation', async () => {
    const f = await contentFixture()
    const first = claimed(await f.journal.reserve(f.scope, f.command))
    const receipt = await f.snapshots.save(first.snapshot, Buffer.from('before'))
    await f.journal.attachSnapshot(f.scope, first.callId, receipt)
    expect(await f.journal.beginWrite(f.scope, first.callId)).toBe(true)
    await aged(first.callId, CONTENT_PREPARATION_LIMIT_MS + 60_000)
    expect(await f.journal.reserve(f.scope, f.command)).toMatchObject({
      kind: 'pending',
      stage: 'write',
      recoveryRequired: true,
      stale: false,
    })
    await expect(
      f.journal.reserve(f.scope, { ...f.command, idempotencyKey: 'another-call' }),
    ).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    expect(await f.journal.recoverCaptures(fixture.siteId)).toBe(0)
    expect((await db.mcpCall.findUniqueOrThrow({ where: { id: first.callId } })).result).toBeNull()
    await f.journal.finish(f.scope, first.callId, {
      result: 'error',
      response: { code: 'SYNTHETIC_STOP' },
    })
  })

  it('lets the turn edit again after an outage left its preparation open', async () => {
    const f = await publishedFixture()
    // PostgreSQL is away for a moment: the snapshot is stored, but neither its record nor
    // the record that closes the call reaches the journal.
    const outage = () => new DomainError('MCP_JOURNAL_UNAVAILABLE', 'synthetic outage', 503)
    vi.spyOn(f.journal, 'attachSnapshot').mockRejectedValueOnce(outage())
    vi.spyOn(f.journal, 'finish').mockRejectedValueOnce(outage())
    await expect(f.edit('during-outage')).rejects.toMatchObject({ code: 'MCP_JOURNAL_UNAVAILABLE' })
    const open = await db.mcpCall.findFirstOrThrow({ where: { turn: { taskId: fixture.taskId } } })
    expect(open).toMatchObject({ result: null, writeStartedAt: null })
    // At once the answer is the same for either key: the first request may still be running.
    await expect(f.edit('during-outage')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    await expect(f.edit('next')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    await aged(open.id, CONTENT_PREPARATION_LIMIT_MS + 1000)
    // The same key closes its own call and learns to go on with a new one...
    expect(await f.edit('during-outage')).toEqual({
      result: 'error',
      response: { code: 'CONTENT_PREPARATION_INTERRUPTED' },
    })
    expect(f.gateway.conditionalWrite).not.toHaveBeenCalled()
    // ...and the new key writes, in the same turn.
    expect((await f.edit('next')).result).toBe('ok')
    expect(f.gateway.conditionalWrite).toHaveBeenCalledOnce()
    expect(f.state().title).toBe('next')
  })

  it('lets a new key through past a stale preparation without the old key being retried', async () => {
    const f = await publishedFixture()
    const outage = () => new DomainError('MCP_JOURNAL_UNAVAILABLE', 'synthetic outage', 503)
    vi.spyOn(f.journal, 'attachSnapshot').mockRejectedValueOnce(outage())
    vi.spyOn(f.journal, 'finish').mockRejectedValueOnce(outage())
    await expect(f.edit('during-outage')).rejects.toMatchObject({ code: 'MCP_JOURNAL_UNAVAILABLE' })
    const open = await db.mcpCall.findFirstOrThrow({ where: { turn: { taskId: fixture.taskId } } })
    await aged(open.id, CONTENT_PREPARATION_LIMIT_MS + 1000)
    expect((await f.edit('next')).result).toBe('ok')
    expect((await db.mcpCall.findUniqueOrThrow({ where: { id: open.id } })).response).toEqual({
      code: 'CONTENT_PREPARATION_INTERRUPTED',
    })
  })

  it.each([
    ['behind', -3_600_000],
    ['ahead', 3_600_000],
  ])(
    'dates a preparation on the PostgreSQL clock when the clock of this process is an hour %s',
    async (_label, skewMs) => {
      const f = await contentFixture()
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skewMs })
      try {
        const first = claimed(await f.journal.reserve(f.scope, f.command))
        const [admitted] = await db.$queryRaw<Array<{ age: number }>>`
          SELECT extract(epoch FROM clock_timestamp() - created_at)::double precision AS age
          FROM mcp_calls WHERE id = ${first.callId}::uuid`
        expect(admitted!.age).toBeGreaterThanOrEqual(0)
        expect(admitted!.age).toBeLessThan(30)
        // A call admitted a moment ago is not stale: neither its own key nor another closes it.
        expect(await f.journal.reserve(f.scope, f.command)).toMatchObject({
          kind: 'pending',
          callId: first.callId,
          stale: false,
        })
        await expect(
          f.journal.reserve(f.scope, { ...f.command, idempotencyKey: 'another-call' }),
        ).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
        expect(await f.journal.recoverCaptures(fixture.siteId)).toBe(0)
        expect(
          (await db.mcpCall.findUniqueOrThrow({ where: { id: first.callId } })).result,
        ).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('backs up original state, grants one write, and replays its exact response after restart', async () => {
    const f = await contentFixture()
    const before = Buffer.from(JSON.stringify({ title: 'До', content: 'Синтетическая страница' }))
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    await expect(f.journal.beginWrite(f.scope, reservation.callId)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    const receipt = await f.snapshots.save(reservation.snapshot, before)
    await f.journal.attachSnapshot(f.scope, reservation.callId, receipt)
    await f.journal.attachSnapshot(f.scope, reservation.callId, receipt)
    expect(await f.journal.reserve(f.scope, f.command)).toMatchObject({
      kind: 'pending',
      stage: 'ready',
    })
    const starters = await Promise.all(
      Array.from({ length: 8 }, () => f.journal.beginWrite(f.scope, reservation.callId)),
    )
    expect(starters.filter(Boolean)).toHaveLength(1)
    expect(
      await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
    ).toMatchObject({ inflightMcpCallId: reservation.callId })
    // A fake content adapter: only the winner performs a side effect in this local foundation.
    let writeCount = 0
    let siteState = before
    for (const mayWrite of starters)
      if (mayWrite) {
        writeCount++
        siteState = Buffer.from(JSON.stringify(f.command.arguments))
      }
    expect(writeCount).toBe(1)
    expect(siteState).not.toEqual(before)
    const completion = { result: 'ok' as const, response: { object: 'post:42', updated: true } }
    await f.journal.finish(f.scope, reservation.callId, completion)
    const restarted = new PostgresMcpJournal(db)
    expect(await restarted.reserve(f.scope, f.command)).toEqual({
      kind: 'replay',
      callId: reservation.callId,
      completion,
    })
    expect(await restarted.beginWrite(f.scope, reservation.callId)).toBe(false)
    await restarted.finish(f.scope, reservation.callId, completion)
    await expect(
      restarted.finish(f.scope, reservation.callId, {
        ...completion,
        response: { updated: false },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await f.snapshots.load(receipt)).toEqual(before)
    expect(f.transit.allZeroed()).toBe(true)
    expect(await f.leases.release(f.fence)).toBe(true)
  })

  it('retains the first snapshot across an unacknowledged artifact PUT and a journal restart', async () => {
    const f = await contentFixture()
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    f.memory.storage.putIfAbsent.mockImplementationOnce(async (_bucket, key, body) => {
      f.memory.objects.set(key, Buffer.from(body))
      throw new Error('synthetic lost acknowledgement')
    })
    await expect(
      f.snapshots.save(reservation.snapshot, Buffer.from('before')),
    ).rejects.toMatchObject({ code: 'CONTENT_SNAPSHOT_UNAVAILABLE' })
    const restarted = new PostgresMcpJournal(db)
    expect(await restarted.reserve(f.scope, f.command)).toMatchObject({
      kind: 'pending',
      stage: 'capture',
    })
    expect(
      (await db.mcpCall.findUniqueOrThrow({ where: { id: reservation.callId } })).writeStartedAt,
    ).toBeNull()
    const receipt = await f.snapshots.save(reservation.snapshot, Buffer.from('before'))
    await restarted.attachSnapshot(f.scope, reservation.callId, receipt)
    expect(await restarted.beginWrite(f.scope, reservation.callId)).toBe(true)
    await restarted.finish(f.scope, reservation.callId, {
      result: 'error',
      response: { code: 'ADAPTER_REJECTED_BEFORE_APPLY' },
    })
  })

  it('refuses mismatched snapshots and scopes, and rechecks revocation before the write', async () => {
    const f = await contentFixture()
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    const receipt = await f.snapshots.save(reservation.snapshot, Buffer.from('before'))
    await expect(
      f.journal.attachSnapshot(f.scope, reservation.callId, { ...receipt, objectRef: 'post:43' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      f.journal.attachSnapshot({ ...f.scope, sessionId: 'foreign' }, reservation.callId, receipt),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' })
    await f.journal.attachSnapshot(f.scope, reservation.callId, receipt)
    await db.llmKey.update({
      where: { id: fixture.keyId },
      data: { revokeRequestedAt: new Date() },
    })
    await expect(f.journal.beginWrite(f.scope, reservation.callId)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
    expect(
      (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }))
        .inflightMcpCallId,
    ).toBeNull()
    // Ending a denied/rejected call is evidence, not permission to write.
    await f.journal.finish(f.scope, reservation.callId, {
      result: 'denied',
      response: { code: 'REVOKED' },
    })
  })

  it('blocks release, force-free and a new owner after a crash and lease expiry', async () => {
    const f = await contentFixture()
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    await f.journal.attachSnapshot(
      f.scope,
      reservation.callId,
      await f.snapshots.save(reservation.snapshot, Buffer.from('before')),
    )
    expect(await f.journal.beginWrite(f.scope, reservation.callId)).toBe(true)
    expect(await new PostgresMcpJournal(db).reserve(f.scope, f.command)).toMatchObject({
      kind: 'pending',
      stage: 'write',
      recoveryRequired: true,
    })
    expect(await f.leases.release(f.fence)).toBe(false)
    expect(await f.leases.free(f.fence)).toBe(false)
    await db.siteLease.update({
      where: { siteId: fixture.siteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(await f.leases.acquire({ ...f.fence, ttlMs: 60_000 })).toBeNull()
    expect(await f.leases.free(f.fence)).toBe(false)
    // A proven late acknowledgement closes the barrier even after token revocation/expiry.
    await db.llmKey.update({
      where: { id: fixture.keyId },
      data: { revokeRequestedAt: new Date() },
    })
    await f.journal.finish(f.scope, reservation.callId, {
      result: 'ok',
      response: { updated: true },
    })
    expect((await f.leases.acquire({ ...f.fence, ttlMs: 60_000 }))?.epoch).toBe(2)
    await expect(
      f.journal.finish(f.scope, reservation.callId, { result: 'ok', response: { updated: true } }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' })
  })

  it('preserves an operator hold for an ambiguous write after its barrier is closed', async () => {
    const f = await contentFixture()
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    await f.journal.attachSnapshot(
      f.scope,
      reservation.callId,
      await f.snapshots.save(reservation.snapshot, Buffer.from('before')),
    )
    await f.journal.beginWrite(f.scope, reservation.callId)
    await db.siteLease.update({
      where: { siteId: fixture.siteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await f.journal.markAmbiguous(f.scope, reservation.callId)
    expect(await f.leases.free(f.fence)).toBe(false)
    await f.journal.finish(f.scope, reservation.callId, {
      result: 'error',
      response: { code: 'PROVEN_NO_CHANGE' },
    })
    expect(await f.leases.inspect(fixture.siteId)).toMatchObject({ heldForOperator: true })
    expect(await f.leases.acquire({ ...f.fence, ttlMs: 60_000 })).toBeNull()
    expect(await f.leases.free(f.fence)).toBe(true)
    expect((await f.leases.acquire({ ...f.fence, ttlMs: 60_000 }))?.epoch).toBe(2)
  })

  it('sees a write barrier committed while a new acquire was waiting on the lease row', async () => {
    const f = await contentFixture()
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    await f.journal.attachSnapshot(
      f.scope,
      reservation.callId,
      await f.snapshots.save(reservation.snapshot, Buffer.from('before')),
    )
    await db.siteLease.update({
      where: { siteId: fixture.siteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const locked = Promise.withResolvers<void>()
    const unlock = Promise.withResolvers<void>()
    const writing = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT site_id FROM site_leases WHERE site_id = ${fixture.siteId}::uuid FOR UPDATE`
      locked.resolve()
      await unlock.promise
      await tx.siteLease.update({
        where: { siteId: fixture.siteId },
        data: { inflightMcpCallId: reservation.callId },
      })
      await tx.mcpCall.update({
        where: { id: reservation.callId },
        data: { writeStartedAt: new Date() },
      })
    })
    await locked.promise
    const acquiring = f.leases.acquire({ ...f.fence, ttlMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    unlock.resolve()
    await writing
    expect(await acquiring).toBeNull()
    expect(
      (await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })).epoch,
    ).toBe(1)
  })

  it('checks current time after a blocked lease lock rather than accepting an expired scope', async () => {
    const f = await contentFixture()
    const locked = Promise.withResolvers<void>()
    const unlock = Promise.withResolvers<void>()
    const expiring = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT site_id FROM site_leases WHERE site_id = ${fixture.siteId}::uuid FOR UPDATE`
      await tx.siteLease.update({
        where: { siteId: fixture.siteId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      locked.resolve()
      await unlock.promise
    })
    await locked.promise
    const attempting = f.journal.reserve(f.scope, f.command)
    const rejected = expect(attempting).rejects.toMatchObject({ code: 'LEASE_LOST' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    unlock.resolve()
    await expiring
    await rejected
    expect(await db.snapshot.count({ where: { taskId: fixture.taskId } })).toBe(0)
  })

  it('requires approval for the 21st changed object but permits another edit of an existing one', async () => {
    const f = await contentFixture()
    for (let object = 1; object <= 20; object++) {
      const reservation = claimed(
        await f.journal.reserve(f.scope, {
          ...f.command,
          objectRef: `post:${object}`,
          idempotencyKey: `edit-${object}`,
        }),
      )
      await f.journal.attachSnapshot(
        f.scope,
        reservation.callId,
        await f.snapshots.save(reservation.snapshot, Buffer.from('before')),
      )
      await f.journal.beginWrite(f.scope, reservation.callId)
      await f.journal.finish(f.scope, reservation.callId, {
        result: 'ok',
        response: { updated: true },
      })
    }
    await expect(
      f.journal.reserve(f.scope, { ...f.command, objectRef: 'post:21' }),
    ).rejects.toMatchObject({ code: 'MCP_APPROVAL_REQUIRED' })
    const repeat = claimed(await f.journal.reserve(f.scope, { ...f.command, objectRef: 'post:1' }))
    await f.journal.finish(f.scope, repeat.callId, {
      result: 'denied',
      response: { code: 'SYNTHETIC_STOP' },
    })
  }, 15_000)

  it('enforces binding, result and receipt constraints in PostgreSQL', async () => {
    const f = await contentFixture()
    const reservation = claimed(await f.journal.reserve(f.scope, f.command))
    await expect(
      db.mcpCall.update({ where: { id: reservation.callId }, data: { requestHash: 'invalid' } }),
    ).rejects.toThrow()
    await expect(
      db.mcpCall.update({
        where: { id: reservation.callId },
        data: { result: 'ok', finishedAt: new Date(), response: {} },
      }),
    ).rejects.toThrow()
    await expect(
      db.snapshot.update({
        where: { id: reservation.snapshot.id },
        data: { payloadSha256: 'a'.repeat(64), sizeBytes: null },
      }),
    ).rejects.toThrow()
    await expect(
      db.snapshot.update({
        where: { id: reservation.snapshot.id },
        data: { payloadSha256: 'a'.repeat(64), sizeBytes: 65537 },
      }),
    ).rejects.toThrow()
    await f.journal.finish(f.scope, reservation.callId, { result: 'denied', response: null })
    expect(await f.journal.reserve(f.scope, f.command)).toMatchObject({
      kind: 'replay',
      completion: { result: 'denied', response: null },
    })
  })

  it('derives the exact task/site scope and survives recovery only after assignment rebinding', async () => {
    expect(await store.authenticate(fixture.token)).toMatchObject({
      taskId: fixture.taskId,
      siteId: fixture.siteId,
      workspaceId: fixture.workspaceId,
      epoch: 1,
      firstEpoch: 1,
    })
    await db.siteLease.update({ where: { siteId: fixture.siteId }, data: { epoch: 2 } })
    expect(await store.authenticate(fixture.token)).toBeNull()
    await db.turnAssignment.update({ where: { id: fixture.assignmentId }, data: { leaseEpoch: 2 } })
    expect(await store.authenticate(fixture.token)).toMatchObject({ epoch: 2, firstEpoch: 1 })
  })

  it.each([
    'expired-key',
    'revocation-requested',
    'finished-assignment',
    'expired-deadline',
    'expired-lease',
    'operator-hold',
    'wrong-session',
    'wrong-first-epoch',
    'wrong-turn',
    'new-task-attempt',
    'paused-site',
    'cancelled-task',
    'done-task',
    'failed-task',
    'rolled-back-task',
    'retired-content',
    'deploy-lease',
    'revert-lease',
    'foreign-lease',
    'missing-lease',
    'legacy-key',
  ])('refuses %s even when the token hash matches', async (scenario) => {
    // Unreachable states are left out: llm_keys_expiry_check keeps valid_until >= expires_at,
    // llm_keys_revoked_check needs revoke_requested_at for revoked_at, and turn_assignments
    // sets finished_at and outcome together.
    const key = { id: fixture.keyId }
    const assignment = { id: fixture.assignmentId }
    const lease = { siteId: fixture.siteId }
    let foreignTaskId: string | undefined
    switch (scenario) {
      case 'done-task':
      case 'failed-task':
      case 'rolled-back-task':
        await db.task.update({
          where: { id: fixture.taskId },
          data: {
            status: (
              {
                'done-task': 'done',
                'failed-task': 'failed',
                'rolled-back-task': 'rolled_back',
              } as const
            )[scenario],
          },
        })
        break
      case 'retired-content':
        await db.task.update({
          where: { id: fixture.taskId },
          data: { contentRetiredAt: new Date() },
        })
        break
      case 'deploy-lease':
      case 'revert-lease':
        await db.siteLease.update({
          where: lease,
          data: { operation: scenario === 'deploy-lease' ? 'deploy' : 'revert' },
        })
        break
      case 'foreign-lease':
        foreignTaskId = (
          await db.task.create({
            data: { workspaceId: fixture.workspaceId, siteId: fixture.siteId, status: 'running' },
          })
        ).id
        await db.siteLease.update({ where: lease, data: { holderTaskId: foreignTaskId } })
        break
      case 'expired-key':
        await db.llmKey.update({ where: key, data: { expiresAt: new Date(Date.now() - 1000) } })
        break
      case 'revocation-requested':
        await db.llmKey.update({ where: key, data: { revokeRequestedAt: new Date() } })
        break
      case 'finished-assignment':
        await db.turnAssignment.update({
          where: assignment,
          data: { finishedAt: new Date(), outcome: 'completed' },
        })
        break
      case 'expired-deadline':
        await db.turnAssignment.update({
          where: assignment,
          data: { deadlineAt: new Date(Date.now() - 1000) },
        })
        break
      case 'expired-lease':
        await db.siteLease.update({
          where: lease,
          data: { expiresAt: new Date(Date.now() - 1000) },
        })
        break
      case 'operator-hold':
        await db.siteLease.update({ where: lease, data: { heldForOperator: true } })
        break
      case 'wrong-session':
        await db.turnAssignment.update({ where: assignment, data: { sessionId: 'different' } })
        break
      case 'wrong-first-epoch':
        await db.turnAssignment.update({
          where: assignment,
          data: { firstEpoch: 2, leaseEpoch: 2 },
        })
        break
      case 'wrong-turn':
        await db.turnAssignment.update({ where: assignment, data: { turnNo: 2 } })
        break
      case 'new-task-attempt':
        await db.task.update({ where: { id: fixture.taskId }, data: { attempt: 2 } })
        break
      case 'paused-site':
        await db.site.update({ where: { id: fixture.siteId }, data: { status: 'paused' } })
        break
      case 'cancelled-task':
        await db.task.update({ where: { id: fixture.taskId }, data: { status: 'cancelled' } })
        break
      case 'missing-lease':
        await db.siteLease.delete({ where: lease })
        break
      case 'legacy-key':
        await db.llmKey.update({ where: key, data: { mcpTokenHash: null } })
        break
    }
    try {
      expect(await store.authenticate(fixture.token)).toBeNull()
    } finally {
      if (foreignTaskId) {
        await db.siteLease.delete({ where: lease })
        await db.task.delete({ where: { id: foreignTaskId } })
      }
    }
  })

  it('enforces the paired hash format and uniqueness in PostgreSQL', async () => {
    await expect(
      db.llmKey.update({ where: { id: fixture.keyId }, data: { mcpTokenHash: 'g'.repeat(64) } }),
    ).rejects.toThrow()
    const key = await db.llmKey.findUniqueOrThrow({ where: { id: fixture.keyId } })
    await expect(
      db.llmKey.create({
        data: { ...key, id: randomUUID(), keyHash: hash(randomUUID()), turnNo: 2 },
      }),
    ).rejects.toThrow()
    expect(await store.authenticate(fixture.token)).not.toBeNull()
  })

  it('serves the guarded MCP tool and stops admitting immediately on revocation', async () => {
    const module = await Test.createTestingModule({
      imports: [McpAppModule.forRoot(testMcpConfig())],
    })
      .overrideProvider(PRISMA)
      .useValue(db)
      .overrideProvider(SECRET_STORE)
      .useValue(fakeInfra().secrets)
      .compile()
    app = module.createNestApplication({ logger: false })
    await mountMcp(app)
    await app.listen(0, '127.0.0.1')
    const post = (body: unknown) =>
      request(app!.getHttpServer())
        .post('/mcp')
        .set('Authorization', `Bearer ${fixture.token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-protocol-version', '2025-06-18')
        .send(body as object)
    const result = await post({
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/call',
      params: { name: 'site_info', arguments: {} },
    })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body.result.content[0].text)).toEqual({
      url: (await db.site.findUniqueOrThrow({ where: { id: fixture.siteId } })).url,
      stack: 'wordpress',
    })
    await db.llmKey.update({
      where: { id: fixture.keyId },
      data: { revokeRequestedAt: new Date() },
    })
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
    expect(JSON.stringify(result.body)).not.toContain(fixture.token)
  })
})
