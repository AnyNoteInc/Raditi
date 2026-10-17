// The Z.ai plan group of B13: the real pinned OpenCode CLI, started only through its driver's
// prepare + command, on the path sandbox → sandbox-gw → role llm → synthetic Z.ai. The role
// reaches the fake on a connection of its own (no egress proxy in its configuration), as it
// reaches api.z.ai in the product; one turn before that goes through the stand's proxy, which
// stays the way of every provider once a proxy is configured. The scenarios of the platform —
// protocol boundaries, failures inside a stream, crash barriers, the lifecycle of the pool —
// run here as well, once for the whole stand: the group hands them its ids and forms as data.
// The API group (verify-llm-zai-api.mjs) follows with what differs on the other offer.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { turnResultSchema } from '@repo/domain'

import { dockerCommand } from '../../../infra/dev/llm-verify/cli.mjs'
import { SYNTHETIC_MCP_MARKER } from '../../../infra/dev/llm-verify/fake-subscriptions.mjs'
import {
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_MARKER,
  SYNTHETIC_ZAI_ROTATED_KEY,
  ZAI_PATHS,
} from '../../../infra/dev/llm-verify/fake-zai.mjs'
import { sumUsage } from '../../../infra/dev/llm-verify/live.mjs'
import { eventually } from '../../../infra/dev/llm-verify/stack.mjs'
import { localVaultRequest } from '../../../infra/vault/bootstrap.mjs'
import { opencodeUserAgent } from '../../../packages/llm-backends/src/zai-coding/backend.ts'
import {
  cliReadsOverflow,
  cliRetriesHttp,
  cliRetriesStreamError,
} from '../../../packages/llm-backends/src/zai-coding/fixtures/opencode-cli.ts'
import { verifyCrashes } from './verify-llm-crashes.mjs'
import { verifyStreamFailures } from './verify-llm-gateway-stream.mjs'
import { verifyEmergencyRetirement, verifyLifecycle } from './verify-llm-lifecycle.mjs'
import { verifyProtocol } from './verify-llm-protocol.mjs'
import {
  bash,
  createZaiHarness,
  PROVIDER_HEADERS,
  PROVIDER_KEYS,
  resultFor,
} from './verify-llm-zai-harness.mjs'
import { zaiForms } from './verify-llm-zai-forms.mjs'
import {
  switchOnZai,
  ZAI_BACKEND as BACKEND,
  ZAI_MODEL as MODEL,
  ZAI_OFFERS,
  zaiDirectEnvironment,
  zaiLogin,
  zaiOperator,
} from './verify-llm-zai-setup.mjs'

const LABEL = 'synthetic-zai'
// What the fake counts for every answer unless a scenario names other numbers.
const FAKE_USAGE = zaiForms.usage

