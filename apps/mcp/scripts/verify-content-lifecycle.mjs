// Host recovery/retention on the disposable real PostgreSQL, WordPress, S3 and OpenBao.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { setTimeout } from 'node:timers/promises'

import { PostgresSiteLeaseStore, PostgresTaskTurnAssignmentStore } from '@repo/db'
import { PostgresMcpAccess } from '../dist/access/mcp-access.js'
import { PostgresMcpJournal } from '../dist/content/mcp-journal.js'
import { McpContentService } from '../dist/content/mcp-content.js'
import { McpContentMaintenance } from '../dist/content/mcp-content-maintenance.js'
import { ContentSnapshotStorage } from '../dist/content/content-snapshots.js'
import { contentMaskPath, ContentPrivacy } from '../dist/privacy/content-privacy.js'

export async function verifyContentLifecycle({
  db,
  taskId,
  siteId,
  sessionId,
  plan,
  storage,
  secrets,
  observer,
  gateway,
  issue,
  revoke,
  pageId,
}) {
  const leases = new PostgresSiteLeaseStore(db),
    assignments = new PostgresTaskTurnAssignmentStore(db)
  const fence = await leases.acquire({ siteId, taskId, operation: 'turn', ttlMs: 120_000 })
  assert(fence)
  const assignment = await assignments.open({
    fence,
    sessionId,
    turn: plan.context.turn,
    executor: 'local',
    plan,
    remainingMs: 90_000,
  })
  assert(assignment)
  const ref = { taskId, sessionId, turn: plan.context.turn, epoch: assignment.firstEpoch }
  const credentials = await issue(ref, assignment)
  const scope = await new PostgresMcpAccess(db).authenticate(credentials.mcpToken)
  assert(scope)
  const snapshots = new ContentSnapshotStorage(storage, secrets)
  const content = (journal) =>
    new McpContentService(journal, snapshots, new ContentPrivacy(secrets), async () => gateway)
  const journal = new PostgresMcpJournal(db)
  const objectRef = `page:${pageId}`
  const seeded = await content(journal).wpRest(scope, {
    method: 'POST',
    route: `/wp/v2/pages/${pageId}`,
    body: { content: '<p>synthetic contact@example.test +7 (999) 123-45-67</p>' },
    idempotencyKey: 'privacy-retention-seed',
  })
  assert.equal(seeded.result, 'ok')
  const before = await gateway.read(objectRef)
  await content(journal).wpRest(scope, { method: 'GET', route: `/wp/v2/pages/${pageId}` })
  const mapPath = contentMaskPath({ siteId, taskId })
  assert(await secrets.kvRead(mapPath), 'Actual privacy map must exist before cleanup')
  const command = (key) => ({
    tool: 'wp_rest',
    objectRef,
    idempotencyKey: key,
    arguments: { title: key },
  })
  const capture = await journal.reserve(scope, command('capture-crash'))
  assert.equal(capture.kind, 'claimed')
  assert.equal(
    await content(new PostgresMcpJournal(db)).recoverWrite(scope, capture.callId),
    'not_committed',
  )
  assert.equal(await journal.beginWrite(scope, capture.callId), false)
  const ready = await journal.reserve(scope, command('ready-crash'))
  assert.equal(ready.kind, 'claimed')
  const receipt = await snapshots.save(ready.snapshot, Buffer.from(JSON.stringify(before)))
  await journal.attachSnapshot(scope, ready.callId, receipt)
  assert.equal(
    await content(new PostgresMcpJournal(db)).recoverWrite(scope, ready.callId),
    'not_committed',
  )
  assert.equal(await journal.beginWrite(scope, ready.callId), false)
  const begin = journal.beginWrite.bind(journal)
  journal.beginWrite = async (...args) => {
    assert(await begin(...args))
    throw new Error('Synthetic lost admission acknowledgement')
  }
  await assert.rejects(
    content(journal).wpRest(scope, {
      method: 'POST',
      route: `/wp/v2/pages/${pageId}`,
      body: { title: 'Must not appear' },
      idempotencyKey: 'lost-admission',
    }),
    { code: 'MCP_CALL_IN_FLIGHT' },
  )
  const held = await db.siteLease.findUniqueOrThrow({ where: { siteId } })
  assert(held.heldForOperator && held.inflightMcpCallId)
  const intent = await new PostgresMcpJournal(db).writeIntent(scope, held.inflightMcpCallId)
  assert.equal(
    await content(new PostgresMcpJournal(db)).recoverWrite(scope, intent.callId),
    'unknown',
  )
  // The journal's own measure of the time left: this process's clock is not PostgreSQL's.
  await setTimeout(Math.max(1, intent.ttlMs + 100))
  // The maintenance entry point a scheduler calls: it reconciles writes past their deadline.
  assert.deepEqual(
    await new McpContentMaintenance(db, storage, secrets, async () => gateway).recoverWrites({
      siteId,
    }),
    { visited: 1, completed: 0, notCommitted: 1, unknown: 0, failed: 0, nextAfter: null },
  )
  assert.equal(
    await content(new PostgresMcpJournal(db)).recoverWrite(scope, intent.callId),
    'not_committed',
  )
  const after = await db.siteLease.findUniqueOrThrow({ where: { siteId } })
  assert.equal(after.inflightMcpCallId, null)
  assert(after.heldForOperator, 'Recovery does not silently release an operator hold')
  assert.equal(
    (
      await gateway.conditionalWrite({
        callId: intent.callId,
        requestHash: intent.requestHash,
        objectRef,
        siteId,
        epoch: scope.epoch,
        deadlineAt: Date.now() + 30_000,
        ttlMs: 30_000,
        mode: 'edit',
        expectedStateHash: before.stateHash,
        fields: { title: 'Must not appear' },
      })
    ).code,
    'fenced',
  )
  assert.deepEqual(await gateway.read(objectRef), before)
  console.log(
    'PASS capture and ready recovery plus durable no-write proof fence delayed WordPress dispatch',
  )

  // Age only this synthetic task's records, rather than waiting seven days in a local gate.
  // First the snapshot of one admitted write: the two fault-injection sweeps below take one
  // snapshot each, and only an admitted write has a site receipt to retire.
  const written = await db.mcpCall.findFirstOrThrow({
    where: { turn: { taskId }, writeStartedAt: { not: null }, result: 'ok' },
    select: { snapshotId: true },
  })
  await db.snapshot.update({
    where: { id: written.snapshotId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  const maintenance = (s3 = storage, vault = secrets, site = gateway) =>
    new McpContentMaintenance(db, s3, vault, async (resolved) => {
      // Maintenance reaches a site by the site alone: it borrows no turn key and no agent scope.
      assert.equal(resolved.siteId, siteId)
      assert.equal(resolved.workspaceId, scope.workspaceId)
      assert.equal(resolved.url, scope.url)
      assert.equal(resolved.keyId, undefined)
      assert.equal(resolved.taskId, undefined)
      return site
    })
  assert.equal(
    (await maintenance().sweepSnapshots({ siteId })).purged,
    0,
    'Held site must retain expired content',
  )
  // Explicit trusted operator fixture resolution, only after the durable negative proof.
  assert(await leases.free(fence))
  await revoke(ref)
  assert(await assignments.finish({ id: assignment.id, epoch: scope.epoch, outcome: 'failed' }))
  await db.task.update({
    where: { id: taskId },
    data: { status: 'failed', finishedAt: new Date(Date.now() - 8 * 86400_000) },
  })
  const first = await maintenance({
    delete: async (...args) => {
      await storage.delete(...args)
      throw new Error('Synthetic lost S3 delete acknowledgement')
    },
  }).sweepSnapshots({ siteId, limit: 1 })
  assert.equal(first.failed, 1)
  assert.equal(
    await db.snapshot.count({ where: { taskId, purgeRequestedAt: { not: null }, purgedAt: null } }),
    1,
  )
  const second = await maintenance(storage, secrets, {
    forgetOperation: async (...args) => {
      await gateway.forgetOperation(...args)
      throw new Error('Synthetic lost receipt retirement acknowledgement')
    },
  }).sweepSnapshots({ siteId, limit: 1 })
  assert.equal(second.failed, 1)
  await db.snapshot.updateMany({
    where: { taskId, expiresAt: { gt: new Date() } },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  let cursor
  do {
    const batch = await maintenance().sweepSnapshots({
      siteId,
      limit: 2,
      ...(cursor ? { after: cursor } : {}),
    })
    assert.equal(batch.failed, 0)
    cursor = batch.nextAfter
  } while (cursor)
  const allSnapshots = await db.snapshot.findMany({ where: { taskId } })
  assert(allSnapshots.every((snapshot) => snapshot.purgedAt && snapshot.purgeRequestedAt))
  for (const snapshot of allSnapshots)
    assert.equal(await storage.exists('artifacts', snapshot.s3Key), false)
  const calls = await db.mcpCall.findMany({ where: { turn: { taskId } } })
  assert(calls.every((call) => call.result && call.receiptPurgedAt))
  for (const call of calls)
    if (call.writeStartedAt) assert.equal(await gateway.operation(call.id), null)
  const masks = await maintenance(storage, {
    kvDestroyAll: async (...args) => {
      await secrets.kvDestroyAll(...args)
      throw new Error('Synthetic lost Vault destroy acknowledgement')
    },
  }).sweepMasks({ siteId })
  assert.equal(masks.failed, 1)
  assert((await db.task.findUniqueOrThrow({ where: { id: taskId } })).contentRetiredAt)
  assert.equal(await secrets.kvRead(mapPath), null)
  // The role may delete the metadata of a map but not read it (policy mcp-content): the
  // stand's observer token looks instead.
  assert.equal(
    await observer.kvMetadata(mapPath),
    null,
    'All Vault versions and metadata must be gone',
  )
  await db.task.update({ where: { id: taskId }, data: { status: 'queued' } })
  const retryLease = await leases.acquire({ siteId, taskId, operation: 'turn', ttlMs: 30_000 })
  assert(retryLease)
  await assert.rejects(
    assignments.open({
      fence: retryLease,
      sessionId,
      turn: plan.context.turn + 1,
      executor: 'local',
      remainingMs: 20_000,
      plan: {
        ...plan,
        replacesTurn: plan.context.turn,
        context: { ...plan.context, turn: plan.context.turn + 1 },
        sandbox: {
          ...plan.sandbox,
          labels: { ...plan.sandbox.labels, turn: plan.context.turn + 1 },
        },
      },
    }),
    /Task content context has expired/,
  )
  assert(await leases.release(retryLease))
  await db.task.update({ where: { id: taskId }, data: { status: 'failed' } })
  assert.equal((await maintenance().sweepMasks({ siteId })).purged, 1)
  assert((await db.task.findUniqueOrThrow({ where: { id: taskId } })).contentMasksPurgedAt)
  assert.equal((await maintenance().sweepSnapshots({ siteId })).visited, 0)
  assert.equal((await maintenance().sweepMasks({ siteId })).visited, 0)
  console.log(
    'PASS expired S3 snapshots, WordPress receipts and all Vault mask versions are retired with restart-safe acknowledgements',
  )
}
