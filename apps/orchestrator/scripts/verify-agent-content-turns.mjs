/* global AbortSignal, console, fetch */
// The turns of the agent-content stand. Each one is admitted the way the product admits it (site
// lease, product assignment, turn key from the real issuer), runs the driver's own prepare and
// command in the CLI container, and is then judged by what the trusted side recorded: the content
// journal, the snapshot in S3, the plugin's receipts and the public page.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { createCodexDriver, createKimiDriver, createOpencodeDriver } from '@repo/agent-drivers'
import {
  preparedFilesSchema,
  preparedRunExposesSecret,
  turnCredentials,
  turnResultSchema,
} from '@repo/domain'

import { CLI_IMAGE, CLI_VERSIONS } from '../../../infra/dev/llm-verify/cli.mjs'
import { ZAI_PATHS } from '../../../infra/dev/llm-verify/fake-zai.mjs'
import { repository, run } from '../../../infra/dev/llm-verify/stack.mjs'
import {
  resetOpencodeHome,
  ZAI_BACKEND,
  ZAI_GATEWAY_BASE_URL,
  ZAI_MODEL,
} from './verify-llm-zai-setup.mjs'

const GATEWAY = 'http://sandbox-gw:8080'
const TURN_MS = 180_000
const PLATFORM_TOOLS = ['site_info', 'wp_rest', 'restore']

/** A provider request in the chat completions format: Kimi and Z.ai. */
const chatCompletions = {
  /** Tool names the request declares. */
  declared: (body) => (body.tools ?? []).map((tool) => (tool.function ?? tool).name),
  /** What the CLI told the model about its tool calls, oldest first. */
  toolOutputs: (body) =>
    (body.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => message.content),
}
/** A provider request in the Responses format: Codex nests its tools in namespaces. */
const responses = {
  declared: (body) =>
    [
      ...(body.tools ?? []),
      ...(body.input ?? [])
        .filter((item) => item.type === 'additional_tools')
        .flatMap((item) => item.tools ?? []),
    ]
      .flatMap((tool) => (tool.type === 'namespace' ? (tool.tools ?? []) : [tool]))
      .map((tool) => tool.name),
  toolOutputs: (body) =>
    (body.input ?? [])
      .filter((item) => /_output$/.test(item.type ?? ''))
      .map((item) => item.output),
}
/** The scenario of the fake of Codex and Kimi, with the result in both of its forms. */
const subscriptionScenario = (backend) => (control, content, result) =>
  control('scenario', { ...content, backend, output: result, text: JSON.stringify(result) })

/**
 * The table of turns: one row a CLI. What the stand does differently for a CLI is in its row;
 * the turns themselves are the same for every row.
 */
