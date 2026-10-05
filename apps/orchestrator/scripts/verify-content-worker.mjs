// Called only by the disposable local launcher. Output contains fixed PASS lines only.
// The role mcp is composed the way the regular one is: the content profile of the configuration,
// its own S3 client, Vault under the AppRole of the mcp service, the site access from Vault
// through credential_refs. Neither the operator token nor the password of the site is here.
/* eslint-disable turbo/no-undeclared-env-vars -- Standalone fixture flags are not application configuration. */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { URL } from 'node:url'

import { ListToolsResultSchema } from '@modelcontextprotocol/core'
import { NestFactory } from '@nestjs/core'
import { createPrismaClient, PostgresSiteLeaseStore } from '@repo/db'
import { siteAccessPath } from '@repo/domain'
import { createS3Client, createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore } from '@repo/vault'
import { McpAppModule } from '../dist/mcp/mcp-app.module.js'
import { PostgresMcpAccess } from '../dist/mcp/mcp-access.js'
import { MCP_CONTENT } from '../dist/mcp/mcp-content.js'
import { mountMcp } from '../dist/mcp/mcp-server.js'
import { SECRET_STORE } from '../dist/infra/tokens.js'
import { verifyContentTurns } from './verify-content-turns.mjs'

const { fetch, AbortSignal } = globalThis

