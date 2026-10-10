/* global AbortSignal, fetch */
// Real B13 gateway traffic against the owned PostgreSQL/OpenBao and synthetic provider stack.
// Time-dependent fixture resets below are explicit; no production clock or backend is replaced.
// The scenarios of the platform run once, on the group they are given (its ids and forms are
// data: verify-llm-zai-forms.mjs); what belongs to OAuth and to Codex stays below them until
// both are removed.
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { codexBackend, kimiCodeBackend, llmBackends } from '@repo/llm-backends'

import { eventually } from '../../../infra/dev/llm-verify/stack.mjs'
import { SubscriptionRetirement } from '../src/subscriptions/retire.ts'

/** The code of a refusal of the gateway, when the answer of a request is one. */
async function answerOf(response) {
  const text = await response.text()
  let code = null
  try {
    code = JSON.parse(text).error?.code ?? null
  } catch {
    /* A stream, or the plain text of sandbox-gw. */
  }
  return { status: response.status, code }
}

export async function verifyLifecycle(group) {
  const { db, passed, ids, answers } = group
  const request = async (turn) =>
    answerOf(await group.roleRequest(turn, { signal: AbortSignal.timeout(25_000) }))
  const notRemoved = async () => {
    const row = await group.account()
    assert.equal(row.enabled, true)
    assert.equal(row.status, 'active')
    assert.equal(row.health, 'ok')
    assert.equal(row.retireRequestedAt, null)
  }
  const usageOf = (turn) => db.tokenUsage.findMany({ where: { taskId: turn.ref.taskId } })

  await group.restartRole()
  await group.provider(answers.text())
  const priced = await group.issued()
  assert.equal((await request(priced)).status, 200)
  await group.settled(priced, 1)
  const [cost] = await usageOf(priced)
  assert.partialDeepStrictEqual(cost, { ...group.usage, estimated: false, billable: true })
  assert.equal(cost.costRub.toFixed(10), group.answerCostRub)
  await group.revoke(priced)
  passed('accounting divides per-million rates once: a call costs its provider usage at the rates')

  await group.provider(answers.shortLived)
  const transient = await group.issued()
  assert.deepEqual(await request(transient), { status: 503, code: 'raditi_transient' })
  await group.settled(transient, 1)
  const reached = await group.providerRequests()
  assert.deepEqual(await request(transient), { status: 503, code: 'raditi_transient' })
  assert.equal(await group.providerRequests(), reached)
  assert.equal((await group.calls(transient)).length, 1)
  await notRemoved()
  await group.revoke(transient)
  await group.provider(answers.text())
  await group.restartRole()
  passed(
    'a short-lived refusal pauses provider requests without changing the durable account state',
  )

  // The key first: the probe of an issue must still find the account in order.
  const risk = await group.issued()
  await group.provider(answers.accountRisk)
  await group.quota(answers.accountRiskConfirmed)
  assert.equal((await request(risk)).code, 'raditi_account')
  await group.settled(risk, 1)
  await eventually(async () => (await group.account()).healthReason === 'risk_confirmed')
  assert.equal((await group.account()).health, 'suspended')
  await group.revoke(risk)
  await group.provider(answers.text())
  await group.quota(answers.accountHealthy)
  await db.subscriptionAccount.update({
    where: { id: group.accountId },
    data: { health: 'ok', healthReason: null },
  })
  await group.restartRole()
  passed(
    'an account-risk refusal suspends the account only after the separate quota probe confirms it',
  )

  await group.provider(answers.paymentRequired)
  for (let index = 0; index < 3; index++) {
    // 402s inside one pause window are one payment check (5/15/45 min). Age the earlier
    // 402 calls of this owned fixture past their pause so each request is a separate check.
    await db.$executeRaw`UPDATE llm_calls SET started_at = started_at - interval '20 minutes', finished_at = finished_at - interval '20 minutes' WHERE subscription_account_id = ${group.accountId}::uuid AND upstream_status = 402`
    const payment = await group.issued()
    assert.deepEqual(await request(payment), { status: 503, code: 'raditi_transient' })
    await group.settled(payment, 1)
    await group.revoke(payment)
    if (index < 2) await group.restartRole()
  }
  await eventually(async () => (await group.account()).healthReason === 'payment_pending')
  assert.equal((await group.account()).health, 'suspended')
  await group.provider(answers.text())
  // Recovery is operator-owned; reset this synthetic fixture rather than claim automatic recovery.
  await db.subscriptionAccount.update({
    where: { id: group.accountId },
    data: { health: 'ok', healthReason: null },
  })
  await group.restartRole()
  passed('three 402s survive llm restarts and suspend the account with payment_pending')

  const model = await db.llmModel.findFirstOrThrow({
    where: { provider: { slug: ids.backend }, slug: ids.profile },
  })
  // The rates below are chosen for the reserve of this profile: 32 000 output tokens a call.
  assert.equal(model.reserveOutputTokens, 32_000)
  const price = (outputPer1m) =>
    db.llmModelPrice.create({
      data: {
        modelId: model.id,
        effectiveFrom: new Date(),
        ...group.rates,
        outputPer1m,
        sourceUrl: 'https://synthetic.invalid/b13-budget-rates',
      },
    })
  await price(group.rates.outputPer1m)
  const smallBudget = await group.issued({ budgetRub: '30.00' })
  // One call now reserves 3 200 ₽.
  await price('100000')
  await group.provider(answers.text())
  const callsBeforeBudget = await group.providerRequests()
  assert.equal((await request(smallBudget)).code, 'raditi_budget')
  assert.equal(await group.providerRequests(), callsBeforeBudget)
  assert.equal((await group.calls(smallBudget)).length, 0)
  assert.equal((await group.keyRow(smallBudget)).lastRefusal, 'budget')
  await group.revoke(smallBudget)
  passed('a 30-ruble key refuses an oversized reserve before any provider request')

  // A reserve of 96 ₽: one call fits the key of 135 ₽, a second beside it does not.
  await price('3000')
  const lowActual = await group.issued()
  await group.provider(answers.held(1000))
  const lowActualStart = await group.providerRequests()
  const firstLow = request(lowActual)
  await eventually(async () => (await group.calls(lowActual)).some((call) => call.state === 'open'))
  assert.equal((await request(lowActual)).code, 'raditi_budget')
  assert.equal((await firstLow).status, 200)
  const lowCalls = await group.settled(lowActual, 1)
  assert.equal(lowCalls.length, 1)
  const lowUsage = await db.tokenUsage.findUniqueOrThrow({
    where: { gatewayCallId: lowCalls[0].id },
  })
  const lowKey = await group.keyRow(lowActual)
  assert.equal(lowKey.lastRefusal, 'budget')
  assert.ok(lowUsage.costRub.plus(lowCalls[0].reservedRub).lt(lowKey.budgetRub))
  await sleep(200)
  assert.equal((await group.providerRequests()) - lowActualStart, 1)
  assert.equal((await group.calls(lowActual)).length, 1)
  await group.revoke(lowActual)
  passed(
    'a final budget refusal remains recorded after the pending call costs less than its reserve; no retry starts automatically',
  )

  // A reserve of 64 ₽: two calls fit the key together, and each then costs more than it
  // reserved — the provider counts 40 000 output tokens.
  await price('2000')
  const budget = await group.issued()
  await group.provider(
    answers.held(700, { input: 100, cacheRead: 20, output: 40_000, reasoning: 3 }),
  )
  assert.deepEqual(
    (await Promise.all([request(budget), request(budget)])).map(statusOf),
    [200, 200],
  )
  const budgetCalls = await group.settled(budget, 2)
  assert.equal(budgetCalls.length, 2)
  assert.ok(
    budgetCalls[0].reservedRub
      .plus(budgetCalls[1].reservedRub)
      .lte((await group.keyRow(budget)).budgetRub),
  )
  const overshoots = await usageOf(budget)
  assert.equal(overshoots.length, 2)
  for (const call of budgetCalls) {
    const usage = overshoots.find((entry) => entry.gatewayCallId === call.id)
    assert.equal(usage.estimated, false)
    assert.ok(usage.costRub.gt(call.reservedRub))
    // (80 × 10 + 20 × 1 + 40 000 × 2 000) / 1 000 000: input, cached input, output.
    assert.equal(usage.costRub.toFixed(10), '80.0008200000')
  }
  assert.ok(
    overshoots[0].costRub.plus(overshoots[1].costRub).gt((await group.keyRow(budget)).budgetRub),
  )
  assert.equal((await request(budget)).code, 'raditi_budget')
  assert.equal((await group.keyRow(budget)).lastRefusal, 'budget')
  assert.equal((await group.calls(budget)).length, 2)
  await group.revoke(budget)
  await price(group.rates.outputPer1m)
  await group.provider(answers.text())
  passed(
    'two admitted parallel calls both exceed their reserves; the exact combined cost closes later admission',
  )
}
const statusOf = (answer) => answer.status

