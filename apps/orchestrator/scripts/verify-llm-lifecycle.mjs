/* global AbortSignal, fetch */
// Real B13 gateway traffic against the owned PostgreSQL/OpenBao and synthetic provider stack.
// Time-dependent fixture resets below are explicit; no production clock or backend is replaced.
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { codexBackend, kimiCodeBackend } from '@repo/llm-backends'

import { eventually } from '../../../infra/dev/llm-verify/stack.mjs'
import { SubscriptionRetirement } from '../src/subscriptions/retire.ts'

const backends = [codexBackend, kimiCodeBackend]
const codeFor = (backend) => (backend === 'openai-chatgpt' ? 'codex' : 'kimi')

export async function verifyLifecycle(ctx) {
  const {
    db,
    core,
    stack,
    codex,
    kimi,
    control,
    task,
    issued,
    passed,
    llmSecrets,
    admin,
    locks,
    restartLlm,
  } = ctx
  const origin = `http://127.0.0.1:${stack.llmPort}`
  const accounts = { 'openai-chatgpt': codex.accountId, 'kimi-code': kimi.accountId }
  const account = (backend) =>
    db.subscriptionAccount.findUniqueOrThrow({ where: { id: accounts[backend] } })
  const scenario = (backend, value, options = {}) =>
    control('scenario', { backend: codeFor(backend), scenario: value, ...options })
  const keyRow = (turn) =>
    db.llmKey.findUniqueOrThrow({
      where: {
        taskId_turnNo_firstEpoch: {
          taskId: turn.ref.taskId,
          turnNo: turn.ref.turn,
          firstEpoch: turn.ref.epoch,
        },
      },
    })
  const callRows = (turn) =>
    db.llmCall.findMany({
      where: { key: { taskId: turn.ref.taskId } },
      orderBy: { startedAt: 'asc' },
    })
  const settled = async (turn, count) =>
    eventually(async () => {
      const rows = await callRows(turn)
      return rows.length >= count && rows.every((row) => row.state !== 'open') ? rows : null
    })
  const revoke = (turn) => core.call('revoke', { ref: turn.ref })
  const request = async (backend, turn) => {
    const codex = backend === 'openai-chatgpt'
    const response = await fetch(
      `${origin}${codex ? '/codex/responses' : '/kimi/v1/chat/completions'}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${turn.values.llmApiKey}`,
          'content-type': 'application/json',
          'user-agent': codex ? 'codex_exec/0.158.0' : 'kimi-code-cli/2.1.1',
        },
        body: JSON.stringify(
          codex
            ? {
                model: 'gpt-6-sol',
                input: 'Synthetic lifecycle verification.',
                stream: true,
                store: false,
              }
            : {
                model: 'k3-256k',
                messages: [{ role: 'user', content: 'Synthetic lifecycle verification.' }],
                stream: true,
              },
        ),
        signal: AbortSignal.timeout(25_000),
      },
    )
    await response.text()
    return response.status
  }
  const notRemoved = async (backend) => {
    const row = await account(backend)
    assert.equal(row.enabled, true)
    assert.equal(row.status, 'active')
    assert.equal(row.health, 'ok')
    assert.equal(row.retireRequestedAt, null)
  }

  assert.equal(typeof restartLlm, 'function', 'The lifecycle check requires a real llm restart')
  await restartLlm()
  await scenario('openai-chatgpt', 'auth_once')
  const rotation = await issued('openai-chatgpt')
  const beforeRefresh = (await control('state')).counters.refresh
  const beforeVersion = (await account('openai-chatgpt')).credentialVersion
  assert.deepEqual(
    await Promise.all([request('openai-chatgpt', rotation), request('openai-chatgpt', rotation)]),
    [200, 200],
  )
  await settled(rotation, 2)
  const rotated = await account('openai-chatgpt')
  assert.equal((await control('state')).counters.refresh - beforeRefresh, 1)
  assert.equal(rotated.credentialVersion, beforeVersion + 1)
  const stored = await llmSecrets.kvRead(`subs/openai-chatgpt/${codex.accountId}`)
  assert.equal(stored.version, rotated.credentialVersion)
  const rotationUsage = await db.tokenUsage.count({ where: { taskId: rotation.ref.taskId } })
  assert.equal(rotationUsage, 2)
  const pricedRotation = await db.tokenUsage.findMany({ where: { taskId: rotation.ref.taskId } })
  assert.ok(pricedRotation.every((usage) => usage.costRub.toFixed(10) === '0.0013600000'))
  await revoke(rotation)
  passed(
    'concurrent 401s share one OAuth rotation and CAS; accounting divides per-million rates once',
  )

  for (const [backend, mode, status] of [
    ['kimi-code', 'profile401', 400],
    ['kimi-code', 'html403', 429],
    ['kimi-code', 'content_risk', 400],
    ['openai-chatgpt', 'content_risk', 400],
  ]) {
    await scenario(backend, mode)
    const beforeLimits = (await account(backend)).limitsSeenAt
    const turn = await issued(backend)
    assert.equal(await request(backend, turn), status, 'Unexpected scrubbed content refusal')
    await settled(turn, 1)
    if (mode === 'html403')
      await eventually(async () => (await account(backend)).limitsSeenAt > beforeLimits)
    await notRemoved(backend)
    await revoke(turn)
  }
  passed(
    'Kimi profile/content refusals, HTML 403 with healthy probe and Codex cyber policy keep the pool account',
  )

  await scenario('openai-chatgpt', 'transient503')
  const transient = await issued('openai-chatgpt')
  assert.equal(await request('openai-chatgpt', transient), 503)
  await settled(transient, 1)
  const transientCount = (await control('state')).counters.codex
  assert.equal(await request('openai-chatgpt', transient), 503)
  assert.equal((await control('state')).counters.codex, transientCount)
  assert.equal((await callRows(transient)).length, 1)
  await notRemoved('openai-chatgpt')
  await revoke(transient)
  await scenario('openai-chatgpt', 'text')
  await restartLlm()
  passed('a transient 503 pauses provider requests without changing the durable account state')

  await scenario('kimi-code', 'concurrent403')
  const risk = await issued('kimi-code')
  assert.equal(await request('kimi-code', risk), 429)
  await settled(risk, 1)
  await eventually(async () => (await account('kimi-code')).healthReason === 'risk_confirmed')
  assert.equal((await account('kimi-code')).health, 'suspended')
  await revoke(risk)
  await scenario('kimi-code', 'text')
  await db.subscriptionAccount.update({
    where: { id: kimi.accountId },
    data: { health: 'ok', healthReason: null },
  })
  await restartLlm()
  passed(
    'a concurrent-use 403 suspends the account only after the separate usage probe confirms it',
  )

  await scenario('openai-chatgpt', 'credits')
  const credits = await issued('openai-chatgpt')
  assert.equal(await request('openai-chatgpt', credits), 200)
  await settled(credits, 1)
  await eventually(async () => (await account('openai-chatgpt')).healthReason === 'credits_balance')
  await notRemoved('openai-chatgpt')
  await revoke(credits)
  await scenario('openai-chatgpt', 'text')
  passed('a positive credit balance records a warning without disabling the subscription')

  await scenario('openai-chatgpt', 'window429')
  const cooling = await issued('openai-chatgpt')
  assert.equal(await request('openai-chatgpt', cooling), 429)
  await settled(cooling, 1)
  await eventually(async () => (await account('openai-chatgpt')).coolingUntil > new Date())
  const waiting = await task('openai-chatgpt')
  await assert.rejects(
    core.call('issue', { ref: waiting.ref, grant: waiting.grant }),
    (error) => error.code === 'SUBSCRIPTION_WAIT',
  )
  assert.equal(await request('openai-chatgpt', cooling), 429)
  assert.equal((await callRows(cooling)).length, 1)
  await revoke(cooling)
  // Advance only the owned fixture's exhausted window before the next independent scenario.
  await db.subscriptionAccount.update({
    where: { id: codex.accountId },
    data: {
      coolingUntil: null,
      headroomPct: '90',
      limitsSeenAt: new Date(),
      limitWindows: [
        { name: '5h', usedPct: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
  })
  await scenario('openai-chatgpt', 'text')
  passed('exhausted subscription windows persist cooling and refuse fresh and existing admission')

  await scenario('kimi-code', 'payment402')
  for (let index = 0; index < 3; index++) {
    // 402s inside one pause window are one payment check (5/15/45 min). Age the earlier
    // 402 calls of this owned fixture past their pause so each request is a separate check.
    await db.$executeRaw`UPDATE llm_calls SET started_at = started_at - interval '20 minutes', finished_at = finished_at - interval '20 minutes' WHERE subscription_account_id = ${kimi.accountId}::uuid AND upstream_status = 402`
    const payment = await issued('kimi-code')
    assert.equal(await request('kimi-code', payment), 503)
    await settled(payment, 1)
    await revoke(payment)
    if (index < 2) await restartLlm()
  }
  await eventually(async () => (await account('kimi-code')).healthReason === 'payment_pending')
  assert.equal((await account('kimi-code')).health, 'suspended')
  await scenario('kimi-code', 'text')
  // Recovery is operator-owned; reset this synthetic fixture rather than claim automatic recovery.
  await db.subscriptionAccount.update({
    where: { id: kimi.accountId },
    data: { health: 'ok', healthReason: null },
  })
  await restartLlm()
  passed('three 402s survive llm restarts and suspend the account with payment_pending')

  await scenario('openai-chatgpt', 'no_usage')
  const missing = await issued('openai-chatgpt')
  for (let index = 1; index <= 3; index++) {
    assert.equal(await request('openai-chatgpt', missing), 200)
    await settled(missing, index)
  }
  const broken = await account('openai-chatgpt')
  assert.equal(broken.usageMissingStreak, 3)
  assert.ok(broken.breakerOpenUntil > new Date())
  assert.equal(await request('openai-chatgpt', missing), 429)
  assert.equal((await callRows(missing)).length, 3)
  const estimated = await db.tokenUsage.findMany({ where: { taskId: missing.ref.taskId } })
  assert.equal(estimated.length, 3)
  assert.ok(estimated.every((usage) => usage.estimated && usage.estimateReason === 'no_usage'))
  // Move the fixture past the real breaker's deadline to test the single trial admission.
  await db.subscriptionAccount.update({
    where: { id: codex.accountId },
    data: { breakerOpenUntil: new Date(Date.now() - 1000) },
  })
  await scenario('openai-chatgpt', 'delayed', { delayMs: 700 })
  assert.deepEqual(
    (
      await Promise.all([request('openai-chatgpt', missing), request('openai-chatgpt', missing)])
    ).sort(),
    [200, 429],
  )
  await settled(missing, 4)
  const recovered = await account('openai-chatgpt')
  assert.equal(recovered.usageMissingStreak, 0)
  assert.equal(recovered.breakerOpenUntil, null)
  await revoke(missing)
  passed('three terminal streams without usage open the breaker; one successful trial restores it')

  const model = await db.llmModel.findFirstOrThrow({
    where: { provider: { slug: 'openai-chatgpt' }, slug: 'gpt-6-sol-standard' },
  })
  const price = async (outputPer1m) =>
    db.llmModelPrice.create({
      data: {
        modelId: model.id,
        effectiveFrom: new Date(),
        inputPer1m: '10',
        outputPer1m,
        vatRate: '0.22',
        sourceUrl: 'https://synthetic.invalid/b13-budget-rates',
      },
    })
  await price('30')
  const smallBudget = await issued('openai-chatgpt', { budgetRub: '30.00' })
  await price('100000')
  await scenario('openai-chatgpt', 'text')
  const callsBeforeBudget = (await control('state')).counters.codex
  assert.equal(await request('openai-chatgpt', smallBudget), 429)
  assert.equal((await control('state')).counters.codex, callsBeforeBudget)
  assert.equal((await callRows(smallBudget)).length, 0)
  assert.equal((await keyRow(smallBudget)).lastRefusal, 'budget')
  await revoke(smallBudget)
  passed('a 30-ruble key refuses an oversized reserve before any provider request')

  const lowActual = await issued('openai-chatgpt')
  await scenario('openai-chatgpt', 'delayed', { delayMs: 1000 })
  const lowActualStart = (await control('state')).counters.codex
  const firstLow = request('openai-chatgpt', lowActual)
  await eventually(async () => (await callRows(lowActual)).some((call) => call.state === 'open'))
  assert.equal(await request('openai-chatgpt', lowActual), 429)
  assert.equal(await firstLow, 200)
  const lowCalls = await settled(lowActual, 1)
  assert.equal(lowCalls.length, 1)
  const lowUsage = await db.tokenUsage.findUniqueOrThrow({
    where: { gatewayCallId: lowCalls[0].id },
  })
  const lowKey = await keyRow(lowActual)
  assert.equal(lowKey.lastRefusal, 'budget')
  assert.ok(lowUsage.costRub.plus(lowCalls[0].reservedRub).lt(lowKey.budgetRub))
  await sleep(200)
  assert.equal((await control('state')).counters.codex - lowActualStart, 1)
  assert.equal((await callRows(lowActual)).length, 1)
  await revoke(lowActual)
  passed(
    'a final budget refusal remains recorded after the pending call costs less than its reserve; no retry starts automatically',
  )

  await price('50000')
  const budget = await issued('openai-chatgpt')
  await scenario('openai-chatgpt', 'delayed', {
    delayMs: 700,
    usage: { input: 100, cacheRead: 20, output: 6000, reasoning: 3 },
  })
  assert.deepEqual(
    (
      await Promise.all([request('openai-chatgpt', budget), request('openai-chatgpt', budget)])
    ).sort(),
    [200, 200],
  )
  const budgetCalls = await settled(budget, 2)
  assert.equal(budgetCalls.length, 2)
  assert.ok(
    budgetCalls[0].reservedRub
      .plus(budgetCalls[1].reservedRub)
      .lte((await keyRow(budget)).budgetRub),
  )
  const overshoots = await db.tokenUsage.findMany({ where: { taskId: budget.ref.taskId } })
  assert.equal(overshoots.length, 2)
  for (const call of budgetCalls) {
    const usage = overshoots.find((entry) => entry.gatewayCallId === call.id)
    assert.equal(usage.estimated, false)
    assert.ok(usage.costRub.gt(call.reservedRub))
    assert.equal(usage.costRub.toFixed(10), '300.0010000000')
  }
  assert.ok(overshoots[0].costRub.plus(overshoots[1].costRub).gt((await keyRow(budget)).budgetRub))
  assert.equal(await request('openai-chatgpt', budget), 429)
  assert.equal((await keyRow(budget)).lastRefusal, 'budget')
  assert.equal((await callRows(budget)).length, 2)
  await revoke(budget)
  await price('30')
  await scenario('openai-chatgpt', 'text')
  passed(
    'two admitted parallel calls both exceed their reserves; the exact combined cost closes later admission',
  )

  const retirement = new SubscriptionRetirement({
    prisma: db,
    locks,
    backends,
    secrets: admin,
    credentials: { revoke: (ref) => core.call('revoke', { ref }) },
  })
  const ordinary = await issued('openai-chatgpt')
  assert.equal((await retirement.request({ accountId: codex.accountId })).stage, 'draining')
  const forbidden = await task('openai-chatgpt')
  await assert.rejects(
    core.call('issue', { ref: forbidden.ref, grant: forbidden.grant }),
    (error) => ['SUBSCRIPTION_WAIT', 'SUBSCRIPTION_BUSY'].includes(error.code),
  )
  if (ctx.cli) {
    const continuation = await ctx.cli.run({
      driver: 'codex',
      key: ordinary.values.llmApiKey,
      prompt: 'Complete the synthetic turn while its subscription drains.',
    })
    assert.equal(continuation.code, 0, 'The issued CLI turn must finish while draining')
  } else {
    assert.equal(await request('openai-chatgpt', ordinary), 200)
  }
  await settled(ordinary, 1)
  await revoke(ordinary)
  await core.call('sweep')
  assert.equal((await account('openai-chatgpt')).enabled, false)
  await eventually(
    async () => (await account('openai-chatgpt')).credentialsRevokedAt !== null,
    80_000,
  )
  assert.equal((await retirement.finalize({ accountId: codex.accountId })).stage, 'retired')
  assert.equal(await llmSecrets.kvRead(`subs/openai-chatgpt/${codex.accountId}`), null)
  assert.ok((await control('state')).counters.revoke >= 1)
  passed(
    `ordinary retirement drains an issued ${ctx.cli ? 'CLI' : 'HTTP'} turn, fences fresh keys, automatically revokes OAuth and destroys all versions`,
  )

  const emergency = await issued('kimi-code')
  await retirement.request({ accountId: kimi.accountId, compromised: true })
  assert.equal((await account('kimi-code')).enabled, false)
  assert.equal(await core.call('recover', { ref: emergency.ref }), null)
  assert.equal(await request('kimi-code', emergency), 401)
  const revoked = await keyRow(emergency)
  assert.ok(revoked.revokeRequestedAt && revoked.revokedAt)
  assert.equal(
    (await retirement.finalize({ accountId: kimi.accountId })).stage,
    'console_revocation_required',
  )
  assert.equal(
    (await retirement.finalize({ accountId: kimi.accountId, consoleRevoked: true })).stage,
    'retired',
  )
  assert.equal(await llmSecrets.kvRead(`subs/kimi-code/${kimi.accountId}`), null)
  passed(
    'emergency retirement disables admission, revokes durable turn keys and requires the operator acknowledgement before destruction',
  )
  return {
    limitations: [
      'The synthetic clock-window resets do not test elapsed 15-minute or hour-long waits.',
    ],
  }
}
