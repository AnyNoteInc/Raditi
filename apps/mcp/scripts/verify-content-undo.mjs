// Trusted host undo on the disposable real WordPress, PostgreSQL, S3 and OpenBao, in the process
// of the role: no network channel yet and no turn key. A turn that failed is undone under its
// own lease; a done task is undone under the revert lease of the task that reverts it. The
// account pool is empty for both: an undo never asks for a key.
import assert from 'node:assert/strict'
import console from 'node:console'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { PostgresSiteLeaseStore, PostgresTaskTurnAssignmentStore } from '@repo/db'
import { PostgresMcpAccess } from '../dist/access/mcp-access.js'
import { TaskEventTurnJournal } from '../../core/dist/turns/turn-journal.js'
import { sampleDriverId } from '../src/testing/ids.ts'

const { fetch, AbortSignal } = globalThis
const hash = (value) => createHash('sha256').update(value).digest('hex')

export async function verifyContentUndo({
  db,
  workspaceId,
  siteId,
  modelId,
  accountId,
  origin,
  /** The content service of the role: the regular resolver, the site access from Vault. */
  content,
  gateway,
  pageIds,
  plan,
}) {
  const leases = new PostgresSiteLeaseStore(db)
  const assignments = new PostgresTaskTurnAssignmentStore(db)
  const access = new PostgresMcpAccess(db)
  const turnJournal = new TaskEventTurnJournal(db)
  const fence = ({ siteId, taskId, operation, epoch }) => ({ siteId, taskId, operation, epoch })
  const publicHtml = async (id) => {
    const response = await fetch(`${origin}/?page_id=${id}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200)
    return response.text()
  }
  const states = () => Promise.all(pageIds.map((id) => gateway.read(`page:${id}`)))
  const baseline = await states()
  const baselineHtml = await Promise.all(pageIds.map(publicHtml))
  // A plain title is found in the page as it is; the fixture titles are.
  for (const state of baseline) assert.match(state.title, /^[A-Za-z0-9 ]+$/)

  /** Whatever a call does, it must not issue a key: the pool has no account to issue from. */
  const emptyPool = async (work) => {
    const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { enabled: false, status: 'retired' },
    })
    assert.equal(
      await db.subscriptionAccount.count({ where: { enabled: true, status: 'active' } }),
      0,
      'The account pool of the stand must be empty',
    )
    const keys = await db.llmKey.count()
    try {
      return await work()
    } finally {
      assert.equal(await db.llmKey.count(), keys, 'A trusted undo must not issue a turn key')
      await db.subscriptionAccount.update({
        where: { id: accountId },
        data: { enabled: account.enabled, status: account.status },
      })
    }
  }

  /** One agent turn of a new task that edits every fixture page, the lease still its own. */
  const editedTurn = async () => {
    const task = await db.task.create({ data: { workspaceId, siteId, status: 'running' } })
    const sessionId = randomUUID()
    const lease = await leases.acquire({
      siteId,
      taskId: task.id,
      operation: 'turn',
      ttlMs: 720_000,
    })
    assert(lease)
    const assignment = await assignments.open({
      fence: lease,
      sessionId,
      turn: 1,
      executor: 'local',
      plan: plan(task.id, sessionId),
      remainingMs: 600_000,
    })
    assert(assignment)
    const mcpToken = `mcp_${randomBytes(32).toString('hex')}`
    const key = await db.llmKey.create({
      data: {
        keyHash: hash(randomUUID()),
        mcpTokenHash: hash(mcpToken),
        taskId: task.id,
        taskAttempt: 1,
        sessionId,
        turnNo: 1,
        firstEpoch: assignment.firstEpoch,
        driverId: sampleDriverId,
        modelId,
        subscriptionAccountId: accountId,
        budgetRub: '100',
        issuedAt: new Date(),
        expiresAt: assignment.deadlineAt,
        validUntil: assignment.deadlineAt,
      },
    })
    const scope = await access.authenticate(mcpToken)
    assert(scope)
    // One plain word: nothing for the site to retypeset.
    const marker = `undo${randomBytes(8).toString('hex')}`
    for (const id of pageIds) {
      const result = await content.wpRest(scope, {
        method: 'POST',
        route: `/wp/v2/pages/${id}`,
        body: { title: `Edited ${marker}`, content: `<p>Edited ${marker}</p>` },
        idempotencyKey: `edit:${id}`,
      })
      assert.equal(result.result, 'ok')
    }
    for (const id of pageIds) assert((await publicHtml(id)).includes(marker))
    const revoke = () =>
      db.llmKey.update({
        where: { id: key.id },
        data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
      })
    return { task, sessionId, lease, assignment, mcpToken, keyId: key.id, marker, revoke }
  }

  /** A task whose only turn edited every fixture page and completed; its site is free. */
  const doneTask = async () => {
    const turn = await editedTurn()
    await turnJournal.record({
      fence: fence(turn.lease),
      sessionId: turn.sessionId,
      turn: 1,
      sequence: 1,
      phase: 'completed',
      candidateHeadSha: 'b'.repeat(40),
      nativeSessionId: randomUUID(),
    })
    await turn.revoke()
    assert(await leases.release(fence(turn.lease)))
    assert(
      await assignments.finish({
        id: turn.assignment.id,
        epoch: turn.lease.epoch,
        outcome: 'completed',
      }),
    )
    await db.task.update({
      where: { id: turn.task.id },
      data: { status: 'done', finishedAt: new Date() },
    })
    return turn
  }

  /** The site shows what it showed before the turn: the journal state and the public pages. */
  const returned = async (marker) => {
    assert.deepEqual(await states(), baseline)
    for (const [index, id] of pageIds.entries()) {
      const html = await publicHtml(id)
      assert(!html.includes(marker), 'The public page still shows the undone edit')
      assert(html.includes(baseline[index].title), 'The public page lost its previous title')
      assert(baselineHtml[index].includes(baseline[index].title))
    }
  }
  const hostCalls = (taskId) =>
    db.mcpCall.findMany({
      where: { hostTaskId: taskId },
      include: { turn: true },
      orderBy: { journalNo: 'asc' },
    })
  const hostRestores = (calls, holder, operation, epoch, targetTaskId) => {
    assert.equal(calls.length, pageIds.length)
    for (const call of calls) {
      assert.equal(call.tool, 'restore')
      assert.equal(call.result, 'ok')
      assert.equal(call.assignmentId, null)
      assert.equal(call.credentialKeyId, null)
      assert.equal(call.hostTaskId, holder)
      assert.equal(call.hostOperation, operation)
      assert.equal(call.leaseEpoch, epoch)
      // Written under the turn of the edit it returns.
      assert.equal(call.turn.taskId, targetTaskId)
    }
  }

  // 1. The turn failed: its key is revoked, the lease is still its own.
  const failed = await editedTurn()
  await failed.revoke()
  assert.equal(await access.authenticate(failed.mcpToken), null, 'A revoked token admits nothing')
  const turnFence = fence(failed.lease)
  await emptyPool(async () => {
    assert.deepEqual(await content.undoTurn({ fence: turnFence, turn: 1 }), {
      restored: pageIds.length,
    })
    // A repeat finds nothing left and sends nothing.
    assert.deepEqual(await content.undoTurn({ fence: turnFence, turn: 1 }), { restored: 0 })
  })
  await returned(failed.marker)
  hostRestores(
    await hostCalls(failed.task.id),
    failed.task.id,
    'turn',
    turnFence.epoch,
    failed.task.id,
  )
  const afterUndo = await db.siteLease.findUniqueOrThrow({ where: { siteId } })
  assert.equal(afterUndo.holderTaskId, failed.task.id)
  assert.equal(afterUndo.epoch, turnFence.epoch, 'The undo ran under the same lease')
  assert.equal(afterUndo.heldForOperator, false)
  assert.equal(afterUndo.inflightMcpCallId, null)
  // Only now the turn is closed and the site freed, as the supervisor will do it.
  await turnJournal.record({
    fence: turnFence,
    sessionId: failed.sessionId,
    turn: 1,
    sequence: 1,
    phase: 'failed',
    reason: 'run_failed',
  })
  assert(await leases.release(turnFence))
  assert(
    await assignments.finish({
      id: failed.assignment.id,
      epoch: turnFence.epoch,
      outcome: 'failed',
    }),
  )
  await db.task.update({
    where: { id: failed.task.id },
    data: { status: 'failed', finishedAt: new Date() },
  })
  assert.equal(
    (await db.taskTurn.findFirstOrThrow({ where: { taskId: failed.task.id } })).status,
    'failed',
  )
  assert.equal((await db.siteLease.findUniqueOrThrow({ where: { siteId } })).holderTaskId, null)
  console.log(
    'PASS failed turn: trusted undo under the same lease returns the public WordPress text, key revoked and account pool empty',
  )

  // 2. The task is done and its site is free; «Отменить» is a task that reverts it.
  const done = await doneTask()
  // The key of the finished turn is cleaned up: nothing of it is needed any more.
  await db.llmKey.delete({ where: { id: done.keyId } })
  const undo = await db.task.create({
    data: { workspaceId, siteId, status: 'running', billable: false, revertsTaskId: done.task.id },
  })
  const revert = await leases.acquire({
    siteId,
    taskId: undo.id,
    operation: 'revert',
    ttlMs: 120_000,
  })
  assert(revert)
  const revertFence = fence(revert)
  await emptyPool(async () => {
    // The revert lease opens the task it reverts and no other task of the site.
    await assert.rejects(content.undoTask({ fence: revertFence, targetTaskId: failed.task.id }), {
      code: 'LEASE_LOST',
    })
    await assert.rejects(
      content.undoTask({
        fence: { ...revertFence, epoch: revertFence.epoch - 1 },
        targetTaskId: done.task.id,
      }),
      { code: 'LEASE_LOST' },
    )
    for (const id of pageIds) assert((await publicHtml(id)).includes(done.marker))
    assert.deepEqual(await content.undoTask({ fence: revertFence, targetTaskId: done.task.id }), {
      restored: pageIds.length,
    })
    assert.deepEqual(await content.undoTask({ fence: revertFence, targetTaskId: done.task.id }), {
      restored: 0,
    })
  })
  await returned(done.marker)
  hostRestores(await hostCalls(undo.id), undo.id, 'revert', revertFence.epoch, done.task.id)
  assert.equal(await db.llmKey.count({ where: { taskId: { in: [done.task.id, undo.id] } } }), 0)
  assert(await leases.release(revertFence))
  await db.task.update({ where: { id: undo.id }, data: { status: 'done', finishedAt: new Date() } })
  assert.equal((await db.siteLease.findUniqueOrThrow({ where: { siteId } })).holderTaskId, null)
  console.log(
    'PASS done task: trusted undo under the revert lease of its undo task returns the public WordPress text, no turn key and account pool empty',
  )

  // 3. Somebody edits one page by hand after the task, and «Отменить» is asked twice at once.
  const raced = await doneTask()
  const undoRaced = await db.task.create({
    data: { workspaceId, siteId, status: 'running', billable: false, revertsTaskId: raced.task.id },
  })
  const racedLease = await leases.acquire({
    siteId,
    taskId: undoRaced.id,
    operation: 'revert',
    ttlMs: 120_000,
  })
  assert(racedLease)
  const racedFence = fence(racedLease)
  const request = { fence: racedFence, targetTaskId: raced.task.id }
  // The undo goes newest first: the page the task edited first is reached last.
  const [manualId, ...returnedIds] = pageIds
  assert(returnedIds.length > 0, 'The fixture needs a page before the one edited by hand')
  const edited = await gateway.read(`page:${manualId}`)
  const manual = `<p>Manual ${raced.marker}</p>`
  /** A write that is no call of the journal: a person in the admin panel of the site. */
  const byHand = (text, expectedStateHash) =>
    gateway.conditionalWrite({
      callId: randomUUID(),
      siteId,
      epoch: racedFence.epoch,
      requestHash: hash(`synthetic-human-edit:${text}`),
      objectRef: `page:${manualId}`,
      expectedStateHash,
      deadlineAt: Date.now() + 10_000,
      ttlMs: 10_000,
      mode: 'edit',
      fields: { content: text },
    })
  assert.equal((await byHand(manual, edited.stateHash)).kind, 'committed')
  const changed = await gateway.read(`page:${manualId}`)
  assert.equal(changed.content, manual)
  // The text of the page itself: the title of a page is shown on the other pages too, in
  // the menu of the site, and the page edited by hand keeps the title the task gave it.
  const editedText = `<p>Edited ${raced.marker}</p>`
  for (const id of returnedIds) assert((await publicHtml(id)).includes(editedText))
  await emptyPool(async () => {
    const race = await Promise.allSettled([content.undoTask(request), content.undoTask(request)])
    for (const result of race) {
      assert.equal(result.status, 'rejected', 'An undo stopped by a manual edit reports no success')
      assert(
        ['CONFLICT', 'CONTENT_RESTORE_FAILED'].includes(result.reason?.code),
        `Unexpected stop of a raced undo: ${result.reason?.code}`,
      )
    }
    // Alone, the answer is the conflict, as often as it is asked.
    for (let repeat = 0; repeat < 2; repeat++)
      await assert.rejects(content.undoTask(request), { code: 'CONFLICT' })
  })
  // What was returned stays returned; the page edited by hand is as the person left it.
  assert.deepEqual(await gateway.read(`page:${manualId}`), changed)
  assert((await publicHtml(manualId)).includes(`Manual ${raced.marker}`))
  for (const id of returnedIds) {
    const previous = baseline[pageIds.indexOf(id)]
    assert.deepEqual(await gateway.read(`page:${id}`), previous)
    const html = await publicHtml(id)
    assert(!html.includes(editedText), 'The public page still shows the undone edit')
    assert(html.includes(previous.title), 'The public page lost its previous title')
  }
  const attempts = await hostCalls(undoRaced.id)
  const sent = attempts.filter((call) => call.writeStartedAt !== null)
  assert.deepEqual(
    sent.map((call) => [call.objectRef, call.result]).sort(),
    returnedIds.map((id) => [`page:${id}`, 'ok']).sort(),
    'Each restore reaches the site once, whoever asked for it',
  )
  const refused = attempts.filter((call) => call.writeStartedAt === null)
  assert(refused.length >= 2, 'Every undo that reached the manual edit left its refusal')
  for (const call of refused) {
    assert.equal(call.objectRef, `page:${manualId}`)
    assert.equal(call.result, 'error')
    assert.equal(call.response?.code, 'CONTENT_CONFLICT')
  }
  const afterConflict = await db.siteLease.findUniqueOrThrow({ where: { siteId } })
  // A conflict is an answer, not an unknown write: the site is not held.
  assert.equal(afterConflict.heldForOperator, false)
  assert.equal(afterConflict.inflightMcpCallId, null)
  // The person takes the manual edit back: the same «Отменить» returns the last page too.
  assert.equal((await byHand(edited.content, changed.stateHash)).kind, 'committed')
  assert.deepEqual(await gateway.read(`page:${manualId}`), edited)
  await emptyPool(async () => {
    assert.deepEqual(await content.undoTask(request), { restored: 1 })
    assert.deepEqual(await content.undoTask(request), { restored: 0 })
  })
  await returned(raced.marker)
  assert.equal(
    (await hostCalls(undoRaced.id)).filter((call) => call.result === 'ok').length,
    pageIds.length,
  )
  assert(await leases.release(racedFence))
  await db.task.update({
    where: { id: undoRaced.id },
    data: { status: 'done', finishedAt: new Date() },
  })
  console.log(
    'PASS manual edit and two undos at once: the conflict stops the undo, each restore reaches the real WordPress once, what was returned stays returned, and with the manual edit taken back the same undo completes',
  )
}