/**
 * A compromised account, on an account of the group imported for it: admission stops at once,
 * the issued key dies with it, and the secret is destroyed only after the operator says the key
 * was revoked at the provider.
 */
export async function verifyEmergencyRetirement(group) {
  const { db, core, passed, ids } = group
  const accountId = await group.importAccount('synthetic-emergency')
  const account = () => db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
  const retirement = new SubscriptionRetirement({
    prisma: db,
    locks: group.locks,
    backends: llmBackends,
    secrets: group.admin,
    credentials: { revoke: (ref) => core.call('revoke', { ref }) },
  })
  const emergency = await group.issued()
  assert.equal((await group.keyRow(emergency)).subscriptionAccountId, accountId)
  await retirement.request({ accountId, compromised: true })
  assert.equal((await account()).enabled, false)
  assert.equal(await core.call('recover', { ref: emergency.ref }), null)
  const refused = await group.roleRequest(emergency, { signal: AbortSignal.timeout(25_000) })
  assert.equal(refused.status, 401)
  await refused.arrayBuffer()
  const revoked = await group.keyRow(emergency)
  assert.ok(revoked.revokeRequestedAt && revoked.revokedAt)
  assert.equal((await retirement.finalize({ accountId })).stage, 'console_revocation_required')
  assert.equal((await retirement.finalize({ accountId, consoleRevoked: true })).stage, 'retired')
  assert.equal(await group.llmSecrets.kvRead(`subs/${ids.backend}/${accountId}`), null)
  passed(
    'emergency retirement disables admission, revokes durable turn keys and requires the operator acknowledgement before destruction',
  )
}