const hash = (text) => createHash('sha256').update(text).digest('hex')
assert.match(process.env.RADITI_CONTENT_DISPOSABLE_ID ?? '', /^[a-f0-9]{32}$/)
assert.equal(process.env.APP_ENV, 'test')
assert.equal(
  process.env.VAULT_DEV_ROOT_TOKEN,
  undefined,
  'The role must not hold the operator token',
)
const fixture = JSON.parse(await readFile(process.env.RADITI_CONTENT_FIXTURE_FILE, 'utf8'))
assert.equal(new URL(fixture.origin).hostname, '127.0.0.1')
assert.deepEqual(Object.keys(fixture).sort(), [
  'accessVersion',
  'observerToken',
  'origin',
  'original',
  'pageId',
  'secondPageId',
  'siteId',
  'workspaceId',
])
const db = createPrismaClient({ databaseUrl: process.env.DATABASE_URL, log: [] })
const storageConfig = storageConfigFromEnv(process.env)
const client = createS3Client(storageConfig)
const storage = createS3ObjectStorage(storageConfig, client)
let app
try {
  const suffix = randomBytes(8).toString('hex'),
    token = `mcp_${randomBytes(32).toString('hex')}`
  const scopeData = await db.$transaction(async (tx) => {
    // The launcher created the Transit key of this workspace before the worker started.
    const workspace = await tx.workspace.create({
      data: { id: fixture.workspaceId, name: 'Synthetic P6 MCP', dataClass: 'synthetic' },
    })
    const site = await tx.site.create({
      data: {
        id: fixture.siteId,
        workspaceId: workspace.id,
        name: 'Synthetic P6 site',
        url: fixture.origin,
        stack: 'wordpress',
        status: 'active',
      },
    })
    // The reference the connection step leaves: where the access is and which version of it.
    const access = await tx.credentialRef.create({
      data: {
        kind: 'wp',
        workspaceId: workspace.id,
        siteId: site.id,
        vaultPath: siteAccessPath(fixture.siteId, 'wp'),
        keyVersion: fixture.accessVersion,
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
        label: suffix,
        plan: 'synthetic',
        credentialRefId: credential.id,
        maxConcurrentTurns: 1,
        maxConcurrentRequests: 1,
      },
    })
    await tx.llmKey.create({
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
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        validUntil: new Date(Date.now() + 600_000),
      },
    })
    await tx.turnAssignment.create({
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
    await tx.taskTurn.create({
      data: {
        taskId: task.id,
        turnNo: 1,
        status: 'running',
        driverId: driver.id,
        modelId: model.id,
        image: driver.image,
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
      taskId: task.id,
      siteId: site.id,
      modelId: model.id,
      accountId: account.id,
      accessRefId: access.id,
    }
  })
  let loseAcknowledgement = false,
    writes = 0,
    regular
  /** The regular gateway of the site with the stand's observations and faults around a write. */
  const observed = (site) => ({
    read: (objectRef) => site.read(objectRef),
    operation: (callId) => site.operation(callId),
    reconcileOperation: (request) => site.reconcileOperation(request),
    forgetOperation: (request) => site.forgetOperation(request),
    conditionalWrite: async (request) => {
      writes++
      const call = await db.mcpCall.findUniqueOrThrow({
        where: { id: request.callId },
        include: { snapshot: true },
      })
      assert(call.snapshot.payloadSha256, 'No acknowledged snapshot before write')
      assert(
        await storage.exists('artifacts', call.snapshot.s3Key),
        'Snapshot absent from actual S3',
      )
      const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: scopeData.siteId } })
      assert.equal(lease.inflightMcpCallId, request.callId)
      const result = await site.conditionalWrite(request)
      if (loseAcknowledgement && result.kind === 'committed')
        throw new Error('Synthetic dropped write acknowledgement')
      return result
    },
  })
  // What MCP_CONTENT_PROFILE=local gives the regular role: the profile, the S3 connection with
  // the artifacts bucket alone, and Vault under the AppRole of the mcp service.
  const config = {
    appEnv: 'test',
    port: 0,
    allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
    db: { databaseUrl: process.env.DATABASE_URL },
    vault: {
      addr: process.env.VAULT_ADDR,
      appRole: {
        roleId: process.env.VAULT_ROLE_ID,
        secretId: process.env.VAULT_SECRET_ID,
      },
    },
    contentProfile: 'local',
    storage: {
      endpoint: storageConfig.endpoint,
      region: storageConfig.region,
      accessKeyId: storageConfig.accessKeyId,
      secretAccessKey: storageConfig.secretAccessKey,
      forcePathStyle: storageConfig.forcePathStyle,
      buckets: { artifacts: storageConfig.buckets.artifacts },
    },
  }
  const start = async () => {
    app = await NestFactory.create(
      // The only seam: the regular resolver (credential_refs → Vault → adapter of the stack)
      // wrapped for the observations and the lost acknowledgement of this stand.
      McpAppModule.forRoot(config, {
        wrapResolver: (resolver) => {
          regular = resolver
          return async (scope) => {
            // The site of the call: an agent scope and the scope of the trusted host both
            // carry it, and the regular resolver reads nothing else.
            assert.equal(scope.siteId, scopeData.siteId)
            assert.equal(scope.workspaceId, scopeData.workspaceId)
            assert.equal(scope.url, fixture.origin)
            return observed(await resolver(scope))
          }
        },
      }),
      { logger: false },
    )
    await mountMcp(app)
    await app.listen(0, '127.0.0.1')
  }
  await start()
  const scope = await new PostgresMcpAccess(db).authenticate(token)
  assert(scope)
  // The stand's own look at the site goes through the gateway the role itself built.
  const gateway = await regular(scope)
  const refusedAs = (reason) => (error) =>
    error.code === 'CONTENT_SITE_ACCESS_UNAVAILABLE' && error.details?.reason === reason
  const reference = (data) =>
    db.credentialRef.update({ where: { id: scopeData.accessRefId }, data })
  // A reference that names another version, another site's secret or another kind is not
  // followed, and the access cached a moment ago is not used instead.
  await reference({ keyVersion: fixture.accessVersion + 1 })
  await assert.rejects(regular(scope), refusedAs('version'))
  await reference({
    keyVersion: fixture.accessVersion,
    vaultPath: siteAccessPath(randomUUID(), 'wp'),
  })
  await assert.rejects(regular(scope), refusedAs('path'))
  await reference({ vaultPath: siteAccessPath(fixture.siteId, 'ssh') })
  await assert.rejects(regular(scope), refusedAs('path'))
  await reference({ vaultPath: siteAccessPath(fixture.siteId, 'wp') })
  assert.equal((await (await regular(scope)).read(`page:${fixture.pageId}`)).kind, 'page')
  // The token of the role is the one the policy mcp-content gives: no other access of the site.
  await assert.rejects(
    app.get(SECRET_STORE).kvRead(siteAccessPath(fixture.siteId, 'ssh')),
    (error) => error.status === 403,
  )
  console.log(
    'PASS role mcp under AppRole mcp-content builds the site gateway from Vault through credential_refs',
  )
  let sequence = 0
  const rpc = async (method, params) => {
    const response = await fetch(`${await app.getUrl()}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
      signal: AbortSignal.timeout(15_000),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert(!result.error, 'RPC transport error')
    return result.result
  }
  const tool = async (name, args) => rpc('tools/call', { name, arguments: args })
  const json = (result) => JSON.parse(result.content[0].text)
  const route = `/wp/v2/pages/${fixture.pageId}`
  const listed = await rpc('tools/list', {})
  assert.deepEqual(listed.tools.map((item) => item.name).sort(), [
    'restore',
    'site_info',
    'wp_rest',
  ])
  // Codex and Kimi CLI refuse a whole tool list in which one tool has no object input schema.
  assert(ListToolsResultSchema.safeParse(listed).success, 'tools/list must match the MCP schema')
  assert(listed.tools.every((item) => item.inputSchema?.type === 'object'))
  const masked = json(await tool('wp_rest', { method: 'GET', route }))
  assert(!JSON.stringify(masked).includes('contact@example.test'))
  assert(!JSON.stringify(masked).includes('123-45-67'))
  assert.match(masked.content, /\[\[raditi:email:/)
  console.log('PASS authenticated MCP read masks public contacts')
  const input = {
    method: 'POST',
    route,
    body: { content: masked.content.replace('original', 'changed') },
    idempotencyKey: 'synthetic-edit',
  }
  const edited = await tool('wp_rest', input)
  assert(!edited.isError)
  const edit = json(edited)
  const state = await gateway.read(`page:${fixture.pageId}`)
  assert(state.content.includes('changed contact@example.test +7 (999) 123-45-67'))
  const publicHtml = await (
    await fetch(`${fixture.origin}/?page_id=${fixture.pageId}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
  ).text()
  assert(publicHtml.includes('changed contact@example.test'))
  const snapshot = await db.snapshot.findUniqueOrThrow({ where: { id: edit.snapshotId } })
  const chunks = []
  for await (const chunk of await storage.get('artifacts', snapshot.s3Key)) chunks.push(chunk)
  assert(!Buffer.concat(chunks).toString().includes('contact@example.test'))
  await app.close()
  await start()
  assert.deepEqual(await tool('wp_rest', input), edited)
  assert.equal(writes, 1)
  console.log(
    'PASS real WordPress edit follows encrypted S3 snapshot and replays after MCP restart',
  )
  const restored = await tool('restore', {
    snapshotId: edit.snapshotId,
    idempotencyKey: 'synthetic-restore',
  })
  assert(!restored.isError)
  const restoredState = await gateway.read(`page:${fixture.pageId}`)
  for (const field of ['title', 'content', 'excerpt'])
    assert.equal(restoredState[field], fixture.original[field])
  assert.deepEqual(
    await tool('restore', { snapshotId: edit.snapshotId, idempotencyKey: 'synthetic-restore' }),
    restored,
  )
  assert((await db.snapshot.findUniqueOrThrow({ where: { id: edit.snapshotId } })).restoredAt)
  await tool('wp_rest', {
    method: 'POST',
    route,
    body: { title: 'Second' },
    idempotencyKey: 'second',
  })
  await tool('wp_rest', {
    method: 'POST',
    route,
    body: { title: 'Third' },
    idempotencyKey: 'third',
  })
  // The trusted undo of the role: by the fence of the turn lease, with no token of the turn.
  assert.deepEqual(
    await app.get(MCP_CONTENT).undoTurn({
      fence: { siteId: fixture.siteId, taskId: scopeData.taskId, operation: 'turn', epoch: 1 },
      turn: 1,
    }),
    { restored: 2 },
  )
  assert.equal((await gateway.read(`page:${fixture.pageId}`)).title, fixture.original.title)
  console.log('PASS restore and reverse turn undo preserve original content and journal evidence')
  const driftSource = json(
    await tool('wp_rest', {
      method: 'POST',
      route,
      body: { title: 'Before drift' },
      idempotencyKey: 'before-drift',
    }),
  )
  const driftBefore = await gateway.read(`page:${fixture.pageId}`)
  const direct = {
    callId: randomUUID(),
    siteId: fixture.siteId,
    epoch: 1,
    requestHash: hash('synthetic-human-edit'),
    objectRef: `page:${fixture.pageId}`,
    expectedStateHash: driftBefore.stateHash,
    deadlineAt: Date.now() + 10_000,
    ttlMs: 10_000,
    mode: 'edit',
    fields: { content: '<p>Later human edit</p>' },
  }
  assert.equal((await gateway.conditionalWrite(direct)).kind, 'committed')
  assert(
    (await tool('restore', { snapshotId: driftSource.snapshotId, idempotencyKey: 'drift-restore' }))
      .isError,
  )
  assert.equal((await gateway.read(`page:${fixture.pageId}`)).content, '<p>Later human edit</p>')
  assert.equal(
    (await db.snapshot.findUniqueOrThrow({ where: { id: driftSource.snapshotId } })).restoredAt,
    null,
  )
  assert((await tool('restore', { snapshotId: randomUUID(), idempotencyKey: 'foreign' })).isError)
  console.log('PASS undo refuses content drift and foreign snapshots')
  loseAcknowledgement = true
  assert(
    (
      await tool('wp_rest', {
        method: 'POST',
        route,
        body: { title: 'Lost ack applied' },
        idempotencyKey: 'lost-ack',
      })
    ).isError,
  )
  const held = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
  assert(held.heldForOperator)
  assert(held.inflightMcpCallId)
  const beforeRecoveryWrites = writes
  await app.close()
  await start()
  assert.equal(await app.get(MCP_CONTENT).recoverWrite(scope, held.inflightMcpCallId), 'completed')
  const recovered = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
  assert.equal(recovered.inflightMcpCallId, null)
  assert(recovered.heldForOperator)
  assert.equal(writes, beforeRecoveryWrites)
  console.log(
    'PASS lost acknowledgement is reconciled from durable WordPress receipt without another write',
  )
  const secondRef = `page:${fixture.secondPageId}`,
    second = await gateway.read(secondRef)
  const cas = {
    ...direct,
    callId: randomUUID(),
    objectRef: secondRef,
    requestHash: hash('cas'),
    expectedStateHash: second.stateHash,
    fields: { title: 'CAS changed' },
    deadlineAt: Date.now() + 10_000,
  }
  const casProof = await gateway.conditionalWrite(cas)
  assert.equal(casProof.kind, 'committed')
  assert.deepEqual(await gateway.conditionalWrite(cas), casProof)
  assert.deepEqual(await gateway.operation(cas.callId), casProof)
  assert.deepEqual(await gateway.conditionalWrite({ ...cas, callId: randomUUID() }), {
    version: 1,
    kind: 'rejected',
    code: 'conflict',
  })
  const later = await gateway.read(secondRef)
  assert.equal(
    (
      await gateway.conditionalWrite({
        ...cas,
        callId: randomUUID(),
        epoch: 2,
        expectedStateHash: later.stateHash,
      })
    ).kind,
    'committed',
  )
  assert.equal(
    (
      await gateway.conditionalWrite({
        ...cas,
        callId: randomUUID(),
        expectedStateHash: later.stateHash,
      })
    ).code,
    'fenced',
  )
  assert.equal(
    (
      await gateway.conditionalWrite({
        ...cas,
        callId: randomUUID(),
        epoch: 2,
        deadlineAt: Date.now() - 1000,
        ttlMs: -1000,
        expectedStateHash: later.stateHash,
      })
    ).code,
    'fenced',
  )
  console.log(
    'PASS WordPress transaction enforces compare-and-swap, duplicate receipts, epochs and deadlines',
  )
  // The original protocol fixture has no sandbox; its proven receipt permits host cleanup.
  assert(
    await new PostgresSiteLeaseStore(db).free({
      siteId: fixture.siteId,
      taskId: scopeData.taskId,
      operation: 'turn',
      epoch: 1,
    }),
  )
  await db.turnAssignment.updateMany({
    where: { taskId: scopeData.taskId, finishedAt: null },
    data: { finishedAt: new Date(), outcome: 'completed' },
  })
  await db.taskTurn.updateMany({
    where: { taskId: scopeData.taskId, status: 'running' },
    data: { status: 'completed', finishedAt: new Date() },
  })
  // The later scenarios write through the role again: the fault of this block is over.
  loseAcknowledgement = false
  await verifyContentTurns({
    db,
    ...scopeData,
    origin: fixture.origin,
    roleContent: app.get(MCP_CONTENT),
    storage,
    // Vault as the role sees it; whether a contact map is gone entirely is the observer's look.
    secrets: app.get(SECRET_STORE),
    observer: createVaultSecretStore({
      addr: process.env.VAULT_ADDR,
      token: fixture.observerToken,
    }),
    gateway,
    pageIds: [fixture.pageId, fixture.secondPageId],
  })
} finally {
  await app?.close()
  await db.$disconnect()
  client.destroy()
}
