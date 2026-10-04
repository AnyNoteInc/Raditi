// Real pinned Codex and Kimi CLIs, started from their drivers' prepared runs (the production
// retry settings), against provider failures that arrive inside an already started stream (HTTP
// 200, then a failure event). Codex decides whether to reconnect by `error.code` alone; Kimi
// retries every error object and ends the turn only on a filtered choice. Every final refusal
// must therefore reach the CLI in a shape it ends the turn on: each retry would be another
// provider request from the same account.
import assert from 'node:assert/strict'

import { SYNTHETIC_ERROR_MARKER } from '../../../infra/dev/llm-verify/fake-subscriptions.mjs'
import { eventually } from '../../../infra/dev/llm-verify/stack.mjs'

const providerPath = '/backend-api/codex/responses'
const kimiPath = '/coding/v1/chat/completions'
// [provider code inside the stream, llm_keys.last_refusal the core reads]
const finalFailures = [
  ['cyber_policy', 'policy_flagged'],
  ['usage_limit_reached', 'subscription_limit'],
  ['insufficient_quota', 'account'],
  // The provider rejected this request; the model profile is not at fault.
  ['context_length_exceeded', 'request_rejected'],
]
// [the fake's name of a Kimi error-reference text, llm_keys.last_refusal]
const kimiFinalFailures = [
  ['high_risk', 'policy_flagged'],
  ['model_access', 'profile'],
  ['quota_5h', 'subscription_limit'],
]

