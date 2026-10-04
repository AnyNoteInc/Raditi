/* global AbortController, AbortSignal, clearTimeout, fetch, process, setTimeout, TextDecoder */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { codexBackend, kimiCodeBackend } from '@repo/llm-backends'

import { eventually, repository } from '../../../infra/dev/llm-verify/stack.mjs'
import { SubscriptionLogin } from '../src/subscriptions/login.ts'

/** Private IPC exposes only barrier names and success booleans, never rotated tokens. */
export async function startRefreshWorker(env) {
  const child = fork(join(repository, 'apps/orchestrator/scripts/verify-refresh-worker.mjs'), [], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const events = [],
    logs = [],
    pending = new Map()
  let bytes = 0
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) child.kill('SIGKILL')
      else logs.push(chunk.toString())
    })
  const interrupt = () => child.kill('SIGKILL')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let terminal = false
  const exited = new Promise((resolve) => {
    const finish = (code, signal) => {
      if (terminal) return
      terminal = true
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      for (const reject of pending.values()) reject(new Error('Synthetic rotation worker exited'))
      pending.clear()
      resolve({ code, signal })
    }
    child.once('exit', finish)
    child.once('close', finish)
    child.on('error', () => {
      events.push({ type: 'error' })
      if (!child.pid) finish(null, null)
      else child.kill('SIGKILL')
    })
  })
  child.on('message', (message) => events.push(message))
  const call = (operation, input = {}, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      if (terminal || !child.connected) {
        reject(new Error('Synthetic rotation IPC disconnected'))
        return
      }
      const id = randomUUID()
      let finished = false
      const finish = (error, result) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        pending.delete(id)
        child.off('message', receive)
        if (error) reject(error)
        else resolve(result)
      }
      const receive = (message) => {
        if (message.id !== id) return
        finish(message.ok ? null : new Error('Synthetic rotation operation failed'), message.result)
      }
      const timer = setTimeout(
        () => finish(new Error('Synthetic rotation response timed out')),
        timeoutMs,
      )
      pending.set(id, (error) => finish(error))
      child.on('message', receive)
      try {
        child.send({ id, operation, ...input }, (error) => {
          if (error) finish(new Error('Synthetic rotation IPC disconnected'))
        })
      } catch {
        finish(new Error('Synthetic rotation IPC disconnected'))
      }
    })
  try {
    await new Promise((resolve, reject) => {
      let finished = false
      const finish = (error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        child.off('message', receive)
        if (error) reject(error)
        else resolve()
      }
      const receive = (message) => {
        if (message.type === 'ready') finish()
        else if (message.type === 'error')
          finish(new Error('Synthetic rotation initialization failed'))
      }
      const timer = setTimeout(
        () => finish(new Error('Synthetic rotation initialization timed out')),
        30_000,
      )
      child.on('message', receive)
      exited.then(() => finish(new Error('Synthetic rotation worker exited at startup')))
      try {
        child.send({ type: 'init', config: { env } }, (error) => {
          if (error) finish(new Error('Synthetic rotation initialization failed'))
        })
      } catch {
        finish(new Error('Synthetic rotation initialization failed'))
      }
    })
    return {
      child,
      call,
      events,
      logs,
      exited,
      waitBarrier: (phase) =>
        eventually(() => events.some((event) => event.type === 'barrier' && event.phase === phase)),
      async kill() {
        child.kill('SIGKILL')
        await exited
      },
      async close() {
        if (terminal || child.exitCode !== null || child.signalCode !== null) return
        try {
          await call('close', {}, 15_000)
        } catch {
          child.kill('SIGKILL')
        }
        await exited
      },
    }
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  }
}

