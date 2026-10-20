// The Z.ai API group of B13: what differs on the pay-per-token offer (П15), on the same path
// sandbox → sandbox-gw → role llm → synthetic Z.ai, with the real pinned OpenCode CLI through its
// driver. An API account has a balance and no windows: the operator imports its key with
// `--plan payg`, the pool admits it without a probe of windows, an empty balance (1113) pauses it
// durably, and the next call after the pause finds a top-up by itself. The scenarios of the
// platform ran once on the plan group (П46); this group runs after it, on an account of another
// provider, so that neither pool sees the other.
import assert from 'node:assert/strict'

import { dockerCommand } from '../../../infra/dev/llm-verify/cli.mjs'
import {
  SYNTHETIC_ZAI_API_KEY,
  SYNTHETIC_ZAI_MARKER,
  SYNTHETIC_ZAI_ROTATED_API_KEY,
  ZAI_PATHS,
} from '../../../infra/dev/llm-verify/fake-zai.mjs'
import { sumUsage } from '../../../infra/dev/llm-verify/live.mjs'
import { eventually } from '../../../infra/dev/llm-verify/stack.mjs'
import { opencodeUserAgent } from '../../../packages/llm-backends/src/zai-coding/backend.ts'
import {
  cliReadsOverflow,
  cliRetriesHttp,
  cliRetriesStreamError,
} from '../../../packages/llm-backends/src/zai-coding/fixtures/opencode-cli.ts'
import {
  bash,
  createZaiHarness,
  PROVIDER_HEADERS,
  PROVIDER_KEYS,
  resultFor,
} from './verify-llm-zai-harness.mjs'
import {
  switchOnZai,
  ZAI_MODEL as MODEL,
  ZAI_OFFERS,
  ZAI_PROFILE as PROFILE,
  zaiDirectEnvironment,
  zaiLogin,
  zaiOperator,
} from './verify-llm-zai-setup.mjs'

const OFFER = ZAI_OFFERS.api
const LABEL = 'synthetic-zai-api'
/** What the fake counts for the answers of the API turn: a cache and reasoning, as the plan's. */
const API_USAGE = Object.freeze({ prompt: 6120, cached: 5888, completion: 212, reasoning: 97 })
const minutes = (count) => count * 60_000
/** The operator's alert of an empty balance: once per pause, with the checks of the day. */
const balanceAlert = (checks) =>
  `{"event":"llm_pool_health","reason":"balance_exhausted","checks":${checks}}`