export async function verifyZai(ctx) {
  const { db, core, stack, cli, control, passed, llmSecrets, restartLlm, llmGetter } = ctx
  const { promptMarker, writerFile, setStage } = ctx
  const { writer, admin, coreSecrets } = ctx
  const zai = (body) => control('zai', body)
  const directEnv = zaiDirectEnvironment(ctx.env, stack)
  const operator = zaiOperator(stack, directEnv.LLM_UPSTREAM_CA_FILE)
  /** Tunnels to api.z.ai the stand's proxy has ended: it logs each one when it ends. */
  const proxyTunnels = async () =>
    (await stack.compose(['logs', '--no-color', 'llm-egress'])).stdout
      .split('\n')
      .filter((line) => line.includes('"event":"connect"') && line.includes('"api.z.ai:443"'))
      .length
  const account = () => db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
  const windows = async () =>
    Object.fromEntries((await account()).limitWindows.map((window) => [window.name, window]))

  setStage('import of the plan key on the direct path')
  await zai({ reset: true })
  // A key the provider does not know never becomes an account.
  const foreign = await zaiLogin(operator, {
    label: 'synthetic-zai-foreign',
    writerFile,
    key: 'zai-synthetic-foreign-key',
  })
  assert.equal(foreign.code, 1)
  assert.equal(
    await db.subscriptionAccount.count({ where: { label: 'synthetic-zai-foreign' } }),
    0,
    'A refused plan key left an account',
  )
  const imported = await zaiLogin(operator, { label: LABEL, writerFile, key: SYNTHETIC_ZAI_KEY })
  assert.equal(imported.code, 0, 'The import of the synthetic plan key failed')
  const { accountId } = JSON.parse(imported.stdout)
  assert.deepEqual(JSON.parse(imported.stdout), {
    accountId,
    backend: BACKEND,
    credentialVersion: 1,
    enabled: false,
  })
  assert.equal(`${imported.stdout}${imported.stderr}`.includes(SYNTHETIC_ZAI_KEY), false)
  assert.partialDeepStrictEqual(await account(), {
    driverId: 'opencode',
    plan: 'lite',
    health: 'ok',
    enabled: false,
    // The settings of the operator command for this backend; П4 of the pivot plan.
    maxConcurrentTurns: 1,
    maxConcurrentRequests: 2,
  })
  // The import asked the quota and nothing else, with the key it was given, without a proxy.
  let state = await zai()
  assert.ok(state.requests.length >= 2)
  for (const request of state.requests)
    assert.deepEqual([request.method, request.path], ['GET', ZAI_PATHS.quota])
  assert.equal(state.requests[0].credential, 'other')
  assert.equal(state.requests.at(-1).credential, 'plan-key')
  // What the foreign key asked: every later request with a key the provider does not take is
  // counted against this at the end.
  const foreignRequests = state.requests.filter((request) => request.credential === 'other').length
  assert.equal(await proxyTunnels(), 0)
  passed('Z.ai plan key import by the operator command on the direct path; a foreign key refused')

  setStage('Vault policy boundaries')
  // The secret of the account is the role llm's to read — never to write — and nobody's to
  // list or destroy but the admin's; the import wrote it and cannot read it back.
  const secretPath = `subs/${BACKEND}/${accountId}`
  await assert.rejects(writer.kvRead(secretPath), (error) => error.status === 403)
  await assert.rejects(llmSecrets.kvMetadata(secretPath), (error) => error.status === 403)
  await assert.rejects(coreSecrets.kvRead(secretPath), (error) => error.status === 403)
  await assert.rejects(llmSecrets.kvDestroyAll(secretPath), (error) => error.status === 403)
  await assert.rejects(llmSecrets.kvDelete(secretPath), (error) => error.status === 403)
  assert.notEqual(await llmSecrets.kvRead(secretPath), null)
  for (const mount of ['subs', 'turns']) {
    const configuration = await stack.request(`${mount}/config`)
    assert.equal(configuration.data.max_versions, 1)
    assert.equal(configuration.data.cas_required, true)
  }
  const versionPath = `subs/${BACKEND}/synthetic-version-check`
  await assert.rejects(writer.kvWrite(versionPath, { value: 'first' }))
  await writer.kvWrite(versionPath, { value: 'first' }, { cas: 0 })
  // The role reads the secrets of subs/ and writes none, with the right CAS as well.
  await assert.rejects(
    llmSecrets.kvWrite(versionPath, { value: 'second' }, { cas: 1 }),
    (error) => error.status === 403,
  )
  assert.equal((await llmSecrets.kvRead(versionPath)).version, 1)
  // A new key of an account is the writer's (a relogin), and the old version is gone for good.
  await writer.kvWrite(versionPath, { value: 'second' }, { cas: 1 })
  assert.equal((await llmSecrets.kvRead(versionPath)).version, 2)
  const historical = await localVaultRequest(
    stack.root,
    `subs/data/${BACKEND}/synthetic-version-check?version=1`,
  )
  assert.equal(historical.status, 404)
  await admin.kvDestroyAll(versionPath)
  passed('distinct Vault capabilities, mandatory CAS and destruction of prior versions')

  setStage('provider, profile, rate and driver rows')
  // The operator switches the account on; its windows are nobody's to write but a probe's.
  await switchOnZai(db, { accountId, ratesUrl: 'https://synthetic.invalid/b13-rates' })
  const workspace = await db.workspace.create({
    data: { name: 'B13 synthetic Z.ai workspace', dataClass: 'synthetic' },
  })

  /** The role afresh, without a proxy: its probe memory and account pauses are gone. */
  const direct = (overrides = {}) => restartLlm({ ...directEnv, ...overrides })

  setStage('the driver and the CLI container')
  const harness = await createZaiHarness(ctx, {
    offer: ZAI_OFFERS.plan,
    workspaceId: workspace.id,
    name: 'B13 synthetic Z.ai',
  })
  const { refs, refusals, outputs, instructionsMarker } = harness
  const { task, issue, keep, issued, revoke, keyRow, calls, settled, waiting } = harness
  const { roleRequest, chat, roleLog, metric, filesHolding, runTurn, refused } = harness

  setStage('first key after an idle night, through the proxy')
  // Nobody wrote the windows: core reads them as unknown, asks the role for a probe and
  // selects on what the probe stored. The five-hour window is one nobody has started.
  assert.equal((await account()).limitWindows?.length ?? 0, 0)
  const proxied = await issued()
  assert.deepEqual((await windows())['5h'], { name: '5h', usedPct: 0, resetsAt: null })
  assert.ok((await windows()).week.usedPct > 0 && (await windows()).week.usedPct < 1)
  // The key is durable: recovered and issued again it is the same one. The only account is
  // healthy but holds its one turn: occupied slots, not missing capacity.
  assert.deepEqual(await core.call('recover', { ref: proxied.ref }), proxied.values)
  assert.deepEqual(await issue(proxied), proxied.values)
  await assert.rejects(issue(await task()), (error) => error.code === 'SUBSCRIPTION_BUSY')
  passed('durable issuance, recovery and one-turn capacity of the account')
  const proxiedResult = resultFor('B13 OpenCode through the proxy')
  await zai({ scenario: { scenario: 'text', text: JSON.stringify(proxiedResult) } })
  const throughProxy = await runTurn({ turn: proxied, prompt: `${promptMarker}. Answer.` })
  assert.equal(throughProxy.code, 0, `The proxied turn failed with exit ${throughProxy.code}`)
  assert.deepEqual(throughProxy.result, proxiedResult)
  assert.equal(throughProxy.provider.length, 1)
  // The stand's proxy logs a tunnel when it ends, and a tunnel ends with its exchange: the
  // probe that wrote the windows and the generation, and no other.
  await eventually(async () => (await proxyTunnels()) >= 2).catch(() =>
    assert.fail('The proxy has not ended the tunnels of the probe and of the generation'),
  )
  await settled(proxied, 1)
  await revoke(proxied)
  passed(
    'first Z.ai key after an idle window: the windows come from a probe; an OpenCode turn through the configured proxy',
  )

  setStage('driver-prepared OpenCode turns on the direct path')
  await direct()
  // Both tunnels of the role that had the proxy have ended and are in the log of the proxy:
  // from here on none opens.
  const tunnels = await proxyTunnels()
  assert.equal(tunnels, 2, 'The proxied role opened another tunnel than its probe and its turn')
  const first = await issued()
  const firstResult = resultFor('B13 OpenCode exec', ['zai-first.txt', 'zai-second.txt'])
  await zai({
    scenario: {
      scenario: 'tools',
      rounds: [
        [bash("printf 'synthetic-one\\n' > zai-first.txt")],
        [
          bash("printf 'synthetic-two\\n' > zai-second.txt"),
          { name: 'raditi_site_info', arguments: {} },
        ],
      ],
      text: JSON.stringify(firstResult),
    },
  })
  const exec = await runTurn({
    turn: first,
    prompt: `${promptMarker}. Complete the synthetic task using the requested tools.`,
  })
  assert.equal(exec.code, 0, `Driver OpenCode exec failed with exit ${exec.code}`)
  assert.ok(exec.nativeSessionId, 'OpenCode session id is missing')
  assert.deepEqual(exec.result, firstResult)
  assert.ok(turnResultSchema.safeParse(exec.result).success)
  for (const [name, text] of [
    ['zai-first.txt', 'synthetic-one\n'],
    ['zai-second.txt', 'synthetic-two\n'],
  ]) {
    const read = await dockerCommand(['exec', cli.containerName, 'cat', `/workspace/repo/${name}`])
    assert.equal(read.stdout, text, `${name} was not written by the CLI`)
  }
  assert.equal(exec.provider.length, 3)
  for (const request of exec.provider) {
    const { body } = request
    assert.equal(body.model, MODEL)
    // The profile of the turn key, not the CLI: the driver's configuration names no level.
    assert.equal(body.reasoning_effort, 'high')
    assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
    assert.ok(body.max_tokens <= 32_000)
    assert.equal(body.stream, true)
    assert.equal(body.stream_options?.include_usage, true)
    assert.ok(
      body.tools.some((tool) => tool.function?.name === 'raditi_site_info'),
      'OpenCode did not declare the platform MCP tool',
    )
    assert.ok(JSON.stringify(body).includes(instructionsMarker), 'Platform instructions missing')
  }
  for (const method of ['initialize', 'tools/list'])
    assert.ok(
      exec.mcp.some((request) => request.rpc === method),
      `MCP ${method} missing`,
    )
  assert.ok(exec.mcp.every((request) => request.authorized))
  assert.ok(
    exec.mcp.some((request) => request.rpc === 'tools/call' && request.tool === 'site_info'),
  )
  // The driver reports the platform tool by its own name, without the CLI's `<server>_` prefix.
  // Sorted: the two calls of one answer end in the order the CLI ran them.
  assert.deepEqual(
    exec.events
      .filter((event) => event.type === 'tool_call')
      .map(({ tool, ok }) => `${tool} ${ok}`)
      .sort(),
    ['bash true', 'bash true', 'site_info true'],
  )
  // The tool's answer went back to the model through the body policy of the gateway.
  assert.ok(
    JSON.stringify(exec.provider.at(-1).body).includes(SYNTHETIC_MCP_MARKER),
    'The MCP tool output never reached the provider',
  )
  // The usage of every call is the provider's own count, not an estimate.
  for (const row of await settled(first, 3)) {
    assert.equal(row.state, 'completed')
    assert.partialDeepStrictEqual(row.tokenUsage, {
      ...FAKE_USAGE,
      estimated: false,
      billable: true,
    })
  }
  // No tunnel was opened since the role lost its proxy: the fake was reached directly.
  assert.equal(await proxyTunnels(), tunnels)
  passed(
    'driver-prepared OpenCode exec on the direct path: two tool rounds, an MCP tool, provider usage in llm_calls',
  )

  const secondResult = resultFor('B13 OpenCode resume')
  await zai({ scenario: { scenario: 'text', text: JSON.stringify(secondResult) } })
  const resume = await runTurn({
    turn: first,
    prompt: 'Continue the synthetic task: sum it up.',
    nativeSessionId: exec.nativeSessionId,
  })
  assert.equal(resume.code, 0, `Driver OpenCode resume failed with exit ${resume.code}`)
  assert.equal(resume.nativeSessionId, exec.nativeSessionId)
  assert.deepEqual(resume.result, secondResult)
  assert.equal(resume.provider.length, 1)
  assert.ok(
    JSON.stringify(resume.provider[0].body).includes(promptMarker),
    'The resumed OpenCode session lost its history',
  )
  await settled(first, 4)
  passed('driver-prepared OpenCode resume from the two session files alone')

  // A step that reports the context as nearly full makes the CLI ask for a compaction: a
  // request of its own shape, without tools, which the body policy must let through.
  const compactResult = resultFor('B13 OpenCode compaction')
  await zai({
    scenario: {
      scenario: 'tools',
      calls: [bash('printf compact')],
      text: JSON.stringify(compactResult),
      usage: { prompt: 990_000 },
      failures: 1,
    },
  })
  const compact = await runTurn({ turn: first, prompt: 'Run the synthetic step, then answer.' })
  assert.equal(compact.code, 0, `The turn with a compaction failed with exit ${compact.code}`)
  assert.deepEqual(compact.result, compactResult)
  const compaction = compact.provider.filter((request) => request.body.tools === undefined)
  assert.equal(compaction.length, 1, 'The CLI sent no compaction request')
  assert.equal(compaction[0].body.tool_choice, undefined)
  assert.equal(compaction[0].status, 200)
  assert.equal(compaction[0].body.reasoning_effort, 'high')
  assert.equal(compact.provider.length, 3)
  await settled(first, 7)
  await revoke(first)
  passed('the context compaction request of OpenCode passes the body policy')

  // An answer that says a sentence beside its tool call: the form the real model gave in the
  // live content run (docs/plan/45-zai-live.md) and no other scenario of the stand has. The
  // usage is what the provider counted for the recorded answer of that form.
  const besideTurn = await issued()
  const besideResult = resultFor('B13 OpenCode text beside a tool call')
  const sentence = 'The site information comes first; the result follows.'
  await zai({
    scenario: {
      scenario: 'tools',
      calls: [{ name: 'raditi_site_info', arguments: {} }],
      beside: sentence,
      text: JSON.stringify(besideResult),
      usage: { prompt: 5084, cached: 4928, completion: 436, reasoning: 266 },
    },
  })
  const beside = await runTurn({
    turn: besideTurn,
    prompt: 'Read the synthetic site information, then answer.',
  })
  assert.equal(beside.code, 0, `The turn with text beside a tool call failed: ${beside.code}`)
  assert.deepEqual(beside.result, besideResult)
  assert.equal(beside.provider.length, 2)
  // The call was made once, and the driver reports it once.
  assert.deepEqual(
    beside.mcp.filter((request) => request.rpc === 'tools/call').map((request) => request.tool),
    ['site_info'],
  )
  assert.deepEqual(
    beside.events.filter((event) => event.type === 'tool_call'),
    [{ type: 'tool_call', tool: 'site_info', ok: true }],
  )
  // The sentence reached the platform as a message of its own; the result is the last one.
  assert.deepEqual(
    beside.events.filter((event) => event.type === 'message').map((event) => event.text.trim()),
    [sentence, JSON.stringify(besideResult)],
  )
  // The CLI sent the sentence back next to its call, and the body policy let that message pass.
  const besideStep = beside.provider[1].body.messages.findLast(
    (message) => message.role === 'assistant',
  )
  assert.equal(JSON.stringify(besideStep.content).includes(sentence), true)
  assert.equal(besideStep.tool_calls.length, 1)
  // Both calls were counted by the provider's numbers, and they add up to what the CLI printed.
  const besideRows = await settled(besideTurn, 2)
  const besideUsage = sumUsage(
    besideRows.map(({ tokenUsage }) => ({
      inputUncached: tokenUsage.inputUncachedTokens,
      cacheRead: tokenUsage.cacheReadTokens,
      cacheWrite: tokenUsage.cacheWriteTokens,
      output: tokenUsage.outputTokens,
      reasoning: tokenUsage.reasoningTokens,
    })),
  )
  assert.ok(besideRows.every((row) => row.state === 'completed' && !row.tokenUsage.estimated))
  assert.deepEqual(besideUsage, {
    inputUncached: 2 * (5084 - 4928),
    cacheRead: 2 * 4928,
    cacheWrite: 0,
    output: 2 * 436,
    reasoning: 2 * 266,
  })
  assert.deepEqual(
    sumUsage(beside.events.filter((event) => event.type === 'usage').map((event) => event.usage)),
    besideUsage,
  )
  await revoke(besideTurn)
  passed(
    'text beside a tool call in one answer: the tool was called once, the sentence came as a message, the turn ended with its result, llm_calls equal the usage of the CLI',
  )

  setStage('final refusals of the gateway')
  // Each ends the turn in one request: the role counts one request and the provider none.
  const final = async (name, expected, arrange, options) => {
    const turn = await issued()
    const restore = await arrange?.(turn)
    const requests = await metric('raditi_llm_requests_total')
    const outcome = await refused(turn, options)
    assert.equal(outcome.provider.length, 0, `${name}: the provider was asked`)
    assert.equal((await metric('raditi_llm_requests_total')) - requests, 1, `${name}: retried`)
    const refusal = refusals.at(-1)
    assert.equal(refusal.status, expected.status, name)
    assert.equal(JSON.parse(refusal.body).error.code, expected.code, name)
    await restore?.()
    await revoke(turn).catch(() => {})
    return { turn, refusal }
  }
  await final('spent budget', { status: 403, code: 'raditi_budget' }, (turn) =>
    db.llmKey
      .updateMany({
        where: { taskId: turn.ref.taskId },
        data: { budgetRub: '0.0100000000' },
      })
      .then(() => undefined),
  )
  await final('revoked key', { status: 401, code: 'raditi_key' }, async (turn) => {
    await revoke(turn)
  })
  const foreignModel = await final(
    'a model of another profile',
    { status: 400, code: 'raditi_policy' },
    undefined,
    { model: 'glm-5.3-flash' },
  )
  assert.equal(JSON.parse(foreignModel.refusal.body).error.field, 'model')
  // A level the adapter does not know in the profile of the key: no request of it can pass.
  const level = await issued({ reasoningEffort: 'medium' })
  const levelRequests = await metric('raditi_llm_requests_total')
  const levelOutcome = await refused(level)
  assert.equal(levelOutcome.provider.length, 0)
  assert.equal((await metric('raditi_llm_requests_total')) - levelRequests, 1)
  assert.equal(JSON.parse(refusals.at(-1).body).error.code, 'raditi_policy')
  await revoke(level)
  await final('an account switched off', { status: 403, code: 'raditi_account' }, async () => {
    await db.subscriptionAccount.update({ where: { id: accountId }, data: { enabled: false } })
    return () =>
      db.subscriptionAccount.update({ where: { id: accountId }, data: { enabled: true } })
  })
  passed(
    'final gateway refusals (budget, revoked key, foreign model, profile level, account): one request, exit 1 within 10 s',
  )

  setStage('refusals of the provider by its codes')
  for (const [code, status, refusal, logged] of [
    [1211, 400, 'profile', 'zai_1211'],
    [1301, 400, 'policy_flagged', 'zai_1301'],
    [1261, 400, 'request_rejected', 'zai_1261'],
    [1113, 403, 'account', 'zai_1113'],
    [401, 403, 'account', null],
    // A code nobody has listed: the turn ends, the role reads the quota, the log keeps the code.
    [1399, 403, 'account', 'zai_1399'],
  ]) {
    // One confirmation answers the signals of five minutes: a role afresh shows that the
    // unlisted code asks for its own.
    if (code === 1399) await direct()
    const turn = await issued()
    await zai({ scenario: { scenario: 'error', code, ...(code === 1399 ? { status: 429 } : {}) } })
    const quotaBefore = (await zai()).counters.quota
    const outcome = await refused(turn)
    assert.equal(outcome.provider.length, 1, `code ${code}: the provider was asked again`)
    assert.equal(refusals.at(-1).status, status, `code ${code}`)
    assert.equal(JSON.parse(refusals.at(-1).body).error.code, `raditi_${refusal}`, `code ${code}`)
    assert.equal((await keyRow(turn)).lastRefusal, refusal, `code ${code}`)
    await settled(turn, 1)
    if (logged)
      await eventually(async () => roleLog().includes(`"code":"${logged}"`), 10_000).catch(() =>
        assert.fail(`The log of the role lacks ${logged}`),
      )
    if (code === 1399) {
      await eventually(async () => (await zai()).counters.quota > quotaBefore, 10_000).catch(() =>
        assert.fail('The role did not read the quota after an unlisted code'),
      )
      assert.equal((await zai()).counters.quota - quotaBefore, 1)
    }
    await revoke(turn)
  }
  // None of them was confirmed by the quota: the account is as it was.
  assert.partialDeepStrictEqual(await account(), {
    health: 'ok',
    enabled: true,
    coolingUntil: null,
  })
  passed(
    'provider refusals by the code table (1211, 1301, 1261, 1113, 401, an unlisted code): one request each, the code in the log',
  )

  setStage('short-lived refusal, repeated by the CLI')
  await direct()
  const retried = await issued()
  const retriedResult = resultFor('B13 OpenCode after a short-lived refusal')
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
  passed(
    'a short-lived provider refusal is repeated by OpenCode after the pause and the turn finishes',
  )

  setStage('streams the CLI cannot stop on')
  await direct()
  for (const scenario of [
    { scenario: 'done_only' },
    { scenario: 'finish', finish: 'later_value' },
  ]) {
    const turn = await issued()
    await zai({ scenario })
    const outcome = await refused(turn)
    assert.equal(outcome.provider.length, 1, `${scenario.scenario}: asked again`)
    assert.equal(JSON.parse(refusals.at(-1).stream).code, 'raditi_account')
    assert.equal((await keyRow(turn)).lastRefusal, 'account')
    await revoke(turn)
  }
  // A connection cut before the usage: the CLI repeats it with its own pauses, and finishes.
  const cut = await issued()
  const cutResult = resultFor('B13 OpenCode after a cut stream')
  await zai({ scenario: { scenario: 'cut', failures: 1, text: JSON.stringify(cutResult) } })
  const afterCut = await runTurn({ turn: cut, prompt: 'Synthetic turn with one cut answer.' })
  assert.equal(afterCut.code, 0, `The turn after a cut failed with exit ${afterCut.code}`)
  assert.deepEqual(afterCut.result, cutResult)
  assert.equal(afterCut.provider.length, 2)
  const cutRows = await settled(cut, 2)
  // The cut call is an estimate nobody is billed for; it still counts against the key.
  assert.partialDeepStrictEqual(cutRows[0], { state: 'failed' })
  assert.partialDeepStrictEqual(cutRows[0].tokenUsage, { estimated: true, billable: false })
  await revoke(cut)
  // A finished answer without DONE is passed on as it is; the CLI takes it for the answer.
  const undone = await issued()
  const undoneResult = resultFor('B13 OpenCode without DONE')
  await zai({ scenario: { scenario: 'no_done', text: JSON.stringify(undoneResult) } })
  const afterUndone = await runTurn({ turn: undone, prompt: 'Synthetic turn without DONE.' })
  assert.equal(afterUndone.code, 0, `The turn without DONE failed with exit ${afterUndone.code}`)
  assert.deepEqual(afterUndone.result, undoneResult)
  assert.equal(afterUndone.provider.length, 1, 'The CLI asked again after an answer without DONE')
  const [undoneCall] = await settled(undone, 1)
  assert.partialDeepStrictEqual(undoneCall.tokenUsage, { ...FAKE_USAGE, estimated: false })
  await revoke(undone)
  passed(
    'DONE alone and an unknown finish_reason end the turn in one request; a cut stream is repeated and the turn finishes; a finished answer without DONE is the answer',
  )

  setStage('HTTP 200 without a stream')
  // The envelope of the monitor paths on the chat path: the gateway never passes it on.
  const envelope = await issued()
  const envelopeResult = resultFor('B13 OpenCode after an envelope')
  await zai({
    scenario: {
      scenario: 'envelope200',
      code: 500,
      failures: 1,
      text: JSON.stringify(envelopeResult),
    },
  })
  const afterEnvelope = await runTurn({
    turn: envelope,
    prompt: 'Synthetic turn with an envelope.',
  })
  assert.equal(afterEnvelope.code, 0, `The turn after an envelope failed: ${afterEnvelope.code}`)
  assert.deepEqual(afterEnvelope.result, envelopeResult)
  assert.ok(afterEnvelope.provider.length <= 6)
  assert.equal(afterEnvelope.provider.length, 2)
  assert.partialDeepStrictEqual(await account(), {
    health: 'ok',
    coolingUntil: null,
    breakerOpenUntil: null,
    usageMissingStreak: 0,
  })
  await revoke(envelope)
  // A finished answer as one JSON object, with usage: one request from the sandbox shows what
  // the CLI would get. The call is an estimate and takes its share of the key's budget.
  const plain = await issued()
  await zai({ scenario: { scenario: 'plain200' } })
  const plainAnswer = await chat(plain)
  assert.equal(plainAnswer.status, 503)
  assert.equal(plainAnswer.headers['retry-after'], '30')
  assert.equal(plainAnswer.body.includes('Synthetic Z.ai answer'), false)
  refusals.push({ status: 503, body: plainAnswer.body, message: '', transient: true })
  const [plainCall] = await settled(plain, 1)
  assert.partialDeepStrictEqual(plainCall.tokenUsage, { estimated: true, billable: false })
  assert.ok(plainCall.tokenUsage.costRub.gt(0), 'The estimate took nothing of the key budget')
  await revoke(plain)
  passed(
    'HTTP 200 without a stream: an envelope is refused as short-lived and the turn finishes; a ready answer becomes an estimate in the key budget',
  )

  setStage('usage breaker')
  await direct()
  const silent = await issued()
  for (let attempt = 1; attempt <= 3; attempt++) {
    await zai({
      scenario: {
        scenario: 'no_usage',
        text: JSON.stringify(resultFor(`B13 no usage ${attempt}`)),
      },
    })
    const outcome = await runTurn({ turn: silent, prompt: `Synthetic answer ${attempt}.` })
    assert.equal(outcome.code, 0, `The answer without usage failed with exit ${outcome.code}`)
  }
  await settled(silent, 3)
  const tripped = await account()
  assert.equal(tripped.usageMissingStreak, 3)
  assert.ok(tripped.breakerOpenUntil > new Date(Date.now() + 10 * 60_000))
  // Each of the three is an estimate, and the key gets no fourth call while the breaker is open.
  const unmetered = await db.tokenUsage.findMany({ where: { taskId: silent.ref.taskId } })
  assert.equal(unmetered.length, 3)
  assert.ok(unmetered.every((usage) => usage.estimated && usage.estimateReason === 'no_usage'))
  const fourth = await chat(silent)
  assert.equal(JSON.parse(fourth.body).error.code, 'raditi_account')
  refusals.push({ status: fourth.status, body: fourth.body, message: '' })
  assert.equal((await calls(silent)).length, 3)
  await revoke(silent)
  await waiting(await task())
  // Move the fixture past the real breaker's deadline: exactly one call is then let through as
  // a trial, and its usage closes the breaker.
  await db.subscriptionAccount.update({
    where: { id: accountId },
    data: { breakerOpenUntil: new Date(Date.now() - 1000) },
  })
  const trial = await issued()
  await zai({ scenario: zaiForms.answers.held(700) })
  const trials = await Promise.all([roleRequest(trial), roleRequest(trial)])
  for (const answer of trials) await answer.arrayBuffer()
  assert.deepEqual(trials.map((answer) => answer.status).sort(), [200, 403])
  await settled(trial, 1)
  assert.partialDeepStrictEqual(await account(), {
    usageMissingStreak: 0,
    breakerOpenUntil: null,
  })
  await revoke(trial)
  passed(
    'three answers without usage open the usage breaker of the account: estimates, no further call, no new key; one successful trial closes it',
  )

  setStage('pause of the provider and the pace of a key')
  // What the sandbox itself receives, by one request through sandbox-gw.
  const paused = await issued()
  await zai({ scenario: { scenario: 'text', retryAfter: '999999' } })
  // With a cookie and the session headers a client may send: neither goes any further.
  const sessionHeaders = {
    cookie: 'synthetic-session=1',
    'x-session-id': 'synthetic-session',
    'x-session-affinity': 'synthetic-session',
    'x-opencode-session-id': 'synthetic-session',
  }
  const answered = await chat(paused, { headers: sessionHeaders })
  assert.equal(answered.status, 200)
  assert.ok(answered.body.trimEnd().endsWith('data: [DONE]'))
  for (const name of ['retry-after', 'set-cookie', 'x-log-id', 'x-request-id', 'ga-traceid'])
    assert.equal(answered.headers[name], undefined, `${name} reached the sandbox`)
  const reached = await zai()
  const forwarded = reached.requests.at(-1)
  assert.equal(forwarded.path, ZAI_PATHS.chat)
  for (const name of Object.keys(sessionHeaders))
    assert.equal(forwarded.headerNames.includes(name), false, `${name} reached the provider`)
  // A part the body policy does not take, inside the third message: the refusal names the
  // place without the number of the item.
  const indexed = await chat(paused, {
    messages: [
      { role: 'user', content: 'Synthetic request.' },
      { role: 'assistant', content: 'Synthetic answer.' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:synthetic' } }] },
    ],
  })
  assert.equal(indexed.status, 400)
  assert.equal(JSON.parse(indexed.body).error.code, 'raditi_policy')
  assert.match(JSON.parse(indexed.body).error.field, /^messages\[\]\.content/)
  refusals.push({ status: 400, body: indexed.body, message: '' })
  // The role's own refusal of another client, and the one sandbox-gw gives a path that is
  // not on its list: final for the CLI like the others.
  const otherClient = await chat(paused, { headers: { 'user-agent': 'synthetic-cli/1.0' } })
  assert.equal(otherClient.status, 403)
  assert.equal(JSON.parse(otherClient.body).error.code, 'raditi_client')
  refusals.push({ status: 403, body: otherClient.body, message: '' })
  const otherPath = await chat(paused, { path: '/zai/v4/models' })
  assert.equal(otherPath.status, 403)
  refusals.push({ status: 403, body: otherPath.body, message: '' })
  assert.equal(
    (await zai()).counters.chat,
    reached.counters.chat,
    'A refused request reached the provider',
  )
  await zai({ scenario: { scenario: 'error', code: 1302, retryAfter: '999999' } })
  const busy = await chat(paused)
  assert.equal(busy.status, 503)
  assert.ok(Number(busy.headers['retry-after']) >= 1 && Number(busy.headers['retry-after']) <= 30)
  assert.equal(busy.body.includes(SYNTHETIC_ZAI_MARKER), false)
  refusals.push({ status: 503, body: busy.body, message: '', transient: true })
  await settled(paused, 2)
  await revoke(paused)
  passed(
    'retry-after 999999 of the provider: none on a successful answer, at most 30 s on a refusal; no provider header in the sandbox',
  )
  await direct({ LLM_MAX_CALLS_PER_KEY_30S: '3' })
  const hasty = await issued()
  await zai({
    scenario: {
      scenario: 'tools',
      rounds: Array.from({ length: 6 }, (_, step) => [bash(`printf step-${step}`)]),
      text: JSON.stringify(resultFor('B13 never reached')),
    },
  })
  const pace = await refused(hasty)
  assert.equal(pace.provider.length, 3, 'The pace of the key did not stop the fourth call')
  assert.equal(JSON.parse(refusals.at(-1).body).error.code, 'raditi_budget')
  assert.equal((await keyRow(hasty)).lastRefusal, 'budget')
  await settled(hasty, 3)
  await revoke(hasty)
  passed('the pace of a turn key stops the fourth call within 30 s with a final budget refusal')

  setStage('quota windows')
  // A spent five-hour window: the provider refuses with its code, the quota names the reset.
  await direct()
  const spent = await issued()
  await zai({ quota: { fiveHour: { exhausted: true } } })
  const reset = (await zai()).quota.fiveHour.reset
  const exhausted = await refused(spent)
  assert.equal(exhausted.provider.length, 1)
  assert.equal(JSON.parse(refusals.at(-1).body).error.code, 'raditi_subscription_limit')
  assert.equal((await keyRow(spent)).lastRefusal, 'subscription_limit')
  await eventually(async () => (await account()).coolingUntil !== null, 10_000)
  const cooling = (await account()).coolingUntil.getTime()
  assert.ok(Math.abs(cooling - (reset + 60_000)) < 2_000, 'The pause does not end at the reset')
  assert.equal((await windows())['5h'].usedPct, 100)
  // Until then nothing more is asked of the provider for this account: neither by the key
  // that was refused, nor for a new task. The account itself stays in the pool.
  const generated = (await zai()).counters.chat
  const again = await chat(spent)
  assert.equal(JSON.parse(again.body).error.code, 'raditi_subscription_limit')
  refusals.push({ status: again.status, body: again.body, message: '' })
  assert.equal((await calls(spent)).length, 1)
  assert.equal((await account()).health, 'ok')
  await revoke(spent)
  // Revocation keeps the journal of the final refusal.
  assert.equal((await keyRow(spent)).lastRefusal, 'subscription_limit')
  await waiting(await task())
  assert.equal((await zai()).counters.chat, generated)
  await zai({ quota: { fiveHour: { idle: true } } })
  await db.subscriptionAccount.update({
    where: { id: accountId },
    data: { coolingUntil: null, limitWindows: [], headroomPct: null, limitsSeenAt: null },
  })
  passed('code 1308 on a spent window: subscription_limit and a pause until the reset of the quota')

  // The windows of Z.ai come from the quota alone, so a snapshot grows old while calls run.
  // A snapshot older than ten minutes is refreshed once: when a key is issued …
  const age = () =>
    db.$executeRaw`UPDATE subscription_accounts
      SET limits_seen_at = clock_timestamp() - interval '11 minutes' WHERE id = ${accountId}::uuid`
  const fakePct = async () => {
    const window = (await zai()).quota.fiveHour
    return (Math.max(window.currentValue, 2000 - window.remaining) * 100) / 2000
  }
  await direct()
  const warm = await issued()
  await zai({ scenario: { scenario: 'text', text: JSON.stringify(resultFor('B13 warm-up')) } })
  for (let call = 0; call < 3; call++) assert.equal((await chat(warm)).status, 200)
  await settled(warm, 3)
  await revoke(warm)
  assert.ok((await fakePct()) > (await windows())['5h'].usedPct, 'The snapshot is not behind')
  await age()
  await direct()
  let quota = (await zai()).counters.quota
  const caught = await issued()
  assert.equal((await zai()).counters.quota - quota, 1, 'Issue did not refresh the old snapshot')
  assert.ok(Math.abs((await windows())['5h'].usedPct - (await fakePct())) < 1e-9)
  assert.ok(Date.now() - (await account()).limitsSeenAt.getTime() < 30_000)
  // … and before the first call of a key, by the role itself.
  await age()
  await direct()
  quota = (await zai()).counters.quota
  const refreshed = await runTurn({ turn: caught, prompt: 'Synthetic turn on an old snapshot.' })
  assert.equal(refreshed.code, 0)
  assert.equal((await zai()).counters.quota - quota, 1, 'The first call did not refresh')
  assert.ok(Date.now() - (await account()).limitsSeenAt.getTime() < 30_000)
  await settled(caught, 1)
  await revoke(caught)
  passed(
    'a window snapshot older than ten minutes catches up with the quota at issue and at the first call of a key',
  )

  // 91 % of the five-hour window: a new task waits, without one refusal of the provider; a
  // task already bound to the account still gets the key of its next turn.
  await zai({
    quota: { fiveHour: { currentValue: 1820, remaining: 180, resetInMs: 3 * 3_600_000 } },
  })
  await age()
  await direct()
  const asked = (await zai()).counters.chat
  await waiting(await task())
  assert.equal((await windows())['5h'].usedPct, 91)
  assert.equal((await zai()).counters.chat, asked)
  const bound = await issued(undefined, caught)
  await revoke(bound)
  passed(
    'a new task is refused at 91 % of the five-hour window without a provider refusal; a bound task goes on',
  )

  // A quota answer that cannot be read is no capacity: admission closes until one that can.
  await zai({ quota: { mode: 'broken' } })
  await age()
  await direct()
  // The bound task would be selected on the old snapshot: the refresh stores «unknown».
  await waiting(await task(undefined, bound))
  assert.deepEqual((await account()).limitWindows, [])
  await zai({ quota: { mode: 'live', fiveHour: { idle: true } } })
  await direct()
  const reopened = await issued()
  assert.equal((await windows())['5h'].usedPct, 0)
  await revoke(reopened)
  passed('an unreadable quota answer closes admission; a readable one opens it again')

  setStage('change of the plan key')
  // The provider stops taking the key: the turn ends, a probe confirms it, and the operator
  // enters the new key with --relogin, on the direct path.
  // The role probed the account a moment ago, for its windows, when the key above was
  // issued. That answer came before the refusal and confirms nothing of it: the refused key
  // gets a probe of its own, in the order the product takes (a key is issued, its call refused).
  const rejected = await issued()
  await zai({ key: 'rotated', scenario: { scenario: 'text' } })
  const quotaBeforeRotation = (await zai()).counters.quota
  const afterRotation = await refused(rejected)
  assert.equal(afterRotation.provider.length, 1)
  assert.equal(afterRotation.provider[0].credential, 'other')
  assert.equal(JSON.parse(refusals.at(-1).body).error.code, 'raditi_account')
  await eventually(async () => (await account()).health === 'needs_relogin', 15_000)
  assert.equal((await account()).healthReason, 'auth_confirmed')
  assert.equal((await zai()).counters.quota - quotaBeforeRotation, 1)
  await revoke(rejected)
  await assert.rejects(issue(await task()))
  const relogin = await operator(
    'login',
    ['--backend', BACKEND, '--relogin', accountId, '--vault-token-file', writerFile],
    `${SYNTHETIC_ZAI_ROTATED_KEY}\n`,
  )
  assert.equal(relogin.code, 0, 'The relogin with the new plan key failed')
  assert.partialDeepStrictEqual(JSON.parse(relogin.stdout), { accountId, credentialVersion: 2 })
  assert.equal(`${relogin.stdout}${relogin.stderr}`.includes(SYNTHETIC_ZAI_ROTATED_KEY), false)
  assert.partialDeepStrictEqual(await account(), { health: 'ok', healthReason: null })
  await direct()
  const renewed = await issued()
  const renewedResult = resultFor('B13 OpenCode on the new plan key')
  await zai({ scenario: { scenario: 'text', text: JSON.stringify(renewedResult) } })
  const onNewKey = await runTurn({ turn: renewed, prompt: 'Synthetic turn on the new key.' })
  assert.equal(onNewKey.code, 0, `The turn on the new key failed with exit ${onNewKey.code}`)
  assert.deepEqual(onNewKey.result, renewedResult)
  assert.equal(onNewKey.provider[0].credential, 'plan-key')
  await settled(renewed, 1)
  await revoke(renewed)
  passed(
    'a refused plan key is confirmed by a probe; --relogin with the new key restores the account',
  )

  // The scenarios of the platform, on this group: its ids and forms are their data, and what
  // they leave at the provider and in the sandbox is checked with the rest below.
  const group = {
    ...zaiForms,
    db,
    core,
    stack,
    cli,
    passed,
    llmSecrets,
    admin,
    locks: ctx.locks,
    accountId,
    workspaceId: workspace.id,
    task,
    issue,
    keep,
    issued,
    revoke,
    keyRow,
    calls,
    settled,
    account,
    resultFor,
    runTurn,
    roleRequest,
    restartRole: direct,
    roleGetter: llmGetter,
    /** What the synthetic provider answers a generation and the quota with from now on. */
    provider: (answer) => zai({ scenario: answer }),
    quota: (options) => zai({ quota: options }),
    providerRequests: async () => (await zai()).counters.chat,
    lastProviderRequest: async () =>
      (await zai()).requests.findLast((request) => request.path === ZAI_PATHS.chat),
    /** One request of the group's route through sandbox-gw, as the sandbox would send it. */
    request: (turn, { body = zaiForms.body(), headers = {}, path = zaiForms.route } = {}) =>
      cli.request({
        key: turn.values.llmApiKey,
        path,
        headers: {
          'content-type': 'application/json',
          'user-agent': zaiForms.userAgent,
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    /** One more account of the group, imported with the key the provider takes now. */
    importAccount: async (label) => {
      const added = await zaiLogin(operator, { label, writerFile, key: SYNTHETIC_ZAI_ROTATED_KEY })
      assert.equal(added.code, 0, 'The import of another account failed')
      const { accountId: id } = JSON.parse(added.stdout)
      await db.subscriptionAccount.update({ where: { id }, data: { enabled: true } })
      return id
    },
  }
  setStage('protocol boundaries')
  await verifyProtocol(group)
  setStage('in-stream provider failures')
  await verifyStreamFailures(group)
  setStage('crash and persistence recovery')
  await verifyCrashes(group)
  setStage('runtime lifecycle')
  await verifyLifecycle(group)
  await direct()

  setStage('what reached the provider and the sandbox')
  state = await zai()
  const turnSecrets = refs.flatMap((turn) => [turn.values.llmApiKey, turn.values.mcpToken])
  // A key the provider did not take: the foreign key of the import, then the generation and
  // its confirming probe after the provider stopped taking the plan key, and nothing else.
  assert.equal(
    state.requests.filter((request) => request.credential === 'other').length,
    foreignRequests + 2,
    'A request reached the provider with a credential nobody expected',
  )
  for (const request of state.requests) {
    assert.ok(['plan-key', 'other'].includes(request.credential), 'A request without a key')
    for (const name of request.headerNames)
      assert.ok(PROVIDER_HEADERS.has(name), `The header ${name} reached the provider`)
    assert.equal(request.userAgent, opencodeUserAgent)
    const body = JSON.stringify(request.body ?? null)
    for (const secret of turnSecrets)
      assert.equal(body.includes(secret), false, 'A turn credential reached the provider')
  }
  // Neither plan key is in any file of the sandbox (searched after every turn as well, before
  // its home was wiped) or in anything the CLI printed.
  assert.deepEqual(await filesHolding(PROVIDER_KEYS), [], 'A plan key is in a file of the sandbox')
  const printed = outputs.join('\n')
  for (const forbidden of [SYNTHETIC_ZAI_KEY, SYNTHETIC_ZAI_ROTATED_KEY, SYNTHETIC_ZAI_MARKER])
    assert.equal(printed.includes(forbidden), false, 'Provider data reached the CLI output')
  // No final refusal the sandbox received invites the CLI to repeat the request or to compact
  // the context; the short-lived ones are meant to be repeated. The scenarios above collect 28
  // of them, seven inside a started stream: fewer means a scenario stopped being checked here.
  assert.ok(refusals.length >= 28, `Only ${refusals.length} refusals were collected`)
  const inStream = refusals.filter((refusal) => refusal.stream !== undefined).length
  assert.ok(inStream >= 7, `Only ${inStream} refusals inside a stream were collected`)
  let named = 0
  for (const refusal of refusals) {
    if (refusal.stream !== undefined) {
      assert.equal(cliRetriesStreamError(JSON.parse(refusal.stream)), false, refusal.stream)
      continue
    }
    assert.equal(cliRetriesHttp(refusal), refusal.transient === true, refusal.body)
    assert.equal(cliReadsOverflow(refusal), false, refusal.body)
    // The refusal of sandbox-gw is plain text; every other names a code and maybe a place.
    if (!refusal.body.startsWith('{')) continue
    // A path in a refusal never names the number of an item.
    const { field } = JSON.parse(refusal.body).error
    if (field === undefined) continue
    named += 1
    assert.doesNotMatch(field, /\d/)
  }
  // The foreign model of a CLI turn and the part inside the third message of a raw request.
  assert.ok(named >= 2, 'No refusal named the place of a violation')
  assert.equal(await proxyTunnels(), tunnels, 'A tunnel was opened on the direct path')
  passed(
    'nothing of a turn key, a session header or a cookie reaches the provider; no plan key in the sandbox; no final refusal matches the retry rules of OpenCode',
  )

  setStage('retirement of the account')
  const adminFile = join(stack.directory, 'zai-admin.token')
  await writeFile(adminFile, stack.tokens['subscriptions-admin'], { mode: 0o400 })
  const retire = async (...args) => {
    const result = await operator('retire', ['--account', accountId, '--label', LABEL, ...args])
    assert.equal(result.code, 0, 'The retirement command failed')
    return result.stdout.trim()
  }
  // An issued turn finishes while its account drains; no new key is issued meanwhile. The
  // refusal is «no account to wait for»: an account that only holds its one turn answers BUSY.
  const draining = await issued()
  assert.match(await retire(), /^Вывод запрошен\./)
  await waiting(await task())
  const drainedResult = resultFor('B13 OpenCode while the account drains')
  await zai({ scenario: { scenario: 'text', text: JSON.stringify(drainedResult) } })
  const drained = await runTurn({
    turn: draining,
    prompt: 'Complete the synthetic turn while its account drains.',
  })
  assert.equal(drained.code, 0, 'The issued CLI turn must finish while draining')
  assert.deepEqual(drained.result, drainedResult)
  await settled(draining, 1)
  await revoke(draining)
  await core.call('sweep')
  assert.equal((await account()).enabled, false)
  // The provider has no revocation the role could call: the operator revokes the key in the
  // provider's console and says so.
  assert.match(await retire('--finalize', '--vault-token-file', adminFile), /консоли провайдера/)
  assert.notEqual(await llmSecrets.kvRead(`subs/${BACKEND}/${accountId}`), null)
  assert.match(
    await retire('--finalize', '--console-revoked', '--vault-token-file', adminFile),
    /^Аккаунт выведен;/,
  )
  assert.equal(await llmSecrets.kvRead(`subs/${BACKEND}/${accountId}`), null)
  assert.equal((await account()).status, 'retired')
  passed(
    'retirement of the Z.ai account by the operator command with --console-revoked: an issued turn finishes while the account drains',
  )

  setStage('emergency retirement')
  await verifyEmergencyRetirement(group)
}