/** Advance the age of an owned synthetic row, then execute unchanged production collectors. */
async function lostCall(ctx, minutes, collector) {
  const { db, control, core, stack } = ctx
  const turn = await ctx.issued('openai-chatgpt')
  let stream
  try {
    await control('scenario', { scenario: 'delayed', backend: 'codex', delayMs: 60_000 })
    stream = await beginStream(ctx, turn)
    const call = await eventually(() =>
      db.llmCall.findFirst({ where: { key: { taskId: turn.ref.taskId }, state: 'open' } }),
    )
    const worker = ctx.llmGetter()
    worker.child.kill('SIGKILL')
    await worker.exited
    await stream.finished
    assert.equal((await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).state, 'open')
    const startedAt = new Date(Date.now() - minutes * 60_000)
    if (
      !(await db.llmModelPrice.findFirst({
        where: { modelId: call.modelId, effectiveFrom: { lte: startedAt } },
      }))
    ) {
      const rate = await db.llmModelPrice.findFirstOrThrow({
        where: { modelId: call.modelId },
        orderBy: { effectiveFrom: 'desc' },
        select: {
          inputPer1m: true,
          cacheReadPer1m: true,
          cacheWritePer1m: true,
          outputPer1m: true,
          vatRate: true,
        },
      })
      await db.llmModelPrice.create({
        data: {
          modelId: call.modelId,
          ...rate,
          effectiveFrom: new Date(+startedAt - 60_000),
          sourceUrl: 'https://synthetic.invalid/b13-crash-rates',
        },
      })
    }
    await db.llmCall.update({
      where: { id: call.id },
      data: { startedAt },
    })
    if (collector === 'core') {
      assert.ok(worker.signalCode === 'SIGKILL' || worker.child.signalCode === 'SIGKILL')
      await core.call('sweep')
    } else await ctx.restartLlm()
    const closed = await eventually(async () => {
      const result = await db.llmCall.findUniqueOrThrow({
        where: { id: call.id },
        include: { tokenUsage: true },
      })
      return result.state === 'lost' && result.tokenUsage ? result : false
    })
    assert.equal(closed.tokenUsage.billable, false)
    assert.equal(closed.tokenUsage.estimated, true)
    assert.equal(closed.tokenUsage.estimateReason, 'lost')
    await core.call('sweep')
    assert.equal(await db.tokenUsage.count({ where: { gatewayCallId: call.id } }), 1)
    if (collector === 'core') await ctx.restartLlm()
    await eventually(
      async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
    )
    ctx.passed(
      `SIGKILL mid-stream: ${collector} collector closes lost/nonbillable (synthetic age ${minutes}m)`,
    )
  } finally {
    stream?.abort()
    await core.call('revoke', { ref: turn.ref })
    await control('scenario', { scenario: 'text', backend: 'codex' })
  }
}