export async function verifyZaiApi(ctx) {
  const { db, stack, control, passed, llmSecrets, coreSecrets, writer, restartLlm } = ctx
  const { promptMarker, writerFile, setStage } = ctx
  const zai = (body) => control('zai', body)
  const directEnv = zaiDirectEnvironment(ctx.env, stack)
  const operator = zaiOperator(stack, directEnv.LLM_UPSTREAM_CA_FILE)
  /** The role afresh, without a proxy: its probe memory and account pauses are gone. */
  const direct = (overrides = {}) => restartLlm({ ...directEnv, ...overrides })
  const account = () => db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
  const quotaAsked = async () => (await zai()).counters.quota

  setStage('import of an API key with an empty balance')
  await direct()
  // A new account of Z.ai with no money on it yet (П75): its key still imports, since the probe
  // asks whether the provider takes the key and never what it may spend.
  await zai({ reset: true, balance: 'empty' })
  const foreign = await zaiLogin(operator, {
    offer: OFFER,
    label: `${LABEL}-foreign`,
    writerFile,
    key: 'zai-synthetic-foreign-key',
  })
  assert.equal(foreign.code, 1)
  assert.equal(await db.subscriptionAccount.count({ where: { label: `${LABEL}-foreign` } }), 0)
  const imported = await zaiLogin(operator, {
    offer: OFFER,
    label: LABEL,
    writerFile,
    key: SYNTHETIC_ZAI_API_KEY,
  })
  assert.equal(imported.code, 0, 'The import of the synthetic API key failed')
  const { accountId } = JSON.parse(imported.stdout)
  assert.deepEqual(JSON.parse(imported.stdout), {
    accountId,
    backend: OFFER.backend,
    credentialVersion: 1,
    enabled: false,
  })
  assert.equal(`${imported.stdout}${imported.stderr}`.includes(SYNTHETIC_ZAI_API_KEY), false)
  const fresh = await account()
  assert.partialDeepStrictEqual(fresh, {
    driverId: 'opencode',
    plan: OFFER.plan,
    health: 'ok',
    enabled: false,
    maxConcurrentTurns: 1,
    maxConcurrentRequests: 2,
    limitsSeenAt: null,
  })
  assert.equal(fresh.limitWindows?.length ?? 0, 0)
  // The import asked the monitor path alone — the probe of the key, free and without content —
  // and generated nothing.
  let state = await zai()
  assert.ok(state.requests.length >= 2)
  for (const request of state.requests)
    assert.deepEqual([request.method, request.path], ['GET', ZAI_PATHS.quota])
  assert.equal(state.requests[0].credential, 'other')
  assert.equal(state.requests.at(-1).credential, 'api-key')
  assert.equal(state.counters.generated, 0)
  const foreignRequests = state.requests.filter((request) => request.credential === 'other').length
  const secretPath = `subs/${OFFER.backend}/${accountId}`
  assert.notEqual(await llmSecrets.kvRead(secretPath), null)
  await assert.rejects(writer.kvRead(secretPath), (error) => error.status === 403)
  await assert.rejects(coreSecrets.kvRead(secretPath), (error) => error.status === 403)
  passed(
    'Z.ai API key import with --plan payg: the auth-only probe of the monitor path takes a key with an empty balance and refuses a foreign one; no window is written',
  )

  setStage('admission of an account without windows')
  await zai({ balance: 'funded' })
  await switchOnZai(db, {
    accountId,
    ratesUrl: 'https://synthetic.invalid/b13-api-rates',
    backend: OFFER.backend,
  })
  const profile = await db.llmModel.findFirstOrThrow({
    where: { slug: PROFILE, provider: { slug: OFFER.backend } },
  })
  const workspace = await db.workspace.create({
    data: { name: 'B13 synthetic Z.ai API workspace', dataClass: 'synthetic' },
  })
  const harness = await createZaiHarness(ctx, {
    offer: OFFER,
    workspaceId: workspace.id,
    name: 'B13 synthetic Z.ai API',
  })
  const { refs, refusals, outputs } = harness
  const { task, issue, issued, revoke, keyRow, settled, waiting, chat } = harness
  const { roleLog, filesHolding, runTurn, refused } = harness
  let quota = await quotaAsked()
  // Nobody wrote windows, and nobody asks for them: core admits the account on its pauses alone.
  const first = await issued()
  assert.equal((await keyRow(first)).subscriptionAccountId, accountId)
  assert.equal(await quotaAsked(), quota, 'Issue probed the windows of an API account')
  await revoke(first)
  // What a probe that answered without windows leaves behind, ten minutes old: for an account
  // with windows a snapshot to refresh at issue and at the first call; here nothing to read.
  await db.subscriptionAccount.update({
    where: { id: accountId },
    data: { limitWindows: [], limitsSeenAt: new Date(Date.now() - minutes(11)) },
  })
  await direct()
  quota = await quotaAsked()
  const written = await issued()
  assert.equal(await quotaAsked(), quota, 'Issue refreshed the windows of an API account')
  passed(
    'an API account without windows is admitted by its pauses alone: no probe of windows at issue, also over an old empty snapshot',
  )

  setStage('an OpenCode turn on the API route')
  const writtenResult = resultFor('B13 OpenCode on the Z.ai API', ['zai-api.txt'])
  await zai({
    scenario: {
      scenario: 'tools',
      rounds: [[bash(String.raw`printf 'synthetic-api\n' > zai-api.txt`)]],
      text: JSON.stringify(writtenResult),
      usage: API_USAGE,
    },
  })
  const turn = await runTurn({
    turn: written,
    prompt: `${promptMarker}. Write the synthetic file, then answer.`,
  })
  assert.equal(turn.code, 0, `The OpenCode turn on the API failed with exit ${turn.code}`)
  assert.deepEqual(turn.result, writtenResult)
  const file = await dockerCommand([
    'exec',
    ctx.cli.containerName,
    'cat',
    '/workspace/repo/zai-api.txt',
  ])
  assert.equal(file.stdout, 'synthetic-api\n', 'zai-api.txt was not written by the CLI')
  // Every request of the turn went to the chat path of the API with the API key, and the role's
  // first call of the key read no window either.
  assert.equal(turn.provider.length, 2)
  assert.deepEqual(
    turn.requests.map((request) => [request.method, request.path, request.credential]),
    turn.provider.map(() => ['POST', ZAI_PATHS.apiChat, 'api-key']),
  )
  assert.equal(turn.quotaRequests, 0, 'The first call of the key probed the windows')
  for (const { body } of turn.provider) {
    assert.equal(body.model, MODEL)
    // The profile of the turn key sets the level, as on the plan: one body policy for both.
    assert.equal(body.reasoning_effort, 'high')
    assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
    assert.ok(body.max_tokens <= 32_000)
    assert.equal(body.stream, true)
    assert.equal(body.stream_options?.include_usage, true)
    assert.ok(body.tools.some((tool) => tool.function?.name === 'raditi_site_info'))
  }
  // The usage of each call is the provider's own count, written once, on the API's own profile.
  const rows = await settled(written, 2)
  for (const row of rows) {
    assert.partialDeepStrictEqual(row, {
      state: 'completed',
      route: OFFER.route,
      subscriptionAccountId: accountId,
      modelId: profile.id,
    })
    assert.partialDeepStrictEqual(row.tokenUsage, {
      inputUncachedTokens: API_USAGE.prompt - API_USAGE.cached,
      cacheReadTokens: API_USAGE.cached,
      cacheWriteTokens: 0,
      outputTokens: API_USAGE.completion,
      reasoningTokens: API_USAGE.reasoning,
      modelId: profile.id,
      estimated: false,
      billable: true,
    })
  }
  const usageRows = await db.tokenUsage.findMany({
    where: { gatewayCallId: { in: rows.map((row) => row.id) } },
  })
  assert.equal(usageRows.length, rows.length)
  assert.deepEqual(
    sumUsage(turn.events.filter((event) => event.type === 'usage').map((event) => event.usage)),
    sumUsage(
      rows.map(({ tokenUsage }) => ({
        inputUncached: tokenUsage.inputUncachedTokens,
        cacheRead: tokenUsage.cacheReadTokens,
        cacheWrite: tokenUsage.cacheWriteTokens,
        output: tokenUsage.outputTokens,
        reasoning: tokenUsage.reasoningTokens,
      })),
    ),
  )
  // The route and the backend of a key are one: an API key on the plan's route is refused
  // before any provider request.
  const asked = (await zai()).counters.chat
  const foreignRoute = await chat(written, { path: ZAI_OFFERS.plan.route })
  assert.equal(foreignRoute.status, 403)
  assert.equal(JSON.parse(foreignRoute.body).error.code, 'raditi_backend')
  refusals.push({ status: 403, body: foreignRoute.body, message: '' })
  assert.equal((await zai()).counters.chat, asked)
  await revoke(written)
  passed(
    'an OpenCode turn through sandbox-gw on the API route: the API path and key alone, usage in llm_calls and token_usage once per call and equal to the CLI; an API key on the plan route refused',
  )

  setStage('an empty balance')
  const broke = await issued()
  await zai({ balance: 'empty', scenario: { scenario: 'text' } })
  quota = await quotaAsked()
  const empty = await refused(broke)
  assert.equal(empty.provider.length, 1, 'The CLI asked again after an empty balance')
  assert.equal(refusals.at(-1).status, 403)
  assert.equal(JSON.parse(refusals.at(-1).body).error.code, 'raditi_subscription_limit')
  assert.equal((await keyRow(broke)).lastRefusal, 'subscription_limit')
  const [refusedCall] = await settled(broke, 1)
  assert.partialDeepStrictEqual(refusedCall, {
    signal: 'balance_exhausted',
    upstreamStatus: 429,
  })
  await eventually(async () => (await account()).coolingUntil !== null, 10_000).catch(() =>
    assert.fail('An empty balance did not pause the account'),
  )
  const firstPause = (await account()).coolingUntil.getTime() - refusedCall.finishedAt.getTime()
  assert.ok(Math.abs(firstPause - minutes(5)) < 5_000, `The first pause is ${firstPause} ms`)
  // Money is not a risk to the account: no suspension, no relogin, and no probe — none sees a
  // balance. The operator is told once.
  assert.partialDeepStrictEqual(await account(), { health: 'ok', healthReason: null })
  await eventually(async () => roleLog().includes(balanceAlert(1)), 10_000).catch(() =>
    assert.fail('The role did not alert the operator of the empty balance'),
  )
  assert.ok(roleLog().includes('"signal":"balance_exhausted"'))
  assert.equal(await quotaAsked(), quota, 'An empty balance made the role probe the account')
  // The pause is durable: core does not select the account for a new task, and the refused key
  // gets nothing more from the provider.
  const generated = (await zai()).counters.chat
  await waiting(await task())
  const again = await chat(broke)
  assert.equal(JSON.parse(again.body).error.code, 'raditi_subscription_limit')
  refusals.push({ status: again.status, body: again.body, message: '' })
  assert.equal((await zai()).counters.chat, generated)
  await revoke(broke)
  passed(
    'code 1113 of the API: a final subscription_limit in one request, a durable pause of 5 minutes, the operator alert and no probe; a new task waits',
  )

  setStage('the pause of the day grows; a top-up is found by the next call after it')
  // The first check, moved past its pause: the second empty balance of the day is a new check.
  await db.llmCall.update({
    where: { id: refusedCall.id },
    data: {
      startedAt: new Date(refusedCall.startedAt.getTime() - minutes(6)),
      finishedAt: new Date(refusedCall.finishedAt.getTime() - minutes(6)),
    },
  })
  const pauseOver = () =>
    db.subscriptionAccount.update({
      where: { id: accountId },
      data: { coolingUntil: new Date(Date.now() - 1000) },
    })
  await pauseOver()
  const secondBroke = await issued()
  await refused(secondBroke)
  const [secondCall] = await settled(secondBroke, 1)
  await eventually(async () => roleLog().includes(balanceAlert(2)), 10_000).catch(() =>
    assert.fail('The second empty balance raised no alert'),
  )
  const secondPause = (await account()).coolingUntil.getTime() - secondCall.finishedAt.getTime()
  assert.ok(Math.abs(secondPause - minutes(15)) < 5_000, `The second pause is ${secondPause} ms`)
  await revoke(secondBroke)
  // The operator tops the account up. Nobody can see that before the pause ends.
  await zai({ balance: 'funded' })
  await waiting(await task())
  await pauseOver()
  const toppedUp = await issued()
  const toppedResult = resultFor('B13 OpenCode after a top-up')
  await zai({ scenario: { scenario: 'text', text: JSON.stringify(toppedResult) } })
  const afterTopUp = await runTurn({ turn: toppedUp, prompt: 'Synthetic turn after a top-up.' })
  assert.equal(afterTopUp.code, 0, `The turn after a top-up failed with exit ${afterTopUp.code}`)
  assert.deepEqual(afterTopUp.result, toppedResult)
  assert.equal(afterTopUp.provider.length, 1)
  await settled(toppedUp, 1)
  assert.partialDeepStrictEqual(await account(), { health: 'ok', enabled: true })
  await revoke(toppedUp)
  passed(
    'a second empty balance of the day pauses the account for 15 minutes; after the pause and a top-up the account is selected again and the next turn succeeds',
  )

  setStage('a refused API key')
  // The provider stops taking the key: the turn ends, the probe of the key confirms it, and the
  // operator enters the new key with --relogin.
  await direct()
  const rejected = await issued()
  await zai({ apiKey: 'rotated', scenario: { scenario: 'text' } })
  quota = await quotaAsked()
  const afterRotation = await refused(rejected)
  assert.equal(afterRotation.provider.length, 1)
  assert.equal(afterRotation.provider[0].credential, 'other')
  assert.equal(JSON.parse(refusals.at(-1).body).error.code, 'raditi_account')
  assert.equal((await keyRow(rejected)).lastRefusal, 'account')
  await eventually(async () => (await account()).health === 'needs_relogin', 15_000).catch(() =>
    assert.fail('The refused API key was not confirmed'),
  )
  assert.equal((await account()).healthReason, 'auth_confirmed')
  assert.equal((await quotaAsked()) - quota, 1, 'The refused key was not probed exactly once')
  await revoke(rejected)
  await assert.rejects(issue(await task()))
  const relogin = await operator(
    'login',
    ['--backend', OFFER.backend, '--relogin', accountId, '--vault-token-file', writerFile],
    `${SYNTHETIC_ZAI_ROTATED_API_KEY}\n`,
  )
  assert.equal(relogin.code, 0, 'The relogin with the new API key failed')
  assert.partialDeepStrictEqual(JSON.parse(relogin.stdout), { accountId, credentialVersion: 2 })
  assert.equal(`${relogin.stdout}${relogin.stderr}`.includes(SYNTHETIC_ZAI_ROTATED_API_KEY), false)
  assert.partialDeepStrictEqual(await account(), { health: 'ok', healthReason: null })
  await direct()
  const renewed = await issued()
  const onNewKey = await chat(renewed)
  assert.equal(onNewKey.status, 200)
  assert.equal((await zai()).requests.at(-1).credential, 'api-key')
  await settled(renewed, 1)
  await revoke(renewed)
  passed(
    'a refused API key is auth: confirmed by one probe of the key, the account needs a relogin, and --relogin with the new key restores it',
  )

  setStage('short-lived refusals of the API')
  await direct()
  await harness.repeatedAfterShortRefusal('B13 OpenCode on the API after a short-lived refusal')
  // A 429 that names no code: the API's own throttle is short-lived, not a block to confirm.
  await direct()
  const throttled = await issued()
  await zai({ scenario: { scenario: 'error', status: 429, retryAfter: '2' } })
  quota = await quotaAsked()
  const busy = await chat(throttled)
  assert.equal(busy.status, 503)
  assert.equal(busy.headers['retry-after'], '2')
  assert.equal(JSON.parse(busy.body).error.code, 'raditi_transient')
  assert.equal(busy.body.includes(SYNTHETIC_ZAI_MARKER), false)
  refusals.push({ status: 503, body: busy.body, message: '', transient: true })
  const [throttledCall] = await settled(throttled, 1)
  assert.equal(throttledCall.signal, 'transient')
  assert.equal(await quotaAsked(), quota, 'A throttle made the role probe the account')
  assert.partialDeepStrictEqual(await account(), { health: 'ok', healthReason: null })
  await revoke(throttled)
  passed(
    'code 1302 of the API is repeated by OpenCode after the pause and the turn finishes; a 429 without a code is a short-lived refusal, not a block to confirm',
  )

  setStage('what reached the provider from the API group')
  state = await zai()
  const turnSecrets = refs.flatMap((item) => [item.values.llmApiKey, item.values.mcpToken])
  // A key the provider did not take: the foreign key of the import, then the generation and its
  // confirming probe after the provider stopped taking the first API key, and nothing else.
  assert.equal(
    state.requests.filter((request) => request.credential === 'other').length,
    foreignRequests + 2,
    'A request reached the provider with a credential nobody expected',
  )
  for (const request of state.requests) {
    assert.ok(['api-key', 'other'].includes(request.credential), 'A request without the API key')
    // Nothing of this group asked the plan's chat path.
    assert.notEqual(request.path, ZAI_PATHS.chat)
    for (const name of request.headerNames)
      assert.ok(PROVIDER_HEADERS.has(name), `The header ${name} reached the provider`)
    assert.equal(request.userAgent, opencodeUserAgent)
    const body = JSON.stringify(request.body ?? null)
    for (const secret of turnSecrets)
      assert.equal(body.includes(secret), false, 'A turn credential reached the provider')
  }
  assert.deepEqual(await filesHolding(PROVIDER_KEYS), [], 'A provider key is in the sandbox')
  const printed = outputs.join('\n')
  for (const forbidden of [...PROVIDER_KEYS, SYNTHETIC_ZAI_MARKER])
    assert.equal(printed.includes(forbidden), false, 'Provider data reached the CLI output')
  // Every final refusal of this group, the empty balance among them, ends the turn: none
  // invites the CLI to repeat the request or to compact the context.
  assert.ok(refusals.length >= 5, `Only ${refusals.length} refusals were collected`)
  for (const refusal of refusals) {
    if (refusal.stream !== undefined) {
      assert.equal(cliRetriesStreamError(JSON.parse(refusal.stream)), false, refusal.stream)
      continue
    }
    assert.equal(cliRetriesHttp(refusal), refusal.transient === true, refusal.body)
    assert.equal(cliReadsOverflow(refusal), false, refusal.body)
  }
  passed(
    'nothing of a turn key, a session header or a cookie reaches the provider from the API group, nothing reaches the plan path; no provider key in the sandbox; no final refusal matches the retry rules of OpenCode',
  )
}
