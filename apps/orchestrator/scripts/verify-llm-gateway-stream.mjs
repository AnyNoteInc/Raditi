// The real pinned CLI of the group, started from its driver's prepared run (the production retry
// settings), against provider failures that arrive inside an already started stream (HTTP 200,
// then a failure). Every final refusal must reach the CLI in a shape it ends the turn on: each
// retry would be another provider request from the same account. Which answers of the provider
// these are, and what each must leave in llm_keys.last_refusal, is data of the group.
import assert from 'node:assert/strict'

import { eventually } from '../../../infra/dev/llm-verify/stack.mjs'

export async function verifyStreamFailures(group) {
  const { db, passed, ids } = group
  // Restores only this owned fixture: a synthetic exhausted window must not outlive its check.
  const restore = async () => {
    await group.provider(group.answers.text())
    await db.subscriptionAccount.update({
      where: { id: group.accountId },
      data: { coolingUntil: null },
    })
  }
  const withTurn = async (action) => {
    const turn = await group.issued()
    try {
      return await action(turn)
    } finally {
      await group.revoke(turn)
      await restore()
    }
  }

  // The role afresh: no pause of the account and no remembered probe from an earlier scenario.
  await group.restartRole()
  for (const [failure, answer, refusal] of group.finalStreamFailures) {
    await withTurn(async (turn) => {
      await group.provider(answer)
      const result = await group.runTurn({
        turn,
        prompt: 'Synthetic in-stream final refusal.',
        timeoutMs: 60_000,
      })
      assert.notEqual(result.code, 0, `In-stream ${failure} must end the CLI turn`)
      assert.equal(result.timedOut, false, `In-stream ${failure} must finish without a timeout`)
      assert.equal(result.provider.length, 1, `In-stream ${failure} must not be retried by the CLI`)
      const rows = await group.settled(turn, 1)
      assert.equal(rows[0].state, 'failed')
      const row = await group.keyRow(turn)
      assert.equal(row.lastRefusal, refusal)
      assert.ok(row.lastRefusalAt instanceof Date)
      assert.equal(
        `${result.stdout}\n${result.stderr}`.includes(group.providerMarker),
        false,
        'Provider failure text reached the sandbox',
      )
      const pool = await group.account()
      assert.equal(pool.health, 'ok', `In-stream ${failure} must not remove the account`)
      // The refusal names no reset: the pool cools the account after its probe of the quota.
      if (refusal === 'subscription_limit')
        await eventually(async () => (await group.account()).coolingUntil > new Date())
      else assert.equal(pool.coolingUntil, null)
    })
    passed(`real ${ids.driver} ends the turn after one provider request on in-stream ${failure}`)
  }

  // A short-lived in-stream failure stays retryable: the CLI asks again, waits out the
  // gateway's account pause and completes the turn with exactly one more provider request.
  await withTurn(async (turn) => {
    const answered = group.resultFor('B13 after a short-lived in-stream failure')
    await group.provider(group.answers.shortLivedInStream(JSON.stringify(answered)))
    const result = await group.runTurn({
      turn,
      prompt: 'Synthetic in-stream transient failure.',
      timeoutMs: 180_000,
    })
    assert.equal(result.code, 0, 'The CLI did not recover from a transient in-stream failure')
    assert.deepEqual(result.result, answered)
    assert.equal(
      result.provider.length,
      2,
      'A transient in-stream failure must cost exactly one more provider request',
    )
    const rows = await group.settled(turn, 2)
    assert.deepEqual(rows.map((row) => row.state).sort(), ['completed', 'failed'])
    assert.equal((await group.keyRow(turn)).lastRefusal, 'transient')
    assert.equal((await group.account()).health, 'ok')
  })
  passed(`real ${ids.driver} asks again after a transient in-stream failure and finishes the turn`)
}