async function beginStream(ctx, turn) {
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${ctx.stack.llmPort}/codex/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${turn.values.llmApiKey}`,
      'content-type': 'application/json',
      'user-agent': 'codex_exec/0.158.0',
    },
    body: JSON.stringify({
      model: 'gpt-6-sol',
      input: 'Synthetic B13 crash accounting.',
      store: false,
      stream: true,
    }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
  })
  assert.equal(response.status, 200, 'Synthetic stream was refused')
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false, 'Synthetic stream ended before fault injection')
  const decoder = new TextDecoder()
  let text = decoder.decode(first.value)
  const finished = (async () => {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return { text, interrupted: false }
        text += decoder.decode(chunk.value)
      }
    } catch {
      return { text, interrupted: true }
    }
  })()
  return { finished, abort: () => controller.abort() }
}

async function databaseOutage(ctx) {
  const { db, control, core, stack } = ctx
  const turn = await ctx.issued('openai-chatgpt')
  let stream,
    paused = false
  try {
    await control('scenario', { scenario: 'delayed', backend: 'codex', delayMs: 3000 })
    stream = await beginStream(ctx, turn)
    const call = await eventually(() =>
      db.llmCall.findFirst({ where: { key: { taskId: turn.ref.taskId }, state: 'open' } }),
    )
    paused = true
    await stack.compose(['pause', 'postgres'])
    await sleep(30_000)
    await stack.compose(['unpause', 'postgres'], { cleanup: true })
    paused = false
    const completed = await stream.finished
    assert.equal(completed.interrupted, false)
    assert.ok(completed.text.includes('response.completed'))
    const usage = await eventually(
      () => db.tokenUsage.findUnique({ where: { gatewayCallId: call.id } }),
      60_000,
    )
    assert.equal(usage.estimated, false)
    assert.equal(usage.billable, true)
    assert.equal(usage.inputUncachedTokens, 80)
    assert.equal(usage.cacheReadTokens, 20)
    assert.equal(usage.outputTokens, 12)
    assert.equal(usage.reasoningTokens, 3)
    assert.equal(
      (await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).state,
      'completed',
    )
    assert.equal(await db.tokenUsage.count({ where: { gatewayCallId: call.id } }), 1)
    await eventually(
      async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
    )
    ctx.passed(
      'PostgreSQL paused for 30s at stream completion: exact provider usage persisted once',
    )
  } finally {
    if (paused) await stack.compose(['unpause', 'postgres'], { cleanup: true })
    stream?.abort()
    await core.call('revoke', { ref: turn.ref })
    await control('scenario', { scenario: 'text', backend: 'codex' })
  }
}

async function clientAborts(ctx) {
  const { db, control, core, codex } = ctx
  const turn = await ctx.issued('openai-chatgpt')
  const before = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: codex.accountId } })
  assert.equal(before.breakerOpenUntil, null)
  try {
    for (let index = 0; index < 3; index++) {
      await control('scenario', { scenario: 'delayed', backend: 'codex', delayMs: 60_000 })
      const stream = await beginStream(ctx, turn)
      const call = await eventually(() =>
        db.llmCall.findFirst({ where: { key: { taskId: turn.ref.taskId }, state: 'open' } }),
      )
      stream.abort()
      assert.equal((await stream.finished).interrupted, true)
      const closed = await eventually(async () => {
        const record = await db.llmCall.findUniqueOrThrow({
          where: { id: call.id },
          include: { tokenUsage: true },
        })
        return record.state === 'aborted' && record.tokenUsage ? record : false
      })
      assert.equal(closed.tokenUsage.estimated, true)
      assert.equal(closed.tokenUsage.estimateReason, 'aborted_client')
      assert.equal(closed.tokenUsage.billable, true)
      assert.ok(closed.tokenUsage.inputUncachedTokens > 0)
    }
    const after = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: codex.accountId } })
    assert.equal(after.breakerOpenUntil, null)
    assert.equal(after.usageMissingStreak, before.usageMissingStreak)
    assert.equal(after.health, 'ok')
    ctx.passed(
      'three client aborts: estimated aborted accounting without opening the usage breaker',
    )
  } finally {
    await core.call('revoke', { ref: turn.ref })
    await control('scenario', { scenario: 'text', backend: 'codex' })
  }
}

async function revokeDuringStream(ctx) {
  const { db, control, core, stack } = ctx
  const turn = await ctx.issued('openai-chatgpt')
  let stream
  try {
    await control('scenario', { scenario: 'delayed', backend: 'codex', delayMs: 3000 })
    stream = await beginStream(ctx, turn)
    const call = await eventually(() =>
      db.llmCall.findFirst({ where: { key: { taskId: turn.ref.taskId }, state: 'open' } }),
    )
    await core.call('revoke', { ref: turn.ref })
    const refused = await fetch(`http://127.0.0.1:${stack.llmPort}/codex/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${turn.values.llmApiKey}`,
        'content-type': 'application/json',
        'user-agent': 'codex_exec/0.158.0',
      },
      body: JSON.stringify({
        model: 'gpt-6-sol',
        input: 'Synthetic revoked follow-up.',
        stream: true,
        store: false,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(refused.status, 401)
    await refused.arrayBuffer()
    const terminal = await stream.finished
    assert.equal(terminal.interrupted, false)
    assert.ok(terminal.text.includes('response.completed'))
    const closed = await eventually(async () => {
      const record = await db.llmCall.findUniqueOrThrow({
        where: { id: call.id },
        include: { tokenUsage: true, key: true },
      })
      return record.state === 'completed' && record.tokenUsage && record.key.usageClosedAt
        ? record
        : false
    })
    assert.equal(closed.tokenUsage.estimated, false)
    assert.ok(closed.key.revokedAt)
    assert.equal(await db.llmCall.count({ where: { keyId: closed.keyId, state: 'open' } }), 0)
    ctx.passed(
      'turn revoked mid-stream: admitted stream finishes, next request401, key accounting closes',
    )
  } finally {
    stream?.abort()
    await core.call('revoke', { ref: turn.ref })
    await control('scenario', { scenario: 'text', backend: 'codex' })
  }
}