/**
 * What belongs to OAuth and to Codex alone, on the old accounts: one rotation for concurrent
 * 401s, the credit balance of a response, and a retirement that revokes the tokens at the
 * provider by itself. Removed with them (G8).
 */
export async function verifyOauthLifecycle(ctx) {
  const { db, core, stack, codex, control, task, issued, passed, llmSecrets, admin, locks } = ctx
  const { restartLlm } = ctx
  const origin = `http://127.0.0.1:${stack.llmPort}`
  const account = () => db.subscriptionAccount.findUniqueOrThrow({ where: { id: codex.accountId } })
  const scenario = (value) => control('scenario', { backend: 'codex', scenario: value })
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
  const request = async (turn) => {
    const response = await fetch(`${origin}/codex/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${turn.values.llmApiKey}`,
        'content-type': 'application/json',
        'user-agent': 'codex_exec/0.158.0',
      },
      body: JSON.stringify({
        model: 'gpt-6-sol',
        input: 'Synthetic lifecycle verification.',
        stream: true,
        store: false,
      }),
      signal: AbortSignal.timeout(25_000),
    })
    await response.text()
    return response.status
  }
  const notRemoved = async () => {
    const row = await account()
    assert.equal(row.enabled, true)
    assert.equal(row.status, 'active')
    assert.equal(row.health, 'ok')
    assert.equal(row.retireRequestedAt, null)
  }

  assert.equal(typeof restartLlm, 'function', 'The lifecycle check requires a real llm restart')
  await restartLlm()
  await scenario('auth_once')
  const rotation = await issued('openai-chatgpt')
  const beforeRefresh = (await control('state')).counters.refresh
  const beforeVersion = (await account()).credentialVersion
  assert.deepEqual(await Promise.all([request(rotation), request(rotation)]), [200, 200])
  await settled(rotation, 2)
  const rotated = await account()
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

  await scenario('credits')
  const credits = await issued('openai-chatgpt')
  assert.equal(await request(credits), 200)
  await settled(credits, 1)
  await eventually(async () => (await account()).healthReason === 'credits_balance')
  await notRemoved()
  await revoke(credits)
  await scenario('text')
  passed('a positive credit balance records a warning without disabling the subscription')

  const retirement = new SubscriptionRetirement({
    prisma: db,
    locks,
    backends: [codexBackend, kimiCodeBackend],
    secrets: admin,
    credentials: { revoke: (ref) => core.call('revoke', { ref }) },
  })
  const ordinary = await issued('openai-chatgpt')
  assert.equal((await retirement.request({ accountId: codex.accountId })).stage, 'draining')
  // Refused by the retirement itself: an account that only held its turn would answer BUSY.
  const forbidden = await task('openai-chatgpt')
  await assert.rejects(
    core.call('issue', { ref: forbidden.ref, grant: forbidden.grant }),
    (error) => error.code === 'SUBSCRIPTION_WAIT',
  )
  assert.equal(await request(ordinary), 200)
  await settled(ordinary, 1)
  await revoke(ordinary)
  await core.call('sweep')
  assert.equal((await account()).enabled, false)
  await eventually(async () => (await account()).credentialsRevokedAt !== null, 80_000)
  assert.equal((await retirement.finalize({ accountId: codex.accountId })).stage, 'retired')
  assert.equal(await llmSecrets.kvRead(`subs/openai-chatgpt/${codex.accountId}`), null)
  assert.ok((await control('state')).counters.revoke >= 1)
  passed(
    'retirement of an OAuth account drains its issued turn, revokes the tokens at the provider by itself and destroys all versions',
  )
}