export async function verifyStreamFailures(ctx) {
  const { db, core, control, issued, passed, codex, kimi, secretMarkers, runDriver } = ctx
  const countRequests = async (path = providerPath) =>
    (await control('state')).requests.filter((request) => request.path === path).length
  const account = (id = codex.accountId) =>
    db.subscriptionAccount.findUniqueOrThrow({ where: { id } })
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
  const settled = (turn, expected) =>
    eventually(async () => {
      const rows = await db.llmCall.findMany({ where: { key: { taskId: turn.ref.taskId } } })
      return rows.length === expected && rows.every((row) => row.state !== 'open') ? rows : null
    })
  // Restores only this owned fixture: a synthetic exhausted window must not outlive its check.
  const restore = async () => {
    await control('scenario', { backend: 'codex', scenario: 'text' })
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
  }
  const withTurn = async (action) => {
    const turn = await issued('openai-chatgpt')
    secretMarkers?.add(turn.values.llmApiKey)
    secretMarkers?.add(turn.values.mcpToken)
    try {
      return await action(turn)
    } finally {
      await core.call('revoke', { ref: turn.ref })
      await restore()
    }
  }

  for (const [failure, refusal] of finalFailures) {
    await withTurn(async (turn) => {
      await control('scenario', { backend: 'codex', scenario: 'stream_failed', failure })
      const before = await countRequests()
      const result = await runDriver({
        driver: 'codex',
        turn,
        prompt: 'Synthetic in-stream final refusal.',
        timeoutMs: 60_000,
      })
      assert.notEqual(result.code, 0, `In-stream ${failure} must end the CLI turn`)
      assert.equal(result.timedOut, false, `In-stream ${failure} must finish without a timeout`)
      assert.equal(
        (await countRequests()) - before,
        1,
        `In-stream ${failure} must not be retried by the CLI`,
      )
      const rows = await settled(turn, 1)
      assert.equal(rows[0].state, 'failed')
      const row = await keyRow(turn)
      assert.equal(row.lastRefusal, refusal)
      assert.ok(row.lastRefusalAt instanceof Date)
      const output = `${result.stdout}\n${result.stderr}`
      assert.equal(
        output.includes(SYNTHETIC_ERROR_MARKER) || output.includes('Synthetic stream failure'),
        false,
        'Provider failure text reached the sandbox',
      )
      const pool = await account()
      assert.equal(pool.health, 'ok', `In-stream ${failure} must not remove the account`)
      if (refusal === 'subscription_limit') assert.ok(pool.coolingUntil > new Date())
      else assert.equal(pool.coolingUntil, null)
    })
    passed(`real codex ends the turn after one provider request on in-stream ${failure}`)
  }

  // A short-lived in-stream failure stays retryable: the CLI reconnects, waits out the
  // gateway's account pause and completes the turn with exactly one more provider request.
  await withTurn(async (turn) => {
    await control('scenario', {
      backend: 'codex',
      scenario: 'stream_failed',
      failure: 'rate_limit_exceeded',
      failures: 1,
    })
    const before = await countRequests()
    const result = await runDriver({
      driver: 'codex',
      turn,
      prompt: 'Synthetic in-stream transient failure.',
      timeoutMs: 120_000,
    })
    assert.equal(result.code, 0, 'Codex did not recover from a transient in-stream failure')
    assert.equal(
      (await countRequests()) - before,
      2,
      'A transient in-stream failure must cost exactly one more provider request',
    )
    const rows = await settled(turn, 2)
    assert.deepEqual(rows.map((row) => row.state).sort(), ['completed', 'failed'])
    assert.equal((await keyRow(turn)).lastRefusal, 'transient')
    assert.equal((await account()).health, 'ok')
  })
  passed('real codex reconnects after a transient in-stream failure and finishes the turn')

  // Kimi: the same proof for its CLI. Kimi windows come only from the probe, so the fixture's
  // pool state is put back exactly as it was after each check.
  const kimiPool = await account(kimi.accountId)
  const withKimiTurn = async (action) => {
    const turn = await issued('kimi-code')
    secretMarkers?.add(turn.values.llmApiKey)
    secretMarkers?.add(turn.values.mcpToken)
    try {
      return await action(turn)
    } finally {
      await core.call('revoke', { ref: turn.ref })
      await control('scenario', { backend: 'kimi', scenario: 'text' })
      await db.subscriptionAccount.update({
        where: { id: kimi.accountId },
        data: {
          coolingUntil: kimiPool.coolingUntil,
          headroomPct: kimiPool.headroomPct,
          limitsSeenAt: kimiPool.limitsSeenAt,
          limitWindows: kimiPool.limitWindows,
        },
      })
    }
  }
  for (const [failure, refusal] of kimiFinalFailures) {
    await withKimiTurn(async (turn) => {
      await control('scenario', { backend: 'kimi', scenario: 'stream_failed', failure })
      const before = await countRequests(kimiPath)
      const result = await runDriver({
        driver: 'kimi',
        turn,
        prompt: 'Synthetic in-stream final refusal.',
        timeoutMs: 60_000,
      })
      assert.notEqual(result.code, 0, `Kimi in-stream ${failure} must end the CLI turn`)
      assert.equal(
        result.timedOut,
        false,
        `Kimi in-stream ${failure} must finish without a timeout`,
      )
      assert.equal(
        (await countRequests(kimiPath)) - before,
        1,
        `Kimi in-stream ${failure} must not be retried by the CLI`,
      )
      const rows = await settled(turn, 1)
      assert.equal(rows[0].state, 'failed')
      assert.equal((await keyRow(turn)).lastRefusal, refusal)
      const output = `${result.stdout}\n${result.stderr}`
      assert.equal(
        output.includes(SYNTHETIC_ERROR_MARKER),
        false,
        'Provider text reached the sandbox',
      )
      assert.equal((await account(kimi.accountId)).health, 'ok')
      // The window refusal names no reset: the pool cools the account after its probe.
      if (refusal === 'subscription_limit')
        await eventually(async () => (await account(kimi.accountId)).coolingUntil > new Date())
    })
    passed(`real kimi ends the turn after one provider request on in-stream ${failure}`)
  }

  await withKimiTurn(async (turn) => {
    await control('scenario', {
      backend: 'kimi',
      scenario: 'stream_failed',
      failure: 'overloaded',
      failures: 1,
    })
    const before = await countRequests(kimiPath)
    const result = await runDriver({
      driver: 'kimi',
      turn,
      prompt: 'Synthetic in-stream transient failure.',
      timeoutMs: 180_000,
    })
    assert.equal(result.code, 0, 'Kimi did not recover from a transient in-stream failure')
    assert.equal(
      (await countRequests(kimiPath)) - before,
      2,
      'A transient Kimi in-stream failure must cost exactly one more provider request',
    )
    const rows = await settled(turn, 2)
    assert.deepEqual(rows.map((row) => row.state).sort(), ['completed', 'failed'])
    assert.equal((await account(kimi.accountId)).health, 'ok')
  })
  passed('real kimi retries a transient in-stream failure and finishes the turn')
}