export async function verifyCrashes(ctx) {
  const { db, stack, env, codex, control, writer, llmSecrets, locks, passed } = ctx
  const accountId = codex.accountId
  const path = `subs/openai-chatgpt/${accountId}`
  const workerEnv = {
    ...env,
    VAULT_ROLE_ID: stack.roles.llm.roleId,
    VAULT_SECRET_ID: stack.roles.llm.secretId,
  }
  const workers = []
  const start = async () => {
    const worker = await startRefreshWorker(workerEnv)
    workers.push(worker)
    ;(ctx.extraLogs ??= []).push(worker.logs)
    return worker
  }
  const account = () => db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
  const count = async () => (await control('state')).counters.refresh
  const rotate = async (worker, barrier) => {
    const before = await account()
    const pending = worker.call('refresh', {
      accountId,
      observedVersion: before.credentialVersion,
      ...(barrier ? { barrier } : {}),
    })
    // SIGKILL deliberately rejects outstanding IPC; consume that result immediately.
    pending.catch(() => {})
    if (barrier) await worker.waitBarrier(barrier)
    return { before, pending }
  }
  const version = (target) =>
    eventually(async () => {
      const row = await account()
      return row.credentialVersion === target && row.refreshFinishedAt && row.health === 'ok'
        ? row
        : false
    }, 45_000)
  let vaultPaused = false
  let cleanupFailure
  try {
    await ctx.llmGetter().close()
    await control('scenario', { scenario: 'text', backend: 'codex' })
    const a = await start(),
      b = await start()
    const baseline = await count()
    const first = await rotate(a, 'before_http')
    assert.ok((await account()).refreshStartedAt)
    const blocked = await b.call('refresh', {
      accountId,
      observedVersion: first.before.credentialVersion,
    })
    assert.equal(blocked.delivered, false)
    assert.equal(await count(), baseline)
    await a.call('release')
    await version(first.before.credentialVersion + 1)
    assert.equal(await count(), baseline + 1)
    await a.close()
    await b.close()
    passed('two real refresh processes: one session-lock writer and exactly one OAuth call')

    const c = await start()
    const beforeAmbiguous = await count()
    const unfinished = await rotate(c, 'before_http')
    await c.kill()
    const d = await start()
    await eventually(async () => {
      await d.call('refresh', { accountId, observedVersion: unfinished.before.credentialVersion })
      return (await account()).healthReason === 'refresh_ambiguous'
    })
    assert.equal((await account()).health, 'needs_relogin')
    assert.equal(await count(), beforeAmbiguous)
    await d.close()
    passed('SIGKILL after refresh_started_at: fresh process records ambiguity without replay')

    const fresh = await control('tokens', {})
    const login = new SubscriptionLogin({
      prisma: db,
      writer,
      locks,
      backends: [codexBackend, kimiCodeBackend],
    })
    await login.relogin({ accountId, backend: codexBackend.id, credential: fresh.credential })
    const e = await start()
    const beforeRepair = await count()
    const written = await rotate(e, 'after_vault')
    assert.equal((await account()).credentialVersion, written.before.credentialVersion)
    const stored = await llmSecrets.kvRead(path)
    assert.equal(stored.version, written.before.credentialVersion + 1)
    await e.kill()
    const f = await start()
    await eventually(async () => {
      await f.call('refresh', { accountId, observedVersion: written.before.credentialVersion })
      return (await account()).credentialVersion === stored.version
    })
    const repaired = await version(stored.version)
    assert.equal(repaired.healthReason, null)
    assert.equal(await count(), beforeRepair + 1)
    assert.equal((await control('state')).revoked, false)
    await f.close()
    passed('SIGKILL after Vault CAS: fresh process repairs SQL without a second OAuth call')

    const g = await start()
    const beforeOutage = await count()
    const held = await rotate(g, 'before_vault')
    vaultPaused = true
    await stack.compose(['pause', 'vault'])
    await g.call('advance', { milliseconds: 121_000 })
    await g.call('release')
    await eventually(async () => (await account()).healthReason === 'vault_write_pending', 45_000)
    assert.equal(await count(), beforeOutage + 1)
    await stack.compose(['unpause', 'vault'], { cleanup: true })
    vaultPaused = false
    await version(held.before.credentialVersion + 1)
    assert.equal((await account()).healthReason, null)
    assert.equal(await count(), beforeOutage + 1)
    await g.close()
    passed(
      'real OpenBao outage after OAuth200: vault_write_pending then CAS recovery (injected +121s clock)',
    )
  } finally {
    const failures = []
    if (vaultPaused) {
      try {
        await stack.compose(['unpause', 'vault'], { cleanup: true })
      } catch (error) {
        failures.push(error)
      }
    }
    for (const result of await Promise.allSettled(
      workers.reverse().map((worker) => worker.close()),
    ))
      if (result.status === 'rejected') failures.push(result.reason)
    try {
      await ctx.restartLlm()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length)
      cleanupFailure = new AggregateError(failures, 'Synthetic crash worker cleanup failed')
  }
  if (cleanupFailure) throw cleanupFailure
  await lostCall(ctx, 12, 'llm')
  await lostCall(ctx, 31, 'core')
  await clientAborts(ctx)
  await revokeDuringStream(ctx)
  await databaseOutage(ctx)
}
