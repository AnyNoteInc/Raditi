// The turns of verify:agent-content --live: the real OpenCode with the real GLM edits a page of
// the disposable WordPress through the real roles llm and mcp, and the trusted side returns the
// edit. A real model follows no script, so the checks are of two kinds. What the platform owes
// is held in every attempt and fails the run: the snapshot before the write, no write without a
// journal row, no privacy marker on the public page, the lease, the version of MCP, the
// declared tool names, the accounting, no credential anywhere. What depends on the model — the
// page changed, the result is valid — gets up to three attempts, each on a page of its own,
// and goes to the report as a share: it does not decide the run. The repeat of a write and the
// refusal of a forbidden route are not here: only the scripted model makes them certain.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { turnResultSchema } from '@repo/domain'

import {
  chatRequestSummary,
  resultVerdict,
  STREAM_FORMS,
  streamSummary,
  sumUsage,
} from '../../../infra/dev/llm-verify/live.mjs'
import { repository } from '../../../infra/dev/llm-verify/stack.mjs'

/** Calls one turn key of the content run may start: the role's LLM_MAX_CALLS_PER_KEY. */
export const CONTENT_TURN_CALLS = 8
/** Attempts the outcomes of the live flow get; each attempt edits a page of its own. */
export const CONTENT_ATTEMPTS = 3
/**
 * The pages of the live flow, one an attempt. Its own list: the rows of the deterministic pass
 * (one page a CLI) say nothing of how often a real model is asked.
 */
export const liveContentPages = () =>
  Array.from({ length: CONTENT_ATTEMPTS }, (_, index) => `attempt-${index + 1}`)

/**
 * What is wrong with the public page once the journal holds an applied write, whatever the
 * model wrote, or null. The role refuses a patch with a marker it does not know, and one that
 * still holds the prefix after the contacts are put back (src/mcp/content-privacy.ts): a raw
 * privacy marker on the page is then the platform's fault, not an outcome the model missed.
 */
export const publishedMarkerProblem = (html, applied) =>
  applied > 0 && html.includes('[[raditi:')
    ? 'a privacy marker is on the public page after an applied write'
    : null

/**
 * What the scripted model of a rehearsal answers as its result, by attempt: the two forms the
 * real model gave instead of a valid one (docs/plan/45-zai-live.md), then a valid one. Every
 * rehearsal so runs all the attempts, each on its page, and ends with a share of one in three.
 */
const REHEARSED_RESULTS = ['prose', 'field', 'valid']
const rehearsedText = (attempt, expected) => {
  const form = REHEARSED_RESULTS[attempt - 1]
  if (form === 'prose') return `The page is updated.\n\n${JSON.stringify(expected)}`
  if (form !== 'field') return JSON.stringify(expected)
  const { files_changed: _omitted, ...rest } = expected
  return JSON.stringify(rest)
}
const { GetObjectCommand, ListObjectsV2Command } = createRequire(
  join(repository, 'packages/storage/package.json'),
)('@aws-sdk/client-s3')