const ROWS = {
  codex: {
    name: 'Codex',
    driver: createCodexDriver,
    backend: 'openai-chatgpt',
    // How the role llm reaches the provider. A role process has one way: the stand restarts
    // the role when the next row needs the other one.
    path: 'proxy',
    llm: { baseUrl: `${GATEWAY}/codex`, model: 'gpt-6-sol' },
    effort: 'low',
    wire: responses,
    // Codex 0.158 in code mode declares only its `exec` tool and keeps the MCP tools inside
    // it: there the proof is the call itself.
    declares: [['exec', (name) => name === 'exec']],
    requests: (state) =>
      state.requests.filter((entry) => entry.path === '/backend-api/codex/responses'),
    scenario: subscriptionScenario('codex'),
  },
  kimi: {
    name: 'Kimi',
    driver: createKimiDriver,
    backend: 'kimi-code',
    path: 'proxy',
    llm: { baseUrl: `${GATEWAY}/kimi/v1`, model: 'k3-256k' },
    effort: 'low',
    wire: chatCompletions,
    // Kimi declares every MCP tool as a function.
    declares: PLATFORM_TOOLS.map((tool) => [
      tool,
      (name) => new RegExp(`(^|[_.])${tool}$`).test(name ?? ''),
    ]),
    // Kimi 2.1.1 checks the arguments of a call against the input schema of tools/list itself:
    // a route outside the schema's pattern never leaves the CLI.
    checksArguments: true,
    requests: (state) =>
      state.requests.filter((entry) => entry.path === '/coding/v1/chat/completions'),
    scenario: subscriptionScenario('kimi'),
  },
  opencode: {
    name: 'OpenCode',
    driver: createOpencodeDriver,
    backend: ZAI_BACKEND,
    // Z.ai needs no egress node: the role reaches it on a connection of its own.
    path: 'direct',
    llm: { baseUrl: ZAI_GATEWAY_BASE_URL, model: ZAI_MODEL },
    // The level of the profile glm-5.3-standard; the gateway sets it from the turn key.
    effort: 'high',
    wire: chatCompletions,
    // The pinned OpenCode names a tool of the MCP server `raditi` of the driver's
    // configuration raditi_<tool>, and declares each one as a function.
    declares: PLATFORM_TOOLS.map((tool) => [tool, (name) => name === `raditi_${tool}`]),
    requests: (state) => state.zai.requests.filter((entry) => entry.path === ZAI_PATHS.chat),
    // The synthetic Z.ai keeps its own scenario and answers with text alone.
    scenario: (control, content, result) =>
      control('zai', { scenario: { ...content, text: JSON.stringify(result) } }),
    // The home of the CLI is new in every sandbox, and the driver's wrapper starts no CLI over
    // what an earlier turn left in it.
    prepare: (cli) => resetOpencodeHome(cli.containerName),
    // The version of MCP the CLI asks for, the role answers and the CLI then names in every
    // request: the first contact of this CLI with the role's own tools/list.
    protocol: '2025-11-25',
    // By the record of the reconnaissance the CLI tells the server that it has dropped a
    // request after every call it has the answer of.
    cancels: true,
  },
}
/** The CLIs of the stand, in the order of their rows: each gets a page of its own. */
export const CONTENT_DRIVERS = Object.freeze(Object.keys(ROWS))
const PRIVACY_MARKER = /\[\[raditi:email:[a-f0-9-]{36}\]\]/
const { HeadObjectCommand, ListObjectsV2Command } = createRequire(
  join(repository, 'packages/storage/package.json'),
)('@aws-sdk/client-s3')

const resultFor = (summary, changeType) => ({
  summary,
  change_type: changeType,
  client_message:
    changeType === 'content'
      ? 'Текст на странице обновлён. Проверьте, пожалуйста, как он выглядит на сайте.'
      : 'Этот раздел сайта мне недоступен, поэтому я ничего не менял.',
  files_changed: [],
  questions: [],
  needs_approval: false,
  risk: 'low',
})

/** Protocol and tool names as one bounded printable line: never arguments, results or headers. */
const printable = (names) =>
  [...names]
    .slice(0, 64)
    .map((name) =>
      String(name)
        .replace(/[^\x21-\x7e]+/g, ' ')
        .slice(0, 64),
    )
    .join(', ')

/** What the CLI told the model about its last tool call, as one bounded printable line. */
function lastToolOutput(outputs) {
  const value = outputs.at(-1)
  if (value === undefined || value === null) return null
  return (typeof value === 'string' ? value : JSON.stringify(value))
    .replace(/[^\x20-\x7e]+/g, ' ')
    .slice(0, 400)
}

/**
 * What is wrong with the answers the model was handed for the three calls of the edit turn —
 * the read, the write and the repeat of the write — or null. Their statuses cannot tell: the
 * role answers a call it refuses after admission with HTTP 200 as well, as a tool result with a
 * code alone, and a CLI hands the model either. Only the stored answer of the write names the
 * snapshot of its journal row. With `verbatim`, for a CLI that passes the text of the role's
 * result as it is, the repeat is held to that answer word for word: the object, the snapshot
 * taken before the write, `updated`.
 */
