/* global AbortController, AbortSignal, fetch, TextDecoder */
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { eventually } from '../../../infra/dev/llm-verify/stack.mjs'

/** Advance the age of an owned synthetic row, then execute unchanged production collectors. */
async function lostCall(group, minutes, collector) {
  const { db, core, stack } = group
  const turn = await group.issued()
  let stream
  try {
    await group.provider(group.answers.held(60_000))
    stream = await beginStream(group, turn)
    const call = await eventually(() =>
      db.llmCall.findFirst({ where: { key: { taskId: turn.ref.taskId }, state: 'open' } }),
    )
    const worker = group.roleGetter()
    worker.child.kill('SIGKILL')
    await worker.exited
    // The role died in the middle of the answer: its end never reached the client.
    assert.equal((await stream.finished).text.trimEnd().endsWith(group.streamEnd), false)
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
    } else await group.restartRole()
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
    if (collector === 'core') await group.restartRole()
    await eventually(
      async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
    )
    group.passed(
      `SIGKILL mid-stream: ${collector} collector closes lost/nonbillable (synthetic age ${minutes}m)`,
    )
  } finally {
    stream?.abort()
    await group.revoke(turn)
    await group.provider(group.answers.text())
  }
}

/** A generation straight at the role, read up to its first bytes: the call is open from here. */
async function beginStream(group, turn) {
  const controller = new AbortController()
  const response = await group.roleRequest(turn, {
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

async function databaseOutage(group) {
  const { db, stack } = group
  const turn = await group.issued()
  let stream,
    paused = false
  try {
    await group.provider(group.answers.held(3000))
    stream = await beginStream(group, turn)
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
    assert.ok(completed.text.trimEnd().endsWith(group.streamEnd))
    const usage = await eventually(
      () => db.tokenUsage.findUnique({ where: { gatewayCallId: call.id } }),
      60_000,
    )
    assert.partialDeepStrictEqual(usage, { ...group.usage, estimated: false, billable: true })
    assert.equal(
      (await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).state,
      'completed',
    )
    assert.equal(await db.tokenUsage.count({ where: { gatewayCallId: call.id } }), 1)
    await eventually(
      async () => (await fetch(`http://127.0.0.1:${stack.llmPort}/health`)).status === 200,
    )
    group.passed(
      'PostgreSQL paused for 30s at stream completion: exact provider usage persisted once',
    )
  } finally {
    if (paused) await stack.compose(['unpause', 'postgres'], { cleanup: true })
    stream?.abort()
    await group.revoke(turn)
    await group.provider(group.answers.text())
  }
}

async function clientAborts(group) {
  const { db } = group
  const turn = await group.issued()
  const before = await group.account()
  assert.equal(before.breakerOpenUntil, null)
  try {
    for (let index = 0; index < 3; index++) {
      await group.provider(group.answers.held(60_000))
      const stream = await beginStream(group, turn)
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
    const after = await group.account()
    assert.equal(after.breakerOpenUntil, null)
    assert.equal(after.usageMissingStreak, before.usageMissingStreak)
    assert.equal(after.health, 'ok')
    group.passed(
      'three client aborts: estimated aborted accounting without opening the usage breaker',
    )
  } finally {
    await group.revoke(turn)
    await group.provider(group.answers.text())
  }
}

async function revokeDuringStream(group) {
  const { db } = group
  const turn = await group.issued()
  let stream
  try {
    await group.provider(group.answers.held(3000))
    stream = await beginStream(group, turn)
    const call = await eventually(() =>
      db.llmCall.findFirst({ where: { key: { taskId: turn.ref.taskId }, state: 'open' } }),
    )
    await group.revoke(turn)
    const refused = await group.roleRequest(turn, { signal: AbortSignal.timeout(10_000) })
    assert.equal(refused.status, 401)
    await refused.arrayBuffer()
    const terminal = await stream.finished
    assert.equal(terminal.interrupted, false)
    assert.ok(terminal.text.trimEnd().endsWith(group.streamEnd))
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
    group.passed(
      'turn revoked mid-stream: admitted stream finishes, next request401, key accounting closes',
    )
  } finally {
    stream?.abort()
    await group.revoke(turn)
    await group.provider(group.answers.text())
  }
}

/**
 * The crash barriers of the platform, on the group they are given: a role killed in the middle
 * of a stream, a client that goes away, a key revoked while its stream runs, a database that
 * stops answering when a stream ends.
 */
export async function verifyCrashes(group) {
  await group.restartRole()
  await lostCall(group, 12, 'llm')
  await lostCall(group, 31, 'core')
  await clientAborts(group)
  await revokeDuringStream(group)
  await databaseOutage(group)
}
