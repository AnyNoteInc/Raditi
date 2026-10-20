/* global AbortSignal, fetch */
// What a group of the gateway stand does with one account of one offer of Z.ai, shared by the
// plan group (verify-llm-zai.mjs) and the API group (verify-llm-zai-api.mjs): tasks with their
// site leases, turn keys issued and revoked by core, the calls of a key in llm_calls, and a turn
// of the real pinned OpenCode CLI the way production runs it — the driver's prepare and command
// in the CLI container, through sandbox-gw to the role llm and to the MCP route.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createOpencodeDriver } from '@repo/agent-drivers'
import {
  CLI_IMAGE,
  dockerCommand,
  filesHoldingResult,
  filesHoldingSearch,
} from '../../../infra/dev/llm-verify/cli.mjs'
import {
  SYNTHETIC_ZAI_API_KEY,
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_ROTATED_API_KEY,
  SYNTHETIC_ZAI_ROTATED_KEY,
} from '../../../infra/dev/llm-verify/fake-zai.mjs'
import { eventually, run } from '../../../infra/dev/llm-verify/stack.mjs'
import { opencodeUserAgent } from '../../../packages/llm-backends/src/zai-coding/backend.ts'
import { productionMcpTools } from './verify-llm-mcp-tools.mjs'
import { zaiForms } from './verify-llm-zai-forms.mjs'
import {
  OPENCODE_HOME as HOME,
  prepareOpencodeTurn,
  ZAI_MODEL as MODEL,
  ZAI_PROFILE as PROFILE,
} from './verify-llm-zai-setup.mjs'

// Everything the agent can write to in the CLI container, the session database included.
const SANDBOX_ROOTS = ['/agent-home', '/workspace', '/tmp', '/run/raditi']
/** Every key of the synthetic Z.ai: none of them may be in a file of the sandbox. */
export const PROVIDER_KEYS = Object.freeze([
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_ROTATED_KEY,
  SYNTHETIC_ZAI_API_KEY,
  SYNTHETIC_ZAI_ROTATED_API_KEY,
])
// The headers the adapter sends and what HTTP itself needs; nothing a CLI wrote.
export const PROVIDER_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'authorization',
  'content-type',
  'user-agent',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
])
export const bash = (command) => ({
  name: 'bash',
  arguments: { command, description: 'Synthetic step' },
})
export const resultFor = (summary, files = []) => ({
  summary,
  change_type: files.length ? 'code' : 'none',
  client_message: 'Синтетическая проверка завершена.',
  files_changed: files,
  questions: [],
  needs_approval: false,
  risk: 'low',
})

/**
 * The harness of one group: `offer` is one of ZAI_OFFERS, `workspaceId` the workspace its tasks
 * belong to, `name` what its sites and markers are called. `refs`, `refusals` and `outputs`
 * collect what the group checks at its end: the turns issued, every refusal the sandbox
 * received as the CLI printed it, and everything the CLI printed.
 */