export function liveContentTurns({ live, accountId, script, undo, outputs }) {
  const { budget, report, passed } = live
  return async (stand) => {
    const { ctx, openTurn, runCli, assertSiteBusy, publicPage, handshake, assertNoLeak, row } =
      stand
    const { db, cli, site, credentials, assignments, leases, snapshots, snapshotKey, setStage } =
      ctx
    let windows
    let attempts = 0
    // The two outcomes that depend on the model, each counted on its own.
    let edits = 0
    let results = 0
    let appliedWrites = 0
    const verdicts = []
    assert.deepEqual(Object.keys(site.pages), liveContentPages(), 'A page for every attempt')
    for (const page of Object.values(site.pages)) {
      // The first key of the run also has the role probe the quota for the account's windows.
      budget.afford(
        CONTENT_TURN_CALLS + (windows ? 0 : 1),
        `the edit turn, attempt ${attempts + 1}`,
      )
      attempts += 1
      const label = `content edit, attempt ${attempts}`
      setStage(label)
      const changed = `raditi-live-changed-${randomUUID()}`
      const route = `/wp/v2/pages/${page.id}`
      const idempotencyKey = `live-content-${attempts}`
      const expected = {
        summary: `Live content edit ${attempts}`,
        change_type: 'content',
        client_message:
          'Текст на странице обновлён. Проверьте, пожалуйста, как он выглядит на сайте.',
        files_changed: [],
        questions: [],
        needs_approval: false,
        risk: 'low',
      }
      await script?.({
        scenario: 'content_edit',
        route,
        idempotencyKey,
        body: { content: `<p>${changed}. Напишите нам: {{contact}}</p>` },
        text: rehearsedText(attempts, expected),
      })
      const turn = await openTurn(
        'opencode',
        [
          'Synthetic check of the platform on a disposable test site. Use only the platform tool wp_rest.',
          `1. Read the page: method GET, route ${route}.`,
          `2. In its content replace the text "${page.original}" with "${changed}". Keep every other character of the content exactly as you read it, including any marker of the form [[raditi:...]].`,
          `3. Send one write: method POST, the same route, body {"content": "<the new content>"}, idempotencyKey "${idempotencyKey}".`,
          'Then reply with the final result; its change_type is "content".',
        ].join('\n'),
      )
      const close = async () => {
        assert(
          await assignments.finish({
            id: turn.assignment.id,
            epoch: turn.fence.epoch,
            outcome: 'completed',
          }),
          'The product assignment did not close',
        )
        assert(await leases.release(turn.fence), 'The site lease was not released')
      }
      if (!windows) {
        try {
          windows = await live.admitWindows({ db, accountId })
        } catch (error) {
          await credentials.revoke(turn.ref)
          await close()
          throw error
        }
        passed(
          'the windows of the account were written by the quota probe of the role; the run may start',
        )
      }
      const requestsBefore = budget.state().used
      // Fail closed, as the gateway stand does: a refusal of a guard ends the turn now, not
      // when the CLI gives up repeating or the turn runs out of time.
      const outcome = await live.watched(
        () => runCli(turn),
        () => cli.close(),
      )
      outputs.push(outcome.stdout)
      budget.assertHeld()
      assert.equal(outcome.timedOut, false, `${label}: the turn hung`)
      assert.equal(
        await live.sandboxHoldsKey(cli.containerName),
        false,
        `${label}: the plan key is in a file of the sandbox`,
      )

      // ── What the platform owes, whatever the model did ──────────────────────────────────
      // The role's tools/list was accepted under the one version of MCP, and every request the
      // CLI sent declared the three platform tools.
      handshake(outcome, row, label)
      assertNoLeak(turn, outcome, page, label)
      // The journal: for every write that reached the site a snapshot taken and stored before
      // it, and no write to the site without a row. (A second row for one key cannot exist:
      // the key of a row is unique in the database. A second write for one key would show
      // below, as more writes to the site than rows.)
      const journal = await db.mcpCall.findMany({
        where: { turn: { taskId: turn.task.id, turnNo: 1 } },
        include: { snapshot: true },
      })
      const written = journal.filter((call) => call.writeStartedAt)
      for (const call of written) {
        assert.equal(call.assignmentId, turn.assignment.id, `${label}: a row of another turn`)
        assert(call.snapshot?.payloadSha256, `${label}: a write without an acknowledged snapshot`)
        const key = snapshotKey({ siteId: site.siteId, id: call.snapshot.id })
        assert.equal(call.snapshot.s3Key, key)
        const stored = []
        for await (const chunk of await ctx.storage.get('artifacts', key)) stored.push(chunk)
        const artifact = Buffer.concat(stored).toString()
        for (const plain of [page.original, page.contact])
          assert.equal(artifact.includes(plain), false, `${label}: the snapshot is not encrypted`)
      }
      // Every write that left for the site was checked on its way by the stand's hop: its
      // snapshot acknowledged and present in S3, the lease naming that call. A real model may
      // send a write the site refuses; no write reaches the site without a journal row, and
      // every applied one left exactly one receipt in the plugin.
      const applied = written.filter((call) => call.result === 'ok').length
      assert.equal(
        outcome.snapshotBeforeWrite,
        outcome.site.writes,
        `${label}: a write preceded its snapshot`,
      )
      assert.ok(
        outcome.site.writes <= written.length,
        `${label}: a write reached the site without a journal row`,
      )
      assert.ok(outcome.site.writes >= applied, `${label}: an applied write the site never saw`)
      assert.ok(
        outcome.receipts >= applied && outcome.receipts <= written.length,
        `${label}: ${outcome.receipts} receipts of the plugin for ${applied} applied writes`,
      )
      assert.ok(
        (await db.snapshot.count({ where: { taskId: turn.task.id } })) >= applied,
        `${label}: an applied write without a snapshot row`,
      )
      // Every notifications/cancelled was taken and changed nothing the journal holds.
      const cancelled = outcome.http.filter((entry) => entry.rpc === 'notifications/cancelled')
      assert.ok(cancelled.every((entry) => entry.status === 202))
      assert.equal(outcome.cancelledUnchanged, cancelled.length)
      // The lease: nobody else gets the site during the turn, and no finished write blocks it.
      await assertSiteBusy(label)
      const held = await db.siteLease.findUniqueOrThrow({ where: { siteId: site.siteId } })
      assert.equal(
        held.inflightMcpCallId,
        null,
        `${label}: the lease is blocked by a finished write`,
      )
      // The accounting: the provider's own counts, equal to what the CLI printed.
      const rows = await db.llmCall.findMany({
        where: { key: { taskId: turn.task.id, turnNo: 1 } },
        include: { tokenUsage: true },
        orderBy: { startedAt: 'asc' },
      })
      assert.ok(
        rows.every((call) => call.state !== 'open'),
        `${label}: a call is still open`,
      )
      assert.ok(rows.length <= CONTENT_TURN_CALLS, `${label}: ${rows.length} calls of one key`)
      const completed = rows.filter((call) => call.state === 'completed')
      for (const call of completed)
        assert.equal(call.tokenUsage?.estimated, false, `${label}: the usage is an estimate`)
      const fromRole = sumUsage(
        completed.map((call) => ({
          inputUncached: call.tokenUsage.inputUncachedTokens,
          cacheRead: call.tokenUsage.cacheReadTokens,
          cacheWrite: call.tokenUsage.cacheWriteTokens,
          output: call.tokenUsage.outputTokens,
          reasoning: call.tokenUsage.reasoningTokens,
        })),
      )
      const fromCli = sumUsage(
        outcome.events.filter((event) => event.type === 'usage').map((event) => event.usage),
      )
      assert.deepEqual(
        fromRole,
        fromCli,
        `${label}: llm_calls (${JSON.stringify(fromRole)}) and the step_finish records of the CLI (${JSON.stringify(fromCli)}) disagree`,
      )
      const calls = outcome.http
        .filter((entry) => entry.rpc === 'tools/call')
        .map((entry) => `${entry.tool} ${entry.status}`)
      report(
        `${label}: exit ${outcome.code}, ${Math.round(outcome.durationMs / 1000)} s, provider requests ${budget.state().used - requestsBefore}, calls ${rows.length} (failed ${rows.length - completed.length}), tokens in ${fromRole.inputUncached} cached ${fromRole.cacheRead} out ${fromRole.output} reasoning ${fromRole.reasoning}; MCP calls: ${calls.join(', ') || 'none'}; journal rows ${journal.length}, writes to the site ${outcome.site.writes}, snapshots ${written.length}, notifications/cancelled ${cancelled.length}`,
      )

      // The public page after an applied write holds no raw privacy marker, whatever else it
      // holds: the last thing the platform owes here.
      const html = await publicPage(page)
      const marker = publishedMarkerProblem(html, applied)
      assert.equal(marker, null, `${label}: ${marker}`)
      appliedWrites += applied

      // ── What depends on the model ───────────────────────────────────────────────────────
      const published =
        html.includes(`${changed}. Напишите нам: ${page.contact}`) && !html.includes(page.original)
      const valid =
        outcome.code === 0 &&
        turnResultSchema.safeParse(outcome.result).success &&
        outcome.result.change_type === 'content'
      const edited = published && written.some((call) => call.result === 'ok')
      const verdict = resultVerdict(outcome.events, turnResultSchema)
      verdicts.push(verdict)
      if (edited) edits += 1
      if (valid) results += 1
      report(
        `${label}: the page ${edited ? 'shows the new text with the contact back from its marker' : 'does not show the expected text'}; result: ${verdict}${verdict === 'valid' && !valid ? ' (but its change_type is not "content")' : ''}`,
      )

      // ── The trusted return: the turn's key is revoked, the lease is still its own ───────
      await credentials.revoke(turn.ref)
      const revoked = await db.llmKey.findFirstOrThrow({ where: { taskId: turn.task.id } })
      assert(revoked.revokedAt, 'The turn key is not revoked')
      const returned = await undo({ fence: turn.fence, turn: 1 })
      assert.deepEqual(returned, { restored: applied }, `${label}: the trusted return`)
      const after = await publicPage(page)
      assert.ok(
        after.includes(`${page.original}. Напишите нам: ${page.contact}`),
        `${label}: the page is not what it was before the turn`,
      )
      assert.equal(after.includes(changed), false, `${label}: the returned edit is still public`)
      const restores = await db.mcpCall.findMany({ where: { hostTaskId: turn.task.id } })
      assert.equal(restores.length, applied)
      for (const call of restores)
        assert.deepEqual(
          [call.tool, call.result, call.assignmentId, call.credentialKeyId, call.hostOperation],
          ['restore', 'ok', null, null, 'turn'],
        )
      await close()
      // Both outcomes seen at least once: no further attempt is needed.
      if (edits > 0 && results > 0) break
    }
    report(
      `content edit: the page was changed in ${edits} of ${attempts} attempt(s); the result was valid in ${results} of ${attempts}; these shares do not decide the run`,
    )
    if (live.rehearsal) {
      // The scripted model is certain: every attempt edits its page, and the results are those
      // of REHEARSED_RESULTS — a share of one in three, with which the run passes.
      assert.deepEqual([attempts, edits, results], [CONTENT_ATTEMPTS, CONTENT_ATTEMPTS, 1])
      assert.deepEqual(verdicts, ['text before the JSON object', 'schema: files_changed', 'valid'])
      passed(
        'rehearsal: the scripted model gave an invalid result in two attempts of three; each attempt edited a page of its own, the share went to the report and the run went on',
      )
    }
    passed(
      `content edit: in ${attempts} attempt(s) the snapshot preceded every write (${appliedWrites} applied), no write reached the site without a journal row, no privacy marker is on a public page, MCP 2025-11-25, the platform tools declared, provider usage equals the CLI`,
    )
    passed(
      `trusted return: with the turn key revoked the role returned every applied edit (${appliedWrites}) by the fence of the lease; each page is what it was`,
    )

    // The calls and the stream forms of the whole run, for the report.
    await live.reportCalls(db)
    const forms = new Set()
    for (const request of stand.exchanges())
      if (request.status === 200 && request.contentType === 'text/event-stream')
        for (const form of streamSummary(request.responseText).forms) forms.add(form)
    const compactions = stand
      .exchanges()
      .filter((request) => chatRequestSummary(request.requestBody)?.compaction).length
    report(
      `stream forms no scenario of the synthetic provider makes (of the ${STREAM_FORMS.length} the stand looks for): ${[...forms].join(' ') || 'none'}; compaction requests: ${compactions}`,
    )

    // What S3 holds, for the search at the end: every object, and every snapshot opened.
    const listed = await ctx.s3Client.send(new ListObjectsV2Command({ Bucket: ctx.bucket }))
    const objects = []
    for (const object of listed.Contents ?? []) {
      const got = await ctx.s3Client.send(
        new GetObjectCommand({ Bucket: ctx.bucket, Key: object.Key }),
      )
      objects.push(Buffer.from(await got.Body.transformToByteArray()))
    }
    const opened = []
    for (const snapshot of await db.snapshot.findMany({ where: { siteId: site.siteId } }))
      opened.push(
        Buffer.from(
          await snapshots.load({
            id: snapshot.id,
            workspaceId: ctx.workspaceId,
            siteId: site.siteId,
            taskId: snapshot.taskId,
            objectRef: snapshot.objectRef,
            expiresAt: snapshot.expiresAt,
            payloadSha256: snapshot.payloadSha256,
            sizeBytes: snapshot.sizeBytes,
          }),
        ),
      )
    assert.equal(objects.length, opened.length, 'S3 holds another number of objects than snapshots')
    return { windows, objects, opened }
  }
}