export function replayProblem(outputs, stored, { verbatim = false } = {}) {
  if (outputs.length !== 3)
    return `${outputs.length} tool outputs instead of the read, the write and its repeat`
  const [, write, repeat] = outputs.map((output) =>
    typeof output === 'string' ? output : JSON.stringify(output),
  )
  if (!write.includes(stored.snapshotId)) return 'the write was not answered from the journal row'
  if (!repeat.includes(stored.snapshotId))
    return 'the repeat of the write was not answered from the journal row'
  if (!verbatim) return null
  if (repeat !== write) return 'the repeat of the write was answered differently from the write'
  let answer = null
  try {
    answer = JSON.parse(repeat)
  } catch {
    /* Not the text of the role alone: judged below. */
  }
  return isDeepStrictEqual(answer, { ...stored, updated: true })
    ? null
    : 'the repeat of the write did not get the stored answer of the journal row'
}

export async function verifyAgentContentTurns(ctx) {
  const { db, cli, control, stats, settled, site, models, workspaceId, credentials } = ctx
  const { leases, assignments, snapshots, snapshotKey, s3Client, bucket } = ctx
  const { secretMarkers, passed, setStage, rolePath } = ctx
  const imageId = (
    await run('docker', ['image', 'inspect', '--format', '{{.Id}}', CLI_IMAGE])
  ).stdout.trim()
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/)
  const image = `raditi-p3verify-cli@${imageId}`
  const drivers = Object.fromEntries(
    Object.entries(ROWS).map(([driver, row]) => [driver, row.driver({ image })]),
  )
  const instructions =
    '# Raditi platform rules (synthetic)\nEdit published content only through the platform MCP tools.\n'
  const providerRequests = async (driver) => ROWS[driver].requests(await control('state'))
  const publicPage = async (page) => {
    const response = await fetch(page.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.status, 200, 'The public page did not respond with 200')
    return response.text()
  }

  /** Admission as the product does it: lease, product assignment (TaskTurn), issued turn key. */
  async function openTurn(driver, prompt) {
    const row = ROWS[driver]
    const task = await db.task.create({
      data: { workspaceId, siteId: site.siteId, status: 'running', modelClass: 'standard' },
    })
    const fence = await leases.acquire({
      siteId: site.siteId,
      taskId: task.id,
      operation: 'turn',
      ttlMs: 720_000,
    })
    assert(fence, 'The free site refused its lease')
    const sessionId = randomUUID()
    const plan = {
      sandbox: {
        image,
        labels: { workspaceId, siteId: site.siteId, taskId: task.id, sessionId, turn: 1 },
        runtime: 'runc',
        resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
        user: { uid: 10001, gid: 10001 },
        env: {},
        secrets: [],
        network: { mode: 'gateway', routes: ['llm', 'mcp'] },
        hardTimeoutMs: 600_000,
      },
      context: {
        taskId: task.id,
        sessionId,
        turn: 1,
        llm: { ...row.llm, reasoningEffort: row.effort },
        mcp: { url: `${GATEWAY}/mcp` },
        instructions,
      },
      input: { prompt, attachments: [] },
      driverId: driver,
      driverVersion: CLI_VERSIONS[driver],
      workspace: {
        repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
        branch: `agent/${task.id}`,
        expectedBaseSha: 'b'.repeat(40),
        protectedPaths: [],
      },
      committedAt: new Date().toISOString(),
    }
    const assignment = await assignments.open({
      fence,
      sessionId,
      turn: 1,
      executor: 'local',
      plan,
      remainingMs: 600_000,
    })
    assert(assignment, 'The product assignment was not opened')
    const ref = { taskId: task.id, sessionId, turn: 1, epoch: assignment.firstEpoch }
    const grant = {
      driverId: driver,
      backend: row.backend,
      modelSlug: models[row.backend].slug,
      modelClass: 'standard',
      reasoningEffort: row.effort,
      ttlMs: 600_000,
      deadlineAt: assignment.deadlineAt,
      budgetRub: '135.00',
      boundSource: null,
    }
    const values = await credentials.issue(ref, grant)
    secretMarkers.add(values.llmApiKey)
    secretMarkers.add(values.mcpToken)
    return { driver, task, fence, assignment, ref, grant, values, plan }
  }

  /** The driver's prepare and command with the executor's own checks, then exactly that. */
  async function runCli(turn) {
    const driver = drivers[turn.driver]
    const context = {
      ...turn.plan.context,
      llm: { ...turn.plan.context.llm, apiKey: turn.values.llmApiKey },
      mcp: { ...turn.plan.context.mcp, token: turn.values.mcpToken },
    }
    const prepared = await driver.prepare(context)
    const argv = driver.command(prepared, turn.plan.input)
    const files = preparedFilesSchema.parse({
      files: prepared.files,
      env: prepared.env,
      secrets: prepared.secrets,
    })
    assert.equal(
      preparedRunExposesSecret(files, turnCredentials(context, files.secrets), argv),
      false,
      'A prepared file, env value or argument carries a turn credential',
    )
    await ROWS[turn.driver].prepare?.(cli)
    const before = {
      provider: (await providerRequests(turn.driver)).length,
      mcp: stats(),
      receipts: await site.receipts(),
      startedAt: Date.now(),
    }
    const result = await cli.runPrepared({ ...files, argv, timeoutMs: TURN_MS })
    // The observers' own checks of this turn's requests have all finished.
    await settled()
    const after = stats()
    // The stand's hops refuse what breaks a promise (a write before its snapshot, a request
    // outside the plugin's routes): the turn then fails for a reason that is named here.
    assert.deepEqual(
      after.violations.slice(before.mcp.violations.length),
      [],
      'The stand observed a broken promise during the turn',
    )
    const events = result.stdout.split('\n').flatMap((line) => driver.parseEvent(line))
    return {
      events,
      code: result.code,
      timedOut: result.timedOut === true,
      durationMs: Date.now() - before.startedAt,
      stdout: result.stdout,
      result: driver.extractResult(events, null),
      provider: (await providerRequests(turn.driver)).slice(before.provider),
      http: after.http.slice(before.mcp.http.length),
      site: Object.fromEntries(
        Object.entries(after.site).map(([name, count]) => [name, count - before.mcp.site[name]]),
      ),
      snapshotBeforeWrite: after.snapshotBeforeWrite - before.mcp.snapshotBeforeWrite,
      cancelledUnchanged: after.cancelledUnchanged - before.mcp.cancelledUnchanged,
      receipts: (await site.receipts()) - before.receipts,
    }
  }

  /** The site is busy for everyone else while the turn holds it. */
  async function assertSiteBusy(label) {
    const other = await db.task.create({
      data: { workspaceId, siteId: site.siteId, status: 'running', modelClass: 'standard' },
    })
    assert.equal(
      await leases.acquire({
        siteId: site.siteId,
        taskId: other.id,
        operation: 'turn',
        ttlMs: 60_000,
      }),
      null,
      `${label}: a second site lease was granted during the turn`,
    )
  }

  async function closeTurn(turn) {
    await credentials.revoke(turn.ref)
    const key = await db.llmKey.findUniqueOrThrow({
      where: {
        taskId_turnNo_firstEpoch: {
          taskId: turn.ref.taskId,
          turnNo: turn.ref.turn,
          firstEpoch: turn.ref.epoch,
        },
      },
    })
    assert(key.revokedAt, 'The turn key is not revoked')
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

  /** Nothing the sandbox holds, and no visitor contact, leaves it in a request or an event. */
  function assertNoLeak(turn, outcome, page, label) {
    const provider = JSON.stringify(outcome.provider)
    for (const [name, value] of [
      ['turn key', turn.values.llmApiKey],
      ['MCP token', turn.values.mcpToken],
      ['site password', site.applicationPassword],
      ['visitor contact', page.contact],
    ]) {
      assert.equal(provider.includes(value), false, `${label}: the ${name} reached the provider`)
      assert.equal(outcome.stdout.includes(value), false, `${label}: the ${name} is in CLI events`)
    }
  }

  const handshake = (outcome, row, label) => {
    for (const rpc of ['initialize', 'tools/list'])
      assert.ok(
        outcome.http.some((entry) => entry.rpc === rpc && entry.status === 200),
        `${label}: the role mcp did not answer ${rpc}`,
      )
    for (const request of outcome.provider) {
      const names = row.wire.declared(request.body)
      for (const [tool, declared] of row.declares)
        assert.ok(names.some(declared), `${label}: ${tool} was not declared to the provider`)
    }
    // One version of MCP in the whole exchange: asked for in `initialize`, answered by the
    // role, and named by the client in every request it sent after that answer.
    if (row.protocol)
      assert.deepEqual(
        [
          ...new Set(
            outcome.http.filter((entry) => entry.rpc !== null).map((entry) => entry.protocol),
          ),
        ],
        [row.protocol],
        `${label}: the CLI and the role mcp did not agree on MCP ${row.protocol}`,
      )
  }

  // The live mode has a model of its own instead of a script: its turns are another module's,
  // over the same admission, the same run of the driver and the same observers.
  if (ctx.live)
    return ctx.live({
      ctx,
      openTurn,
      runCli,
      assertSiteBusy,
      publicPage,
      handshake,
      assertNoLeak,
      row: ROWS.opencode,
      exchanges: ctx.exchanges,
    })

  for (const [driver, row] of Object.entries(ROWS)) {
    const { name } = row
    // The role llm as this provider needs it: through the egress proxy, or without one.
    setStage(`${name}: the role llm on the ${row.path} path`)
    await rolePath(row.path)
    const page = site.pages[driver]
    const route = `/wp/v2/pages/${page.id}`
    const changed = `raditi-agent-changed-${randomUUID()}`

    // Turn A: read, edit with an idempotency key, the same edit again, a content result.
    const label = `${name} content edit`
    setStage(label)
    const expected = resultFor(`Agent content ${name} edit`, 'content')
    assert.ok(turnResultSchema.safeParse(expected).success)
    await row.scenario(
      control,
      {
        scenario: 'content_edit',
        route,
        idempotencyKey: `agent-content-${driver}`,
        body: { content: `<p>${changed}. Напишите нам: {{contact}}</p>` },
      },
      expected,
    )
    const edit = await openTurn(driver, 'Update the text of the synthetic page as requested.')
    const edited = await runCli(edit)
    assert.equal(edited.code, 0, `${label}: the CLI exited with ${edited.code}`)
    assert.deepEqual(edited.result, expected)
    handshake(edited, row, label)
    assert.deepEqual(
      edited.http.filter((entry) => entry.rpc === 'tools/call').map((e) => [e.tool, e.status]),
      [
        ['wp_rest', 200],
        ['wp_rest', 200],
        ['wp_rest', 200],
      ],
      `${label}: expected one read and two identical writes`,
    )
    assert.equal(edited.provider.length, 4, `${label}: unexpected number of provider requests`)
    // Observations for the report, names only: what the provider is told about the platform
    // tools, which tools the turn's requests declare, and what the CLI asked of the role mcp.
    const named = PLATFORM_TOOLS.filter((tool) =>
      JSON.stringify(edited.provider[0].body).includes(tool),
    )
    console.log(
      `OBSERVED ${label}: the first provider request names ${named.length ? named.join(', ') : 'no platform MCP tool'}`,
    )
    console.log(
      `OBSERVED ${label}: tools declared to the provider: ${printable(
        new Set(edited.provider.flatMap((request) => row.wire.declared(request.body))),
      )}`,
    )
    console.log(
      `OBSERVED ${label}: requests to the role mcp: ${printable(
        edited.http.map((entry) => `${entry.method} ${entry.rpc ?? '-'} ${entry.status}`),
      )}`,
    )
    console.log(
      `OBSERVED ${label}: MCP versions the client named: ${printable(
        new Set(edited.http.map((entry) => entry.protocol ?? 'none')),
      )}`,
    )
    passed(
      `${label}: the role's tools/list is accepted${row.protocol ? ` under MCP ${row.protocol}` : ''} and the model's wp_rest calls arrive`,
    )

    // One journal row, one snapshot and one plugin receipt for the repeated key.
    const calls = await db.mcpCall.findMany({
      where: { turn: { taskId: edit.task.id, turnNo: 1 } },
      include: { snapshot: true },
    })
    assert.equal(calls.length, 1, `${label}: the repeated key made ${calls.length} journal rows`)
    const [call] = calls
    assert.deepEqual(
      [call.tool, call.result, call.objectRef, call.assignmentId],
      ['wp_rest', 'ok', `page:${page.id}`, edit.assignment.id],
    )
    assert.equal(await db.snapshot.count({ where: { taskId: edit.task.id } }), 1)
    assert.deepEqual(edited.site, { reads: 2, writes: 1, operations: 0, reconciles: 0, forgets: 0 })
    assert.equal(edited.receipts, 1, `${label}: the plugin kept ${edited.receipts} receipts`)
    // Three statuses of 200 do not say that the repeat was replayed: the role refuses a call
    // after admission with HTTP 200 as well. What the CLI then handed the model does.
    assert(call.snapshot, `${label}: the journal row names no snapshot`)
    const kept = { objectRef: call.objectRef, snapshotId: call.snapshot.id }
    const outputs = row.wire.toolOutputs(edited.provider.at(-1).body)
    const problem = replayProblem(outputs, kept)
    assert.equal(problem, null, `${label}: ${problem}`)
    passed(
      `${label}: one journal row, one snapshot and one plugin receipt for the repeated key; the repeat was answered from that row`,
    )

    // A client may tell the server that it has dropped a request. The role takes every such
    // notification and nothing follows from it: the stand compared the finished rows of the
    // journal around each one (a difference is a violation, checked with the turn), and the
    // lease names no write in flight.
    const cancelled = edited.http.filter((entry) => entry.rpc === 'notifications/cancelled')
    assert.ok(
      cancelled.every((entry) => entry.status === 202),
      `${label}: the role mcp did not take a notifications/cancelled`,
    )
    assert.equal(
      edited.cancelledUnchanged,
      cancelled.length,
      `${label}: the journal was not compared around every notifications/cancelled`,
    )
    const held = await db.siteLease.findUniqueOrThrow({ where: { siteId: site.siteId } })
    assert.equal(held.inflightMcpCallId, null, `${label}: the lease is blocked by a finished write`)
    if (row.cancels) {
      // This CLI sends one after every call, the write included. The stand's hop records a
      // request when its answer has ended, and keeps no id that would say which call a
      // notification names: what it shows is that the role answered one between its answers to
      // the write and to the repeat. The repeat still got the stored answer of the one journal
      // row, word for word as the write did: this CLI hands the model the text of the role.
      const order = edited.http.map((entry) => entry.rpc)
      const write = order.indexOf('tools/call', order.indexOf('tools/call') + 1)
      const repeat = order.indexOf('tools/call', write + 1)
      assert.ok(
        order.slice(write + 1, repeat).includes('notifications/cancelled'),
        `${label}: no notifications/cancelled answered between the write and its repeat`,
      )
      const differs = replayProblem(outputs, kept, { verbatim: true })
      assert.equal(differs, null, `${label}: ${differs}`)
      passed(
        `${label}: ${cancelled.length} notifications/cancelled taken; the journal is the same before and after each, the repeat of the write, answered after one of them, got the stored answer word for word, the lease is not blocked`,
      )
    }

    // The snapshot was in S3 before the write was admitted, and decrypts to the original text.
    assert.equal(edited.snapshotBeforeWrite, 1, `${label}: the write preceded its snapshot`)
    assert(call.writeStartedAt && call.snapshot?.payloadSha256 && call.snapshot.sizeBytes)
    const key = snapshotKey({ siteId: site.siteId, id: call.snapshot.id })
    assert.equal(call.snapshot.s3Key, key)
    assert.match(key, /^snapshots\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/)
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    // S3 keeps whole seconds, rounded down: an object stored before the write stays before it.
    assert.ok(
      head.LastModified.getTime() <= call.writeStartedAt.getTime(),
      `${label}: the snapshot object is newer than the admitted write`,
    )
    const stored = []
    for await (const chunk of await ctx.storage.get('artifacts', key)) stored.push(chunk)
    const artifact = Buffer.concat(stored).toString()
    for (const plain of [page.original, page.contact])
      assert.equal(artifact.includes(plain), false, `${label}: the snapshot is not encrypted`)
    const opened = await snapshots.load({
      id: call.snapshot.id,
      workspaceId,
      siteId: site.siteId,
      taskId: edit.task.id,
      objectRef: call.snapshot.objectRef,
      expiresAt: call.snapshot.expiresAt,
      payloadSha256: call.snapshot.payloadSha256,
      sizeBytes: call.snapshot.sizeBytes,
    })
    assert.equal(JSON.parse(Buffer.from(opened).toString()).content, page.content)
    passed(`${label}: the encrypted snapshot precedes the write and opens to the original text`)

    // The public page shows the new text; the contact came back from its marker.
    const html = await publicPage(page)
    assert.ok(html.includes(`${changed}. Напишите нам: ${page.contact}`), `${label}: not published`)
    assert.equal(html.includes(page.original), false, `${label}: the old text is still public`)
    assert.equal(html.includes('[[raditi:'), false, `${label}: a privacy marker was published`)
    for (const value of [edit.values.llmApiKey, edit.values.mcpToken])
      assert.equal(html.includes(value), false, `${label}: a turn credential was published`)
    assert.match(
      JSON.stringify(edited.provider.at(-1).body),
      PRIVACY_MARKER,
      `${label}: the model never saw the contact's marker`,
    )
    assertNoLeak(edit, edited, page, label)
    passed(`${label}: the public page has the new text, the contact reached only the site`)

    await assertSiteBusy(label)
    await closeTurn(edit)
    passed(`${label}: no second site lease during the turn; key revoked, turn closed`)

    // Turn B, a separate task: a route outside the profile (third parties' comments). Codex
    // 0.158 and OpenCode 1.18.34 send the call and the role mcp refuses it at admission; Kimi
    // 2.1.1 checks the arguments against the input schema of tools/list itself and sends
    // nothing. Either way nothing is journaled and the site is not asked.
    await refusedTurn({
      driver,
      page,
      changed,
      label: `${name} forbidden route`,
      prompt: 'Read the first comment of the synthetic site.',
      scenario: { route: '/wp/v2/comments/1' },
      reachesRole: !row.checksArguments,
    })
    // Turn C: a write without an idempotency key. The flat input schema allows it, so every
    // CLI sends it: the refusal is the role's own, before the journal and before the site.
    await refusedTurn({
      driver,
      page,
      changed,
      label: `${name} write without a key`,
      prompt: 'Rename the synthetic page.',
      scenario: { route, body: { title: `Keyless ${changed}` } },
      reachesRole: true,
    })
  }

  // One snapshot object per edit: neither the repeated write nor a refused call left another.
  setStage('snapshot objects in S3')
  const listed = await s3Client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `snapshots/${site.siteId}/` }),
  )
  assert.deepEqual(
    (listed.Contents ?? []).map((object) => object.Key).sort(),
    (await db.snapshot.findMany({ where: { siteId: site.siteId } }))
      .map((snapshot) => snapshot.s3Key)
      .sort(),
  )
  assert.equal(
    listed.KeyCount,
    CONTENT_DRIVERS.length,
    'Expected one snapshot object per edited page',
  )
  // The whole journal, whatever turn a row names: the edits and nothing of the refused calls.
  assert.equal(
    await db.mcpCall.count(),
    CONTENT_DRIVERS.length,
    'Expected one journal row per edited page',
  )
  passed('S3 holds exactly one snapshot object and the journal one row per edit')

  /**
   * A call the platform must refuse. How many requests reach the role is each CLI's own (Kimi
   * repeats a refused POST as a transport failure): the contract is that none of them is
   * accepted, journaled or sent to the site, and that the model is told and the turn goes on.
   */
  async function refusedTurn({ driver, page, changed, label, prompt, scenario, reachesRole }) {
    setStage(label)
    const refusal = resultFor(`Agent content: ${label}`, 'none')
    assert.ok(turnResultSchema.safeParse(refusal).success)
    const row = ROWS[driver]
    await row.scenario(control, { scenario: 'content_forbidden', ...scenario }, refusal)
    const turn = await openTurn(driver, prompt)
    const refused = await runCli(turn)
    assert.equal(refused.timedOut, false, `${label}: the turn hung`)
    assert.ok(refused.durationMs < TURN_MS, `${label}: the turn outlived its limit`)
    assert.equal(refused.code, 0, `${label}: the CLI exited with ${refused.code}`)
    assert.deepEqual(refused.result, refusal)
    handshake(refused, row, label)
    const shown = lastToolOutput(row.wire.toolOutputs(refused.provider.at(-1).body))
    assert.ok(shown, `${label}: the model was told nothing about its call`)
    for (const secret of secretMarkers) assert.equal(shown.includes(secret), false)
    const calls = refused.http.filter((entry) => entry.rpc === 'tools/call')
    assert.ok(
      calls.every((entry) => entry.tool === 'wp_rest' && entry.status === 400),
      `${label}: the role mcp did not refuse the call at admission`,
    )
    if (reachesRole) assert.ok(calls.length > 0, `${label}: the call never reached the role mcp`)
    assert.equal(
      await db.mcpCall.count({ where: { turn: { taskId: turn.task.id } } }),
      0,
      `${label}: the refused call was journaled`,
    )
    assert.equal(await db.snapshot.count({ where: { taskId: turn.task.id } }), 0)
    assert.deepEqual(
      refused.site,
      { reads: 0, writes: 0, operations: 0, reconciles: 0, forgets: 0 },
      `${label}: the site was asked`,
    )
    assert.equal(refused.receipts, 0)
    // An observation for the report, not a contract: the wording belongs to each CLI. Printed
    // only now: with no accepted call and no request to the site it cannot quote site content.
    console.log(
      `OBSERVED ${label}: ${calls.length} request(s) reached the role mcp, the turn took ${Math.round(refused.durationMs / 1000)} s; the CLI told the model: ${shown}`,
    )
    // What the platform itself learns of the refused call: the driver's common tool events.
    console.log(
      `OBSERVED ${label}: tool calls the driver reported: ${
        printable(
          refused.events
            .filter((event) => event.type === 'tool_call')
            .map((event) => `${event.tool} ${event.ok ? 'ok' : 'failed'}`),
        ) || 'none'
      }`,
    )
    const html = await publicPage(page)
    assert.ok(html.includes(changed) && !html.includes('Keyless'), `${label}: the page changed`)
    assert.equal(refused.provider.length, 2, `${label}: unexpected number of provider requests`)
    assertNoLeak(turn, refused, page, label)
    await assertSiteBusy(label)
    await closeTurn(turn)
    passed(
      `${label}: refused ${calls.length ? 'by the role mcp at admission' : 'by the CLI against the tool schema'}, nothing journaled, the site not asked, the turn ended in time`,
    )
  }
}