export async function createZaiHarness(ctx, { offer, workspaceId, name }) {
  const { db, core, stack, cli, control, secretMarkers, promptMarker, metricsToken } = ctx
  const zai = (body) => control('zai', body)
  const refs = []
  const refusals = []
  const outputs = []

  /** A new task with its site lease; `continued` continues a task under the same lease. */
  const task = async (overrides, continued) => {
    let taskId = continued?.ref.taskId
    if (!taskId) {
      const site = await db.site.create({
        data: {
          workspaceId,
          name: `${name} site`,
          url: `https://${randomUUID()}.invalid`,
          stack: 'wordpress',
        },
      })
      const record = await db.task.create({
        data: { workspaceId, siteId: site.id, status: 'running', modelClass: 'standard' },
      })
      await db.siteLease.create({
        data: {
          siteId: site.id,
          holderTaskId: record.id,
          epoch: 1,
          operation: 'turn',
          expiresAt: new Date(Date.now() + 1_200_000),
        },
      })
      taskId = record.id
    }
    return {
      ref: {
        taskId,
        sessionId: randomUUID(),
        turn: continued ? continued.ref.turn + 1 : 1,
        epoch: 1,
      },
      grant: {
        driverId: 'opencode',
        backend: offer.backend,
        modelSlug: PROFILE,
        modelClass: 'standard',
        reasoningEffort: 'high',
        ttlMs: 600_000,
        deadlineAt: new Date(Date.now() + 1_200_000).toISOString(),
        budgetRub: '135.00',
        boundSource: null,
        ...overrides,
      },
    }
  }
  const issue = (item) => core.call('issue', { ref: item.ref, grant: item.grant })
  /** A task with the key and the token it was issued: both are searched for at the end. */
  const keep = (item, values) => {
    secretMarkers.add(values.llmApiKey)
    secretMarkers.add(values.mcpToken)
    const turn = { ...item, values }
    refs.push(turn)
    return turn
  }
  const issued = async (overrides, continued) => {
    const item = await task(overrides, continued)
    return keep(item, await issue(item))
  }
  // An account takes one turn at a time: a scenario gives its key back before the next one.
  const revoke = (turn) => core.call('revoke', { ref: turn.ref })
  const keyRow = (turn) =>
    db.llmKey.findFirstOrThrow({ where: { taskId: turn.ref.taskId, turnNo: turn.ref.turn } })
  const calls = (turn) =>
    db.llmCall.findMany({
      where: { key: { taskId: turn.ref.taskId, turnNo: turn.ref.turn } },
      include: { tokenUsage: true },
      orderBy: { startedAt: 'asc' },
    })
  const settled = (turn, count) =>
    eventually(async () => {
      const rows = await calls(turn)
      return rows.length === count && rows.every((row) => row.state !== 'open') ? rows : null
    }, 20_000)
  const waiting = (item) =>
    assert.rejects(issue(item), (error) => error.code === 'SUBSCRIPTION_WAIT')
  /** One generation asked of the role itself, from this host: the answer as it comes. */
  const roleRequest = (turn, { body = zaiForms.body(), signal } = {}) =>
    fetch(`http://127.0.0.1:${stack.llmPort}${offer.route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${turn.values.llmApiKey}`,
        'content-type': 'application/json',
        'user-agent': zaiForms.userAgent,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(25_000),
    })
  /** One request through sandbox-gw, as the sandbox would send it, on the route of the offer. */
  const chat = (turn, { headers = {}, messages, path = offer.route } = {}) =>
    cli.request({
      key: turn.values.llmApiKey,
      path,
      headers: {
        'content-type': 'application/json',
        'user-agent': opencodeUserAgent,
        ...headers,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 32_000,
        messages: messages ?? [{ role: 'user', content: 'Synthetic request.' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
  const roleLog = () => ctx.llmGetter().logs.join('')
  const metric = async (metricName) => {
    const response = await fetch(`http://127.0.0.1:${stack.llmPort}/metrics`, {
      headers: { authorization: `Bearer ${metricsToken}` },
    })
    assert.equal(response.status, 200)
    // The registry of a role may label every sample with the role.
    const value = new RegExp(String.raw`^${metricName}(?:\{[^}]*\})? (\d+)$`, 'm').exec(
      await response.text(),
    )
    assert.ok(value, `The role does not report ${metricName}`)
    return Number(value[1])
  }

  const imageId = (
    await run('docker', ['image', 'inspect', '--format', '{{.Id}}', CLI_IMAGE])
  ).stdout.trim()
  const driver = createOpencodeDriver({ image: `raditi-p3verify-cli@${imageId}` })
  const tools = await productionMcpTools()
  const version = await dockerCommand(['exec', cli.containerName, 'opencode', '--version'])
  assert.equal(version.stdout.trim(), '1.18.34', 'The CLI image holds another OpenCode')
  const instructionsMarker = `B13_ZAI_INSTRUCTIONS_${promptMarker.slice(-12)}`
  const instructions = `# Raditi platform rules (synthetic)\n${instructionsMarker}: work only inside the repository.\n`
  // The search is not blind to the session database of the CLI, the one thing a turn leaves to
  // the next: a marker among binary bytes, where the CLI keeps that database, must be found.
  const binaryMarker = `B13_ZAI_BINARY_${randomUUID()}`
  const binaryFile = `${HOME}/.local/share/opencode/zai-search-control.db`
  /**
   * The files of the sandbox that hold one of the strings, binary files as well. The strings
   * reach grep on its input, never as an argument of a process. Every search writes the
   * control file again (each turn starts with a new home) and must list it; a file or a
   * directory grep may not read fails the search instead of being skipped.
   */
  const filesHolding = async (needles) => {
    const planted = await dockerCommand([
      'exec',
      cli.containerName,
      'node',
      '-e',
      String.raw`const fs=require('node:fs'),path=require('node:path');
fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true,mode:0o700});
fs.writeFileSync(process.argv[1],Buffer.concat([Buffer.from('SQLite format 3\0\0\u0001'),
  Buffer.from(process.argv[2]),Buffer.from([0,255,0])]),{mode:0o600})`,
      binaryFile,
      binaryMarker,
    ])
    assert.equal(planted.code, 0, 'The control file of the search could not be written')
    const search = filesHoldingSearch([binaryMarker, ...needles], SANDBOX_ROOTS)
    const files = filesHoldingResult(
      await dockerCommand(['exec', '-i', cli.containerName, ...search.argv], {
        input: search.input,
      }),
    )
    assert.ok(files.includes(binaryFile), 'The search does not see the home of the CLI')
    return files.filter((file) => file !== binaryFile)
  }
  assert.deepEqual(await filesHolding(PROVIDER_KEYS), [])

  /**
   * One turn the way production runs it: the driver's prepare and command, the executor's
   * checks, a home that holds nothing but the session state, then exactly that in the CLI
   * container, through sandbox-gw to the role llm and to the MCP route. `provider` are the
   * requests of the turn on the chat path of the offer, `requests` all it sent to the fake.
   */
  async function runTurn({
    turn,
    prompt,
    nativeSessionId,
    model = MODEL,
    timeoutMs = 120_000,
    reasoningEffort = 'high',
  }) {
    const { files, argv } = await prepareOpencodeTurn(
      { cli, control, driver, tools, instructions },
      {
        turn,
        prompt,
        nativeSessionId,
        // The level is the gateway's to set, from the profile of the key; the driver only
        // refuses to launch without one.
        llm: { baseUrl: offer.gatewayBaseUrl, model, reasoningEffort },
      },
    )
    const before = await zai()
    const mcpBefore = (await control('state')).mcp.requests.length
    const started = Date.now()
    const result = await cli.runPrepared({ ...files, argv, timeoutMs })
    const ms = Date.now() - started
    outputs.push(result.stdout, result.stderr)
    // Before the next turn wipes this home: what the CLI stored of the answers it was given,
    // its session database and the journal of it, holds no provider key. A turn that ran out
    // of time or output has lost its container: the caller reports that outcome, not the search.
    if (!result.timedOut && !result.exceeded)
      assert.deepEqual(
        await filesHolding(PROVIDER_KEYS),
        [],
        'A provider key is in a file of the sandbox',
      )
    const events = result.stdout.split('\n').flatMap((line) => driver.parseEvent(line))
    for (const line of result.lines) {
      const error = line?.type === 'error' ? line.error : undefined
      if (!error) continue
      // A refused request carries the body of the answer; a refusal inside a stream is the
      // error object itself, as JSON in the message.
      if (error.name === 'APIError')
        refusals.push({
          status: error.data?.statusCode,
          body: String(error.data?.responseBody ?? ''),
          message: String(error.data?.message ?? ''),
        })
      else refusals.push({ stream: String(error.data?.message ?? '') })
    }
    const after = await zai()
    const requests = after.requests.slice(before.requests.length)
    return {
      ...result,
      ms,
      events,
      nativeSessionId: events.find((event) => event.type === 'started')?.nativeSessionId,
      result: driver.extractResult(events, null),
      provider: requests.filter((request) => request.path === offer.providerPath),
      requests,
      quotaRequests: after.counters.quota - before.counters.quota,
      mcp: (await control('state')).mcp.requests.slice(mcpBefore),
    }
  }
  /** A turn that must end at once: exit code 1 within ten seconds, the CLI asking once. */
  const refused = async (turn, options = {}) => {
    const outcome = await runTurn({ turn, prompt: 'Synthetic refused turn.', ...options })
    assert.equal(outcome.code, 1, `The refused turn ended with exit ${outcome.code}`)
    assert.ok(outcome.ms < 10_000, `The refused turn took ${outcome.ms} ms`)
    assert.equal(outcome.result, null)
    assert.ok(outcome.events.some((event) => event.type === 'failed'))
    return outcome
  }

  /**
   * A turn whose first request gets a short-lived refusal (1302): OpenCode repeats it after the
   * pause and the turn finishes with `summary`. The key is given back at the end.
   */
  const repeatedAfterShortRefusal = async (summary) => {
    const retried = await issued()
    const retriedResult = resultFor(summary)
    await zai({
      scenario: {
        scenario: 'error',
        code: 1302,
        retryAfter: '1',
        failures: 1,
        text: JSON.stringify(retriedResult),
      },
    })
    const repeat = await runTurn({ turn: retried, prompt: 'Synthetic turn with one busy answer.' })
    assert.equal(repeat.code, 0, `The repeated turn failed with exit ${repeat.code}`)
    assert.deepEqual(repeat.result, retriedResult)
    // The provider was asked twice: the account's pause held the CLI's earlier retries back.
    assert.equal(repeat.provider.length, 2)
    assert.ok(repeat.ms >= 25_000 && repeat.ms < 90_000, `The repeat took ${repeat.ms} ms`)
    // One call was refused and one answered; the journal of the key keeps the refusal after
    // the later success.
    const repeatRows = await settled(retried, 2)
    assert.equal(repeatRows.filter((row) => row.state === 'completed').length, 1)
    assert.equal((await keyRow(retried)).lastRefusal, 'transient')
    await revoke(retried)
  }

  return {
    offer,
    driver,
    tools,
    instructionsMarker,
    refs,
    refusals,
    outputs,
    task,
    issue,
    keep,
    issued,
    revoke,
    keyRow,
    calls,
    settled,
    waiting,
    roleRequest,
    chat,
    roleLog,
    metric,
    filesHolding,
    runTurn,
    refused,
    repeatedAfterShortRefusal,
  }
}
