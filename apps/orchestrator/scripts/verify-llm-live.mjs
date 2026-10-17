/* global AbortSignal, console, fetch, URL */
// verify:llm-gateway --live: the real pinned OpenCode CLI through its driver, sandbox-gw and the
// role llm to the real GLM on api.z.ai, which the role reaches itself, as in the product. With
// --measure the same run measures instead of accepting, and with --results it measures one
// thing under the cap of the acceptance: how often a turn ends with a valid result. With --api
// the acceptance runs on the pay-per-token API instead of the plan (П15): no windows to start
// on or to grow, and what no record shows yet is asserted — the probe of the key and two levels
// of reasoning that count differently; where the usage comes is reported. With
// --rehearsal the same code runs on the synthetic Z.ai with a scripted model and proves the
// request cap, the start refusals and the search for the key before anything is sent to the
// real provider. Only synthetic prompts go to the model. Commands, limits and rules:
// infra/dev/llm-verify/README.md, «Живой режим».
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import process from 'node:process'

import { createOpencodeDriver } from '@repo/agent-drivers'
import { createPrismaClient } from '@repo/db'
import {
  llmJsonLimits,
  preparedFilesSchema,
  preparedRunExposesSecret,
  SANDBOX_WORKDIR,
  turnCredentials,
} from '@repo/domain'

import { CLI_IMAGE, createCliSession, dockerCommand } from '../../../infra/dev/llm-verify/cli.mjs'
import { SYNTHETIC_MCP_MARKER } from '../../../infra/dev/llm-verify/fake-subscriptions.mjs'
import { ZAI_PATHS } from '../../../infra/dev/llm-verify/fake-zai.mjs'
import {
  chatRequestSummary,
  createOutcome,
  failureLine,
  LIVE_LIMITS,
  LiveRefusal,
  STREAM_FORMS,
  streamSummary,
  sumUsage,
} from '../../../infra/dev/llm-verify/live.mjs'
import {
  abortVerification,
  eventually,
  run,
  startVerificationStack,
} from '../../../infra/dev/llm-verify/stack.mjs'
import { seedReferenceData } from '../../../packages/db/prisma/seed/apply.ts'
import { opencodeUserAgent } from '../../../packages/llm-backends/src/zai-coding/backend.ts'
import { productionMcpTools } from './verify-llm-mcp-tools.mjs'
import {
  judgeResult,
  readingShares,
  REHEARSED_FORMS,
  rehearsalScenario,
  RESULTS_ACCEPTED_FROM,
  resultReadings,
  resultShares,
  resultTurns,
} from './verify-llm-live-results.mjs'
import { assertImages, openLiveRun, REFUSED } from './verify-llm-live-run.mjs'
import {
  resetOpencodeHome,
  switchOnProfile,
  switchOnZai,
  ZAI_GATEWAY_BASE_URL,
  ZAI_MODEL,
} from './verify-llm-zai-setup.mjs'

const GATEWAY = 'http://sandbox-gw:8080'
/** Calls one turn key of the acceptance may start: the role's own ceiling, LLM_MAX_CALLS_PER_KEY. */
const TURN_CALLS = 5
/** Attempts an outcome that depends on the model gets. */
const ATTEMPTS = 3
/**
 * What the scripted model of a rehearsal answers instead of a valid result, by kind of turn and
 * attempt — the two forms the real model gave (docs/plan/45-zai-live.md): the object without
 * `files_changed`, which neither reading takes, and a sentence before the object, which the
 * product takes and the strict reading of the driver does not. The text turn misses its outcome
 * in all three attempts; the continuation misses its first and reaches its second on an answer
 * only the product takes. So every rehearsal shows what a missed outcome costs — attempts and a
 * line of the report, never the run — and where the two readings part. In the measurement the
 * second and the third of the ten result turns answer in the two forms.
 */
const REHEARSED_MISSES = {
  'text turn': ['field', 'field', 'field'],
  continuation: ['field', 'prose'],
  'result turn': [undefined, 'prose', 'field'],
}
const rehearsedText = (label, attempt, expected) => {
  const form = REHEARSED_MISSES[label]?.[attempt - 1]
  if (form === 'prose') return `The check is complete.\n\n${JSON.stringify(expected)}`
  if (form !== 'field') return JSON.stringify(expected)
  const { files_changed: _omitted, ...rest } = expected
  return JSON.stringify(rest)
}
/**
 * The measurement of a refused body (rehearsal of --measure): calls the key of such a turn may
 * start, and how many requests in a row the stand refuses at most before it lets the CLI through.
 */
const BODY_TURN_CALLS = 4
const BODY_REFUSALS_AT_MOST = 12
/**
 * What OpenCode 1.18.34 did with HTTP 400 `raditi_body`, the refusal of a body that is too
 * large, measured on 11.10.2026 (docs/plan/48-removal.md). It ends the turn in that request: a
 * failure reported, no request for a compaction, no repeat, exit 1 — for the bytes of the
 * refusal given where an answer of the role would come (`given`), and for a request of its own
 * that really is above the limit, which sandbox-gw refuses itself once it has read it
 * (`uploaded`: the step before it reached the provider and is the one call of the key). Until G8
 * the answer was 413, which the CLI took for an overflow of its context and answered with a
 * request for a compaction (docs/plan/47-common-scenarios-zai.md). The rehearsal holds the CLI
 * to these numbers, so a CLI that reacts otherwise shows here.
 */
const BODY_REFUSAL_MEASURED = Object.freeze({
  given: {
    exit: 1,
    refused: 1,
    requests: ['turn 400'],
    provider: 0,
    calls: 0,
    result: false,
    failures: ['APIError 400 raditi_body'],
  },
  uploaded: {
    exit: 1,
    refused: 0,
    requests: ['turn 200'],
    provider: 1,
    calls: 1,
    result: false,
    failures: ['APIError 400 raditi_body'],
  },
})
const TURN_MS = 240_000
const CLASSES = {
  light: { slug: 'glm-5.3-light', effort: 'low' },
  standard: { slug: 'glm-5.3-standard', effort: 'high' },
  heavy: { slug: 'glm-5.3-heavy', effort: 'max' },
}
/** An answer that came to the sandbox as a stream: a refusal is JSON and has no frames. */
const streamed = (exchange) =>
  exchange.status === 200 && exchange.contentType === 'text/event-stream'
const bash = (command) => ({ name: 'bash', arguments: { command, description: 'Synthetic step' } })
const resultFor = (summary, files = []) => ({
  summary,
  change_type: files.length ? 'code' : 'none',
  client_message: 'Синтетическая проверка завершена.',
  files_changed: files,
  questions: [],
  needs_approval: false,
  risk: 'low',
})

export async function runLiveGateway(mode) {
  const kind = mode.measure ? 'measure' : mode.results ? 'results' : 'gateway'
  let stage = 'build'
  let stack, db, llm, core, cli
  // The ceiling of a turn key the role llm runs with: LLM_MAX_CALLS_PER_KEY of its process.
  let roleCalls = null
  // The turns of the narrow measurement; their files carry a marker of this run.
  const resultPlan = mode.results
    ? resultTurns(`live-result-${randomBytes(4).toString('hex')}`)
    : null
  let interrupted = false
  const workers = []
  // What the CLI printed, for the search for the key: at the end, and after a failure.
  const outputs = []
  const interrupt = () => {
    if (interrupted) return
    interrupted = true
    abortVerification()
    for (const worker of workers) worker.child.kill('SIGTERM')
    void cli?.close().catch(() => {})
  }
  // The time limit of the run ends it the way a signal does.
  const live = await openLiveRun({ mode, kind, onExpire: interrupt })
  if (live === REFUSED) return REFUSED
  const { rehearsal, budget, passed, report, offer } = live
  // Kept until the end of the run, not `once`: a repeated signal must not end the cleanup, and
  // the cleanup is what removes the OpenBao container that holds the plan key.
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  let code = 0
  try {
    if (!mode.noBuild) await run('pnpm', ['--filter', 'orchestrator', 'build'])
    await assertImages()
    stage = 'disposable stack'
    stack = await startVerificationStack({
      live: !rehearsal,
      onStage: (name) => {
        stage = name
      },
    })
    await live.useProvider(stack)
    db = createPrismaClient({ databaseUrl: stack.databaseUrl, log: [] })
    await seedReferenceData(db)
    passed(
      rehearsal
        ? 'disposable stack with the synthetic Z.ai (rehearsal of the live flow)'
        : 'disposable stack without a synthetic provider, an egress proxy or a certificate',
    )
    const control = async (path, body) => {
      const result = await fetch(`${stack.control}/${path}`, {
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(result.status, 200, 'Synthetic control request failed')
      return result.json()
    }
    /** The scripted model of a rehearsal; a live run has a model of its own. */
    const script = (scenario) => (rehearsal ? control('zai', { scenario }) : null)
    const fakeChat = async () => (rehearsal ? (await control('zai')).counters.chat : null)

    stage = `import of the ${live.keyWord}`
    const accountId = await live.importKey({ stack, db })
    const ratesUrl = 'https://synthetic.invalid/live-rates'
    await switchOnZai(db, { accountId, ratesUrl, backend: offer.backend })
    // Both measurements ask the three classes: the same model at the three levels; the API run
    // asks two of them. The profiles of the run's own provider: both offers name theirs alike.
    if (mode.measure || mode.results || mode.api)
      for (const { slug } of [CLASSES.light, CLASSES.heavy])
        await switchOnProfile(db, { backend: offer.backend, slug, ratesUrl })
    passed(
      mode.api
        ? 'the API key went from the environment of the stand to the operator command on its input; the import passed on the probe of the key: the monitor path answered it as a key the provider takes (П66)'
        : 'the plan key went from the environment of the stand to the operator command on its input; the import passed on the quota answer of the provider',
    )

    stage = 'role llm, core and the observer'
    const metricsToken = randomBytes(24).toString('hex')
    const { observer, rolePort } = await live.startObserver(stack)
    const roleEnv = (callsPerKey, overrides) =>
      live.roleEnvironment({ stack, rolePort, metricsToken, callsPerKey, overrides })
    const startLlm = async (callsPerKey, overrides) => {
      await llm?.close()
      llm = await live.startLlm({ stack, env: roleEnv(callsPerKey, overrides) })
      workers.push(llm)
      roleCalls = callsPerKey
      return llm
    }
    await startLlm(mode.measure ? 2 : (resultPlan?.[0].ceiling ?? TURN_CALLS))
    core = await live.startCore({ stack, env: roleEnv(TURN_CALLS), rolePort })
    workers.push(core)
    const workspace = await db.workspace.create({
      data: { name: 'Live synthetic workspace', dataClass: 'synthetic' },
    })
    const refs = []
    const task = async (overrides = {}, continued) => {
      let taskId = continued?.ref.taskId
      if (!taskId) {
        const site = await db.site.create({
          data: {
            workspaceId: workspace.id,
            name: 'Live synthetic site',
            url: `https://${randomUUID()}.invalid`,
            stack: 'wordpress',
          },
        })
        const record = await db.task.create({
          data: {
            workspaceId: workspace.id,
            siteId: site.id,
            status: 'running',
            modelClass: overrides.modelClass ?? 'standard',
          },
        })
        await db.siteLease.create({
          data: {
            siteId: site.id,
            holderTaskId: record.id,
            epoch: 1,
            operation: 'turn',
            expiresAt: new Date(Date.now() + 1_800_000),
          },
        })
        taskId = record.id
      }
      const profile = CLASSES[overrides.modelClass ?? 'standard']
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
          modelSlug: profile.slug,
          modelClass: 'standard',
          reasoningEffort: profile.effort,
          ttlMs: 600_000,
          deadlineAt: new Date(Date.now() + 1_500_000).toISOString(),
          budgetRub: '135.00',
          boundSource: null,
          ...overrides,
        },
      }
    }
    const issued = async (overrides, continued) => {
      const item = await task(overrides, continued)
      const values = await core.call('issue', { ref: item.ref, grant: item.grant })
      const turn = { ...item, values }
      refs.push(turn)
      return turn
    }
    const revoke = (turn) => core.call('revoke', { ref: turn.ref })
    const calls = (turn) =>
      db.llmCall.findMany({
        where: { key: { taskId: turn.ref.taskId, turnNo: turn.ref.turn } },
        include: { tokenUsage: true },
        orderBy: { startedAt: 'asc' },
      })
    const settled = (turn) =>
      eventually(async () => {
        const rows = await calls(turn)
        return rows.every((row) => row.state !== 'open') ? rows : null
      }, 30_000)
    /**
     * The first key of the run: nobody wrote the windows, so the role's probe does. An account
     * of the API has none: it is admitted without a request, and nothing is written.
     */
    const admitted = async () => {
      if (mode.api) {
        const used = budget.state().used
        const first = await issued()
        const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
        assert.equal(budget.state().used, used, 'The first key of the API asked the provider')
        assert.equal(account.limitWindows?.length ?? 0, 0)
        assert.equal(account.limitsSeenAt, null)
        return { first, windows: null }
      }
      budget.afford(1, 'the first quota probe of the role')
      const first = await issued()
      try {
        return { first, windows: await live.admitWindows({ db, accountId }) }
      } catch (error) {
        await revoke(first)
        throw error
      }
    }

    stage = 'windows of the account'
    if (rehearsal && !mode.api) {
      // The start refusals of the windows on the quota of the synthetic provider: above 50 % of
      // five hours, above 80 % of the week. The snapshot is the role's own: a role afresh reads
      // the quota anew when a key is issued.
      const age = () =>
        db.$executeRaw`UPDATE subscription_accounts
          SET limits_seen_at = clock_timestamp() - interval '11 minutes' WHERE id = ${accountId}::uuid`
      for (const [quota, expected] of [
        [
          { fiveHour: { currentValue: 1020, remaining: 980, resetInMs: 3 * 3_600_000 } },
          /five-hour window is used above 50/,
        ],
        [
          { fiveHour: { idle: true }, week: { currentValue: 8100, remaining: 1900 } },
          /week window is used above 80/,
        ],
      ]) {
        await control('zai', { quota })
        await assert.rejects(admitted(), (error) => {
          assert.ok(error instanceof LiveRefusal, `Not a refusal: ${error.message}`)
          assert.match(error.message, expected)
          return true
        })
        await age()
        await startLlm(TURN_CALLS)
      }
      await control('zai', {
        quota: { fiveHour: { idle: true }, week: { currentValue: 25, remaining: 9974 } },
      })
      passed(
        'rehearsal: a five-hour window above 50 % and a week above 80 % in the snapshot of the probe refuse the run',
      )
    }
    const { first, windows: before } = await admitted()
    passed(
      mode.api
        ? 'the API account was admitted without windows: no request at issue, no window written'
        : 'the windows of the account were written by the quota probe of the role; the run may start',
    )

    stage = 'isolated CLI container'
    cli = await createCliSession({
      parentDirectory: stack.directory,
      network: stack.network,
      address: stack.cliIp,
      gatewayIp: stack.gatewayIp,
    })
    await live.startNetworkGuard({ stack, cli })
    const imageId = (
      await run('docker', ['image', 'inspect', '--format', '{{.Id}}', CLI_IMAGE])
    ).stdout.trim()
    const driver = createOpencodeDriver({ image: `raditi-p3verify-cli@${imageId}` })
    const tools = await productionMcpTools()
    const platformTools = tools.map((tool) => `raditi_${tool.name}`)
    const version = await dockerCommand(['exec', cli.containerName, 'opencode', '--version'])
    assert.equal(version.stdout.trim(), '1.18.34', 'The CLI image holds another OpenCode')
    if (rehearsal) await live.proveSandboxSearch(cli.containerName)
    const instructions =
      '# Raditi platform rules (synthetic check)\nThis is a synthetic check of the platform. Work only inside the repository.\n'
    const turns = []

    /**
     * One turn the way production runs it: the driver's prepare and command, the executor's
     * checks, a home that holds nothing but the session state, then exactly that in the CLI
     * container. While it runs the stand watches the ledger: a connection the guard refused
     * ends the turn at once.
     */
    async function runTurn({ label, turn, prompt, nativeSessionId, effort = 'high' }) {
      await resetOpencodeHome(cli.containerName, { keepSession: Boolean(nativeSessionId) })
      await control('mcp', { token: turn.values.mcpToken, tools })
      const context = {
        taskId: turn.ref.taskId,
        sessionId: turn.ref.sessionId,
        turn: turn.ref.turn,
        llm: {
          baseUrl: offer.gatewayBaseUrl,
          model: ZAI_MODEL,
          apiKey: turn.values.llmApiKey,
          reasoningEffort: effort,
        },
        mcp: { url: `${GATEWAY}/mcp`, token: turn.values.mcpToken },
        instructions,
        ...(nativeSessionId ? { nativeSessionId } : {}),
      }
      const prepared = await driver.prepare(context)
      const argv = driver.command(prepared, { prompt, attachments: [] })
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
      const from = {
        exchanges: observer.exchanges().length,
        mcp: (await control('state')).mcp.requests.length,
        requests: budget.state().used,
      }
      const started = Date.now()
      // Fail closed: a refusal of a guard ends the turn now, not when the CLI gives up repeating.
      const result = await live.watched(
        () => cli.runPrepared({ ...files, argv, timeoutMs: TURN_MS }),
        () => cli.close(),
      )
      const ms = Date.now() - started
      outputs.push(result.stdout, result.stderr)
      // The cap first: a turn the guard had to stop is a failed run, whatever else it did.
      budget.assertHeld()
      assert.equal(result.timedOut, false, `${label}: the turn outlived ${TURN_MS / 1000} s`)
      assert.equal(result.exceeded, false, `${label}: the turn printed more than the stand reads`)
      // Before the next turn wipes this home: nothing the CLI stored holds the provider key.
      assert.equal(
        await live.sandboxHoldsKey(cli.containerName),
        false,
        `${label}: the ${live.keyWord} is in a file of the sandbox`,
      )
      const events = result.stdout.split('\n').flatMap((line) => driver.parseEvent(line))
      const exchanges = observer.exchanges().slice(from.exchanges)
      // The answer as the product would read it and, beside it, by the strict reading of the
      // driver; `result` is the product's, or null.
      const reading = resultReadings({ driver, events, code: result.code })
      const outcome = {
        label,
        code: result.code,
        ms,
        events,
        lines: result.lines,
        nativeSessionId: events.find((event) => event.type === 'started')?.nativeSessionId,
        result: reading.result,
        reading,
        exchanges,
        mcp: (await control('state')).mcp.requests.slice(from.mcp),
        requests: budget.state().used - from.requests,
      }
      turns.push(outcome)
      return outcome
    }

    /**
     * What the platform owes in every turn, whatever the model did: the usage of each completed
     * call is the provider's own count and adds up to what the CLI printed, every request the
     * CLI sent declared the platform's tools, and the role spoke to the provider only as often
     * as its ceiling allows.
     */
    async function invariants(turn, outcome, { ceiling = TURN_CALLS } = {}) {
      const { label } = outcome
      const rows = await settled(turn)
      assert.ok(rows.length <= ceiling, `${label}: ${rows.length} calls of one key`)
      const completed = rows.filter((row) => row.state === 'completed')
      for (const row of completed) {
        assert.ok(row.tokenUsage, `${label}: a completed call has no usage`)
        assert.equal(row.tokenUsage.estimated, false, `${label}: the usage is an estimate`)
      }
      const fromRole = sumUsage(
        completed.map((row) => ({
          inputUncached: row.tokenUsage.inputUncachedTokens,
          cacheRead: row.tokenUsage.cacheReadTokens,
          cacheWrite: row.tokenUsage.cacheWriteTokens,
          output: row.tokenUsage.outputTokens,
          reasoning: row.tokenUsage.reasoningTokens,
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
      const chats = outcome.exchanges.filter((exchange) => exchange.method === 'POST')
      for (const exchange of chats) {
        const request = chatRequestSummary(exchange.requestBody)
        assert.ok(request, `${label}: a request of the CLI could not be read`)
        if (request.compaction) continue
        for (const name of platformTools)
          assert.ok(request.declared.includes(name), `${label}: ${name} was not declared`)
      }
      // The answers with a usage the sandbox got are the calls the role completed, one for
      // one: nothing was counted twice and nothing went past the role.
      assert.ok(rows.length <= chats.length, `${label}: more calls than requests of the CLI`)
      assert.equal(
        chats.filter(
          (exchange) =>
            exchange.status === 200 && streamSummary(exchange.responseText).usage !== null,
        ).length,
        completed.length,
        `${label}: the completed calls of the role and the answers the sandbox got differ`,
      )
      for (const rpc of ['initialize', 'tools/list'])
        assert.ok(
          outcome.mcp.some((request) => request.rpc === rpc),
          `${label}: MCP ${rpc} missing`,
        )
      assert.ok(
        outcome.mcp.every((request) => request.authorized),
        `${label}: an MCP request without the turn token`,
      )
      const failed = rows.filter((row) => row.state !== 'completed')
      const streams = chats.filter(streamed).map((exchange) => streamSummary(exchange.responseText))
      // Where the usage comes: in the chunk of the finish reason or in a chunk of its own after
      // it. The meter reads both forms, so this is a share for the report, never a failure.
      const metered = streams.filter((stream) => stream.usage !== null)
      const atFinish = metered.filter((stream) => stream.usageAtFinish).length
      report(
        `${label}: exit ${outcome.code}, ${Math.round(outcome.ms / 1000)} s, provider requests ${outcome.requests}, calls ${rows.length} (failed ${failed.length}), tokens in ${fromRole.inputUncached} cached ${fromRole.cacheRead} out ${fromRole.output} reasoning ${fromRole.reasoning}; answers ${chats.map((exchange) => `${exchange.status}/${exchange.ms}ms`).join(' ')}; finish ${streams.map((stream) => stream.finishReasons.at(-1) ?? '-').join(' ')}; usage in the finish chunk ${atFinish} of ${metered.length}${streams.some((stream) => stream.forms.length) ? `; forms ${streams.flatMap((stream) => stream.forms).join(' ')}` : ''}`,
      )
      return { rows, completed, failed, usage: fromRole }
    }

    /** What each turn's last message was worth as a result, by the two readings. */
    const readings = []
    /**
     * An outcome that depends on the model (live.mjs, createOutcome): up to three attempts,
     * each of which holds the invariants; the share goes to the report and never fails the run.
     */
    const outcomeOf = (label, once, { ceiling = TURN_CALLS } = {}) =>
      createOutcome({
        label,
        attempts: ATTEMPTS,
        worst: ceiling,
        budget,
        once: async (attempt) => {
          stage = `${label}, attempt ${attempt}`
          const made = await once(attempt)
          const { verdict, strict, taken } = made.outcome.reading
          readings.push(made.outcome.reading)
          report(
            `${label}, attempt ${attempt}: ${made.ok ? 'outcome reached' : 'outcome missed'}; result: ${taken ? 'taken' : 'refused'} by the reading of the product; by the strict reading of the driver: ${verdict}${made.missed?.length ? `; missed: ${made.missed.join(', ')}` : ''}`,
          )
          return { ...made, verdict, strict, taken }
        },
      })
    // «The result is valid» is what the product would do with it (spec §20, П38).
    const valid = (outcome) => outcome.reading.taken

    if (mode.measure) await measure()
    else if (mode.results) await results()
    else await acceptance()

    /**
     * The acceptance: a turn of each kind — tool, MCP, text and the continuation of the text
     * turn's session. Every kind runs once before any gets a second attempt, so that a model
     * that needs its attempts for one kind cannot leave another untested for want of requests.
     * The retries then take what the budget still covers, the continuation first: it resumes
     * the session the home of the CLI holds only until a turn of another kind follows.
     */
    async function acceptance() {
      const word = `amber-${randomBytes(3).toString('hex')}`
      const marker = `live-tool-${randomBytes(4).toString('hex')}`
      // The key issued for the windows of the account serves the first turn.
      let spare = first
      const fresh = async () => {
        const turn = spare ?? (await issued())
        spare = null
        return turn
      }
      // The first text turn: its session is the one the continuation resumes.
      let session = null

      const tool = outcomeOf('tool turn', async (attempt) => {
        const turn = await fresh()
        await script({
          scenario: 'tools',
          rounds: [[bash(`printf '%s\\n' ${marker} > live-check.txt`)]],
          text: rehearsedText(
            'tool turn',
            attempt,
            resultFor('Synthetic tool turn', ['live-check.txt']),
          ),
        })
        await dockerCommand([
          'exec',
          cli.containerName,
          'rm',
          '-f',
          '/workspace/repo/live-check.txt',
        ])
        const outcome = await runTurn({
          label: 'tool turn',
          turn,
          prompt: `Synthetic check. Create the file live-check.txt in the current directory with exactly one line: ${marker}. Use one shell command. Then reply with the final result.`,
        })
        await invariants(turn, outcome)
        await revoke(turn)
        const written = await dockerCommand([
          'exec',
          cli.containerName,
          'cat',
          '/workspace/repo/live-check.txt',
        ])
        return {
          ok: outcome.code === 0 && valid(outcome) && written.stdout.trim() === marker,
          missed: written.stdout.trim() === marker ? [] : ['the file was not written'],
          outcome,
        }
      })

      const mcp = outcomeOf('MCP turn', async (attempt) => {
        const turn = await fresh()
        await script({
          scenario: 'tools',
          rounds: [[{ name: 'raditi_site_info', arguments: {} }]],
          text: rehearsedText(
            'MCP turn',
            attempt,
            resultFor(`Synthetic MCP turn: ${SYNTHETIC_MCP_MARKER}`),
          ),
        })
        const outcome = await runTurn({
          label: 'MCP turn',
          turn,
          prompt:
            'Synthetic check. Call the platform tool site_info once (it takes no arguments) and reply with the final result; put the value of the field "marker" of its answer into the summary. Call no other tool.',
        })
        await invariants(turn, outcome)
        await revoke(turn)
        const called = outcome.mcp.some(
          (request) => request.rpc === 'tools/call' && request.tool === 'site_info',
        )
        // What the tool answered went back to the model through the body policy of the role.
        const told = outcome.exchanges.some((exchange) =>
          chatRequestSummary(exchange.requestBody)?.toolOutputs.some((output) =>
            String(output).includes(SYNTHETIC_MCP_MARKER),
          ),
        )
        return {
          ok: outcome.code === 0 && valid(outcome) && called && told,
          missed: [
            ...(called ? [] : ['the platform tool was not called']),
            ...(told ? [] : ['its answer did not go back to the model']),
          ],
          outcome,
        }
      })

      const text = outcomeOf('text turn', async (attempt) => {
        const turn = await fresh()
        await script({
          scenario: 'text',
          text: rehearsedText(
            'text turn',
            attempt,
            resultFor(`Synthetic text turn, code word ${word}`),
          ),
        })
        const outcome = await runTurn({
          label: 'text turn',
          turn,
          prompt: `Synthetic check. Do not call any tool. The code word of this session is ${word}: remember it. Reply with the final result only; put the code word into its summary.`,
        })
        await invariants(turn, outcome)
        await revoke(turn)
        if (attempt === 1) {
          assert.ok(outcome.nativeSessionId, 'OpenCode named no session')
          session = { nativeSessionId: outcome.nativeSessionId, turn }
        }
        return {
          ok: outcome.code === 0 && valid(outcome) && outcome.result.summary.includes(word),
          outcome,
        }
      })

      const continuation = outcomeOf('continuation', async (attempt) => {
        // The next turn of the same task, after the text turn or the continuation before it.
        const turn = await issued(undefined, session.turn)
        session.turn = turn
        await script({
          scenario: 'text',
          text: rehearsedText(
            'continuation',
            attempt,
            resultFor(`Synthetic continuation, the code word was ${word}`),
          ),
        })
        const outcome = await runTurn({
          label: 'continuation',
          turn,
          prompt:
            'Synthetic check, continued. Do not call any tool. Reply with the final result only; its summary must contain the code word you were given earlier in this session.',
          nativeSessionId: session.nativeSessionId,
        })
        await invariants(turn, outcome)
        // The session is the platform's to carry: the CLI resumed it from its two files.
        assert.equal(
          outcome.nativeSessionId,
          session.nativeSessionId,
          'The continuation ran in another session',
        )
        const request = chatRequestSummary(outcome.exchanges.at(0)?.requestBody ?? '')
        assert.ok(request && request.messages >= 4, 'The resumed session lost its history')
        await revoke(turn)
        return {
          ok: outcome.code === 0 && valid(outcome) && outcome.result.summary.includes(word),
          outcome,
        }
      })

      // The levels of the API come first: they are what the run owes, not a share, so the
      // budget must cover them; and a turn between the text turn and its continuation would
      // take the session the continuation resumes. Each has a key of its own class.
      if (mode.api) {
        await revoke(spare)
        spare = null
        await levels()
      }
      for (const kind of [tool, mcp, text, continuation]) await kind.first()
      for (const kind of [continuation, text, tool, mcp]) await kind.retries()

      stage = 'the shares of the outcomes'
      const shares = [tool, mcp, text, continuation].map((kind) => kind.share())
      for (const share of shares)
        report(
          `${share.label}: the model's outcome reached in ${share.reached ? 1 : 0} of ${share.attempts} attempt(s)${share.ended === 'budget' ? '; the request budget of the run did not cover another attempt' : ''}`,
        )
      const read = readingShares(readings)
      report(
        `results of ${read.turns} turns: taken by the reading of the product (the supervisor's readTurnResult) in ${read.taken}; valid by the strict reading of the driver in ${read.strict}; the outcomes above and these shares do not decide the run`,
      )
      const held = (share) =>
        `in ${share.attempts} attempt(s) the provider usage in llm_calls equals the CLI and is not estimated, the platform tools were declared, MCP was asked only with the turn token`
      passed(`tool turn: ${held(shares[0])}`)
      passed(`MCP turn: ${held(shares[1])}`)
      passed(`text turn: ${held(shares[2])}`)
      passed(
        `continuation: ${held(shares[3])}; each ran in the session of the first text turn, from its two files, with its history sent again`,
      )

      if (mode.api) {
        // Every request the guards counted is the import's probe or a call of a key: the role
        // asked the provider for no window and no probe of the account.
        const asked = await db.llmCall.count()
        assert.equal(budget.state().used, asked + 1, 'The role asked the API for more than calls')
        if (rehearsal) {
          const synthetic = await control('zai')
          assert.equal(synthetic.counters.quota, 1, 'The monitor path was asked after the import')
          assert.ok(
            synthetic.requests.every((request) =>
              [ZAI_PATHS.apiChat, ZAI_PATHS.quota].includes(request.path),
            ),
            'A request of the API run went to the path of the plan',
          )
        }
        passed(
          `every provider request of the run was the probe of the import or a call of a key (${asked}): no window read, no probe of the account`,
        )
      }

      if (rehearsal) {
        // The scripted model is certain: the shares are exactly those of REHEARSED_MISSES.
        assert.deepEqual(shares, [
          { label: 'tool turn', reached: true, attempts: 1, ended: 'reached' },
          { label: 'MCP turn', reached: true, attempts: 1, ended: 'reached' },
          { label: 'text turn', reached: false, attempts: 3, ended: 'attempts' },
          { label: 'continuation', reached: true, attempts: 2, ended: 'reached' },
        ])
        // The last text answer is one neither reading takes; the continuation was reached on
        // one the product takes and the strict reading does not.
        assert.deepEqual(
          [text.last(), continuation.last()].map(
            ({ verdict, strict, taken }) =>
              `${verdict}: ${strict ? 'strict' : taken ? 'taken' : 'refused'}`,
          ),
          ['schema: files_changed: refused', 'text before the JSON object: taken'],
        )
        assert.deepEqual(read, { turns: 7, taken: 3, strict: 2 })
        passed(
          'rehearsal: the scripted model missed the text outcome in all three attempts and the continuation in its first; the continuation was reached on an answer the product takes and the strict reading of the driver does not (3 of 7 results by the product, 2 by the strict reading); the shares went to the report, the retries followed the first attempt of every kind, and the run went on',
        )
        await live.proveFailureSearch({
          stack,
          places: [{ name: 'events and output of the CLI', texts: outputs }],
        })
        await ceilingAndCap()
      }
    }

    /**
     * The API run: one turn without tools at each of two levels of the same model, low and max.
     * The provider counts the reasoning of each in its usage; the two counts must differ, or
     * the level the profile sets does not reach the API. The answers are not judged.
     */
    async function levels() {
      const counted = {}
      for (const modelClass of ['light', 'heavy']) {
        const { effort } = CLASSES[modelClass]
        const label = `level ${effort}`
        stage = label
        budget.afford(TURN_CALLS, label)
        const turn = await issued({ modelClass })
        // The scripted model of a rehearsal thinks as much as its level lets it.
        await script({
          scenario: 'text',
          text: JSON.stringify(resultFor(`Synthetic level ${effort}`)),
          usage: {
            reasoning: effort === 'low' ? 21 : 340,
            completion: effort === 'low' ? 60 : 380,
          },
        })
        const asked = rehearsal ? (await control('zai')).requests.length : 0
        const outcome = await runTurn({
          label,
          turn,
          effort,
          prompt:
            'Synthetic check. Do not call any tool. Which of the numbers 91, 97 and 99 is prime? Reply with the final result only; put the number into its summary.',
        })
        const { completed, usage } = await invariants(turn, outcome)
        await revoke(turn)
        assert.ok(completed.length > 0, `${label}: no call of the key completed`)
        if (rehearsal)
          for (const request of (await control('zai')).requests.slice(asked))
            assert.equal(request.body.reasoning_effort, effort, `${label}: the level of the body`)
        counted[effort] = usage.reasoning
      }
      report(`reasoning tokens of the API by level: low ${counted.low}, max ${counted.max}`)
      assert.notEqual(
        counted.low,
        counted.max,
        'The two levels of reasoning counted the same reasoning tokens',
      )
      passed(
        'two levels of the same model on the API, low and max: the usage of each counted its own reasoning tokens',
      )
    }

    /** The scripted model of a rehearsal that never stops calling tools. */
    function looping() {
      return {
        scenario: 'tools',
        rounds: Array.from({ length: 30 }, (_, step) => [bash(`printf loop-${step}`)]),
        text: JSON.stringify(resultFor('never reached')),
      }
    }

    /**
     * Rehearsal only: a model that never stops calling tools. The role's own ceiling ends such
     * a turn after TURN_CALLS calls with a final refusal; with that ceiling out of the way the
     * guard ends it at the cap of the run, and the stand fails closed.
     */
    async function ceilingAndCap() {
      stage = 'rehearsal: the ceiling of a turn key'
      budget.afford(TURN_CALLS, 'the looping turn under the ceiling')
      const bounded = await issued()
      await script(looping())
      const asked = await fakeChat()
      const stopped = await runTurn({ label: 'looping turn', turn: bounded, prompt: 'Loop.' })
      assert.equal(stopped.code, 1, 'The looping turn did not end with a failure')
      assert.equal((await fakeChat()) - asked, TURN_CALLS, 'The ceiling of the key did not hold')
      assert.equal(stopped.requests, TURN_CALLS)
      assert.equal((await settled(bounded)).length, TURN_CALLS)
      const key = await db.llmKey.findFirstOrThrow({ where: { taskId: bounded.ref.taskId } })
      assert.equal(key.lastRefusal, 'budget')
      await revoke(bounded)
      passed(
        `rehearsal: a model that never stops is ended by the role after ${TURN_CALLS} calls of its key`,
      )
      await capOfTheRun()
    }

    /**
     * Rehearsal only: the same model with the ceiling of the key out of the way. The guard cuts
     * the run at its cap and the stand stops the turn itself.
     */
    async function capOfTheRun() {
      stage = 'rehearsal: the cap of the run'
      // The reading of the quota the run ends on comes first here: the rest goes to the loop.
      if (!mode.api) {
        const after = await live.quota({ llm, accountId, what: 'at the end' })
        live.growth(before, after)
      }
      await startLlm(600, { LLM_MAX_CALLS_PER_KEY_30S: '1000' })
      const unbounded = await issued()
      await script(looping())
      const left = budget.state().remaining
      assert.ok(left >= 1 && left < 30, `Nothing left for the runaway turn: ${left}`)
      const asked = await fakeChat()
      await assert.rejects(
        runTurn({ label: 'runaway turn', turn: unbounded, prompt: 'Loop.' }),
        /reached its cap of \d+ provider requests/,
      )
      assert.equal(live.tripped(), true, 'The stand did not stop the turn itself')
      assert.equal((await fakeChat()) - asked, left, 'The provider saw a request past the cap')
      const state = budget.state()
      assert.equal(state.used, state.cap)
      // The cap the guard held is the cap of this kind of run, not of another one.
      assert.equal(state.cap, live.limits.requests)
      assert.ok(state.refused >= 1)
      passed(
        `rehearsal: with the ceiling of the key out of the way the guard cut the run at ${state.cap} provider requests and the stand stopped the turn`,
      )
    }

    /**
     * The narrow measurement (--results): the ten turns of verify-llm-live-results.mjs, each
     * under a key of its class whose ceiling is what the turn needs, and nothing else. What
     * the platform owes is held in every turn. What the model made of the result contract goes
     * to the report and never fails the run: by the strict reading of the driver, which the
     * acceptance of П30 counts, and by the reading of the product.
     */
    async function results() {
      // The ten turns were counted for the cap of this kind of run (spec §20, П30), and the
      // limits of a run come from its kind alone: under those of another kind no turn starts.
      assert.equal(live.kind, 'results')
      assert.equal(live.limits.requests, LIVE_LIMITS.results.requests)
      // The key issued for the windows of the account is of no turn of the plan.
      await revoke(first)
      const inRepo = (path) => `${SANDBOX_WORKDIR}/${path}`
      const judged = []
      for (const item of resultPlan) {
        const label = `${item.label} (${item.kind}, ${item.modelClass})`
        stage = label
        // The cap of the run is counted on the ceilings: a turn it does not cover never starts.
        budget.afford(item.ceiling, label)
        if (roleCalls !== item.ceiling) await startLlm(item.ceiling)
        const files = Object.entries(item.before ?? {})
        const stale = [...files.map(([path]) => path), ...(item.written ? [item.written.path] : [])]
        if (stale.length)
          await dockerCommand(['exec', cli.containerName, 'rm', '-f', ...stale.map(inRepo)])
        for (const [path, content] of files) {
          const placed = await dockerCommand(
            ['exec', '-i', cli.containerName, 'sh', '-c', `cat > ${inRepo(path)}`],
            { input: content },
          )
          assert.equal(placed.code, 0, `${label}: a file of the turn could not be placed`)
        }
        const turn = await issued({ modelClass: item.modelClass })
        await script(rehearsalScenario(item))
        const asked = await fakeChat()
        const outcome = await runTurn({
          label,
          turn,
          effort: CLASSES[item.modelClass].effort,
          prompt: item.prompt,
        })
        await invariants(turn, outcome, { ceiling: item.ceiling })
        await revoke(turn)
        const file = item.written
          ? (await dockerCommand(['exec', cli.containerName, 'cat', inRepo(item.written.path)]))
              .stdout
          : null
        const verdict = judgeResult({
          turn: item,
          events: outcome.events,
          code: outcome.code,
          driver,
          file,
        })
        judged.push(verdict)
        report(
          `${label}: result: ${verdict.verdict}; the reading of the product: ${verdict.taken ? 'taken' : 'refused'}${verdict.unmet.length ? `; not as asked: ${verdict.unmet.join(', ')}` : ''}; the prompt ${item.reminded ? 'asked for the final result' : 'left the result to the contract'}`,
        )
        if (rehearsal) {
          // The scripted model is certain: every turn is judged as its form says, and a turn
          // costs what its script sends — one request where the role refused the second.
          const { verdict: read, strict, taken } = verdict
          assert.deepEqual(
            { verdict: read, strict, taken },
            item.miss
              ? REHEARSED_FORMS[item.miss]
              : { verdict: 'valid', strict: true, taken: true },
            label,
          )
          assert.deepEqual(verdict.unmet, [], label)
          const sent = item.miss === 'tool call' ? item.ceiling : (item.rounds?.length ?? 0) + 1
          assert.equal((await fakeChat()) - asked, sent, `${label}: requests of the provider`)
          assert.equal(outcome.requests, sent, `${label}: requests the guards counted`)
          if (item.miss === 'tool call') {
            // The model called a tool under a ceiling of one call: the role refused the next.
            const key = await db.llmKey.findFirstOrThrow({ where: { taskId: turn.ref.taskId } })
            assert.equal(key.lastRefusal, 'budget', `${label}: the ceiling of the key`)
          }
        }
      }

      stage = 'results: the shares'
      const shares = resultShares(judged)
      const of = (part) => `${part.strict} of ${part.turns} (the product takes ${part.taken})`
      report(
        `ten result turns: valid by the strict reading of the driver ${shares.strict} of ${shares.turns}; taken by the reading of the product (the supervisor's readTurnResult) ${shares.taken} of ${shares.turns}`,
      )
      report(
        `by prompt: asked for the final result in words — ${of(shares.reminded)}; left to the contract in the instructions — ${of(shares.plain)}`,
      )
      report(
        `by kind of turn: ${Object.entries(shares.kinds)
          .map(([kind, part]) => `${kind} — ${of(part)}, as asked in ${part.met}`)
          .join('; ')}`,
      )
      report(
        `answers the strict reading did not take: ${
          shares.missed
            .map(
              (item) =>
                `${item.label} (${item.kind}) — ${item.verdict}${item.taken ? ', taken by the product' : ''}`,
            )
            .join('; ') || 'none'
        }`,
      )
      report(
        `acceptance of П30 (at least ${RESULTS_ACCEPTED_FROM} of ${shares.turns} valid by the strict reading): ${shares.accepted ? 'reached' : 'not reached'}; this share does not decide the run`,
      )
      passed(
        `ten result turns: in each the provider usage in llm_calls equals the CLI and is not estimated, the platform tools were declared, MCP was asked only with the turn token, and the key of the turn stayed under its ceiling`,
      )
      if (rehearsal) {
        const { turns, strict, taken, accepted } = shares
        assert.deepEqual(
          { turns, strict, taken, accepted },
          { turns: 10, strict: 6, taken: 8, accepted: false },
        )
        passed(
          'rehearsal: the scripted model answered in the three forms of the real one and called a tool under a ceiling of one call; the stand named each form, the role ended the turn of the tool call, and the shares were 6 of 10 by the strict reading and 8 of 10 by the product',
        )
        await live.proveFailureSearch({
          stack,
          places: [{ name: 'events and output of the CLI', texts: outputs }],
        })
        await capOfTheRun()
      }
    }

    async function measure() {
      let lastReading = null
      /**
       * A reading of the quota, and what was spent since the one before it: the credits of the
       * five-hour window against the provider requests the guards counted in between (the
       * role's own probes of a stale snapshot among them, the readings themselves not).
       */
      const read = async (what) => {
        const reading = await live.quota({ llm, accountId, what })
        const at = budget.state().used
        report(
          `quota ${what}: level ${reading.level ?? 'not named'}, 5h ${reading.credits['5h']?.currentValue}/${reading.credits['5h']?.usage} (remaining ${reading.credits['5h']?.remaining}), week ${reading.credits.week?.currentValue}/${reading.credits.week?.usage}`,
        )
        if (lastReading)
          report(
            `credits between «${lastReading.what}» and «${what}»: ${(reading.credits['5h']?.currentValue ?? 0) - (lastReading.reading.credits['5h']?.currentValue ?? 0)} of the five-hour window, ${(reading.credits.week?.currentValue ?? 0) - (lastReading.reading.credits.week?.currentValue ?? 0)} of the week, for ${at - lastReading.at - 1} provider requests`,
          )
        lastReading = { what, at, reading }
        return reading
      }
      stage = 'measurement: ten turns with a result'
      await revoke(first)
      budget.afford(1, 'the first reading of the quota')
      await read('before the turns')
      const order = [
        'standard',
        'light',
        'heavy',
        'standard',
        'light',
        'heavy',
        'standard',
        'light',
        'heavy',
        'standard',
      ]
      const results = []
      const levels = new Set()
      const providerChats = async () =>
        (await control('zai')).requests.filter((request) => request.path === ZAI_PATHS.chat)
      for (const [index, modelClass] of order.entries()) {
        // Two calls a key at most, and the two readings and the later phases stay covered.
        budget.afford(2 + 13, `result turn ${index + 1}`)
        const [a, b] = [10 + index * 7, 31 + index * 3]
        const turn = await issued({ modelClass })
        await script({
          scenario: 'text',
          text: rehearsedText('result turn', index + 1, resultFor(`The sum is ${a + b}`)),
        })
        const sentBefore = rehearsal ? (await providerChats()).length : 0
        const outcome = await runTurn({
          label: `result turn ${index + 1} (${modelClass})`,
          turn,
          effort: CLASSES[modelClass].effort,
          prompt: `Synthetic check. Do not call any tool. Reply with the final result only; its summary must contain the sum of ${a} and ${b} as a number.`,
        })
        const { usage, rows } = await invariants(turn, outcome, { ceiling: 2 })
        await revoke(turn)
        if (rehearsal) {
          // What the role sent on, as the synthetic provider recorded it. The stand's observer
          // stands in front of the role and never sees the level: the role sets it from the
          // class of the turn key. Only here is «a call of this class completed» shown to mean
          // «this value went to the provider».
          const sent = (await providerChats()).slice(sentBefore)
          assert.equal(sent.length, outcome.requests, 'The provider saw another number of chats')
          for (const request of sent) {
            assert.equal(
              request.body.reasoning_effort,
              CLASSES[modelClass].effort,
              `result turn ${index + 1}: the provider got another reasoning_effort than the level of the class ${modelClass}`,
            )
            assert.deepEqual(request.body.thinking, { type: 'enabled', clear_thinking: false })
          }
          levels.add(CLASSES[modelClass].effort)
        }
        results.push({
          modelClass,
          reading: outcome.reading,
          accepted: rows.some((row) => row.state === 'completed'),
          right: valid(outcome) && outcome.result.summary.includes(String(a + b)),
          usage,
          requests: outcome.requests,
        })
      }
      const counted = readingShares(results.map((item) => item.reading))
      report(
        `ten turns with a result: taken by the reading of the product ${counted.taken} of ${counted.turns}, valid by the strict reading of the driver ${counted.strict}, with the right sum ${results.filter((item) => item.right).length}; the strict reading by turn: ${results.map((item) => `${item.modelClass}=${item.reading.verdict}`).join('; ')}`,
      )
      // «Completed» is what a live run can see of a level: a call of a key of that class went
      // through. That the role sends the level of the class is shown by the rehearsal above.
      for (const modelClass of Object.keys(CLASSES)) {
        const of = results.filter((item) => item.modelClass === modelClass)
        report(
          `reasoning_effort ${CLASSES[modelClass].effort} (${modelClass}): a call of a key of this class completed in ${of.filter((item) => item.accepted).length} of ${of.length} turns; reasoning tokens ${of.map((item) => item.usage.reasoning).join(' ')}, output ${of.map((item) => item.usage.output).join(' ')}`,
        )
      }
      if (rehearsal) {
        assert.deepEqual([...levels].sort(), ['high', 'low', 'max'])
        passed(
          'rehearsal: every request of the ten result turns reached the synthetic provider with the reasoning_effort of the class of its key (low, high, max) and thinking enabled',
        )
        // The scripted model wrapped one result in a sentence and left a key out of another.
        assert.deepEqual(counted, { turns: 10, taken: 9, strict: 8 })
        assert.deepEqual(
          results.slice(1, 3).map(({ reading }) => `${reading.verdict}: ${reading.taken}`),
          ['text before the JSON object: true', 'schema: files_changed: false'],
        )
        passed(
          'rehearsal: of the ten result turns the product took nine and the strict reading of the driver eight; the answer with a sentence before the object counts as a result, the one without files_changed does not',
        )
      }
      budget.afford(1 + 12, 'the reading of the quota after the result turns')
      await read('after the result turns')
      report(
        `result turns: ${results.reduce((sum, item) => sum + item.requests, 0)} provider requests in ${results.length} turns`,
      )

      stage = 'measurement: two requests at once'
      budget.afford(2 + 10, 'two requests at once')
      const pair = await issued()
      await script({ scenario: 'text', text: 'ok' })
      const body = JSON.stringify({
        model: ZAI_MODEL,
        max_tokens: 32_000,
        messages: [{ role: 'user', content: 'Synthetic check. Reply with the single word ok.' }],
        stream: true,
        stream_options: { include_usage: true },
      })
      // Both from the sandbox at the same moment, with the key of one turn on the input.
      const together = await dockerCommand(
        [
          'exec',
          '-i',
          cli.containerName,
          'node',
          '-e',
          `let input='';process.stdin.on('data',(c)=>input+=c).on('end',async()=>{
const {key,body,agent}=JSON.parse(input);const started=Date.now();
const one=async()=>{const r=await fetch('${GATEWAY}/zai/v4/chat/completions',{method:'POST',
headers:{authorization:'Bearer '+key,'content-type':'application/json','user-agent':agent},body});
const text=await r.text();return{status:r.status,ms:Date.now()-started,done:text.includes('[DONE]')}};
console.log(JSON.stringify(await Promise.all([one(),one()])))})`,
        ],
        {
          input: JSON.stringify({ key: pair.values.llmApiKey, body, agent: opencodeUserAgent }),
          timeoutMs: 120_000,
        },
      )
      outputs.push(together.stdout, together.stderr)
      const answers = JSON.parse(together.stdout)
      const pairRows = await settled(pair)
      await revoke(pair)
      report(
        `two requests at once: statuses ${answers.map((answer) => `${answer.status}/${answer.ms}ms${answer.done ? '' : '/no DONE'}`).join(' ')}; calls ${pairRows.map((row) => row.state).join(' ')}`,
      )

      stage = 'measurement: a series of short tool steps on the light profile'
      const SERIES = 9
      await startLlm(SERIES)
      budget.afford(SERIES + 1, 'the series of tool steps')
      const series = await issued({ modelClass: 'light' })
      await script({
        scenario: 'tools',
        rounds: Array.from({ length: 6 }, (_, step) => [bash(`echo step-${step + 1}`)]),
        text: JSON.stringify(resultFor('Synthetic series')),
      })
      const ran = await runTurn({
        label: 'series turn (light)',
        turn: series,
        effort: 'low',
        prompt:
          'Synthetic check. Run these six shell commands one at a time, each as a separate tool call, in this order: `echo step-1`, `echo step-2`, `echo step-3`, `echo step-4`, `echo step-5`, `echo step-6`. Do not combine them. Then reply with the final result.',
      })
      const seriesRows = (await invariants(series, ran, { ceiling: SERIES })).rows
      await revoke(series)
      report(
        `series turn: exit ${ran.code}; result: ${ran.reading.taken ? 'taken' : 'refused'} by the reading of the product; by the strict reading of the driver: ${ran.reading.verdict}; tool calls the driver reported: ${ran.events.filter((event) => event.type === 'tool_call' || event.type === 'command').length}`,
      )
      const starts = seriesRows.map((row) => row.startedAt.getTime())
      const pace = Math.max(
        0,
        ...starts.map((from) => starts.filter((at) => at >= from && at < from + 30_000).length),
      )
      report(
        `series turn: ${seriesRows.length} calls, at most ${pace} within any 30 s (the pace limit of a key is 20); steps took ${ran.exchanges.map((exchange) => `${exchange.ms}ms`).join(' ')}`,
      )
      if (rehearsal) await bodyRefusals()
      const end = await read('at the end')
      live.growth(before, end)

      const completed = await db.llmCall.findMany({
        where: { state: 'completed' },
        include: { tokenUsage: true },
        orderBy: { startedAt: 'asc' },
      })
      const cached = completed.reduce((sum, row) => sum + row.tokenUsage.cacheReadTokens, 0)
      const input = completed.reduce(
        (sum, row) => sum + row.tokenUsage.cacheReadTokens + row.tokenUsage.inputUncachedTokens,
        0,
      )
      report(
        `cache without x-session-affinity: ${cached} of ${input} input tokens (${input ? ((cached * 100) / input).toFixed(1) : '0'} %) over ${completed.length} completed calls; per call ${completed.map((row) => `${row.tokenUsage.cacheReadTokens}/${row.tokenUsage.cacheReadTokens + row.tokenUsage.inputUncachedTokens}`).join(' ')}`,
      )
      passed('measurement finished: the numbers are in the REPORT lines')
    }

    /**
     * Rehearsal only, and a measurement, not a rule of the gateway (spec §20, П42): what the
     * pinned CLI does when a request of its turn is answered HTTP 400 `raditi_body`, the refusal
     * of a body that is too large. Three turns get the real bytes of a refusal where an answer
     * of the role would come: sandbox-gw is asked from the CLI container by a request one byte
     * longer than it takes (it answers once it has read the body), the role llm by the very
     * request of the CLI, declared one byte longer; the observer gives them to the CLI through
     * sandbox-gw — once from each side, and for every request of a turn. The fourth turn sends,
     * from the CLI itself, a body that really is too large: the synthetic model thinks as many
     * bytes as the gateway takes before it calls a tool, the CLI sends that reasoning back with
     * its next request, and sandbox-gw itself refuses that request.
     */
    async function bodyRefusals() {
      stage = 'measurement: the refusal of a body that is too large'
      const declared = String(llmJsonLimits.bytes + 1)
      const chat = new URL(`${ZAI_GATEWAY_BASE_URL}/chat/completions`)
      const asked = await dockerCommand(
        [
          'exec',
          cli.containerName,
          'node',
          '-e',
          `const request=require('node:http').request({host:process.argv[1],port:process.argv[2],
path:process.argv[3],method:'POST',headers:{'content-type':'application/json',
'content-length':process.argv[4]}},(answer)=>{let body='';answer.on('data',(chunk)=>{body+=chunk})
.on('end',()=>{console.log(JSON.stringify({status:answer.statusCode,
contentType:answer.headers['content-type'],body}));process.exit(0)})});
request.on('error',()=>process.exit(1));request.end(Buffer.alloc(Number(process.argv[4]),120))`,
          chat.hostname,
          chat.port,
          chat.pathname,
          declared,
        ],
        { timeoutMs: 30_000 },
      )
      assert.equal(asked.code, 0, 'sandbox-gw did not answer a request with too long a body')
      const ofGateway = JSON.parse(asked.stdout)
      assert.deepEqual([ofGateway.status, ofGateway.contentType], [400, 'application/json'])
      const refusalOf = (message) => ({
        error: { type: 'invalid_request_error', code: 'raditi_body', message },
      })
      assert.deepEqual(JSON.parse(ofGateway.body), refusalOf('Request body is too large'))
      const fromGateway = async () => ({
        status: ofGateway.status,
        headers: { 'content-type': ofGateway.contentType },
        body: ofGateway.body,
      })
      /** The role's own refusal of this request of the CLI, were its body one byte too long. */
      const fromRole = ({ method, path, headers }) =>
        new Promise((resolve, reject) => {
          const { 'transfer-encoding': _chunked, ...sent } = headers
          const request = httpRequest(
            {
              host: '127.0.0.1',
              port: rolePort,
              method,
              path,
              agent: false,
              headers: { ...sent, host: `127.0.0.1:${rolePort}`, 'content-length': declared },
            },
            (answer) => {
              const chunks = []
              answer.on('data', (chunk) => chunks.push(chunk))
              answer.on('error', reject)
              answer.on('end', () => {
                resolve({
                  status: answer.statusCode,
                  headers: { 'content-type': answer.headers['content-type'] },
                  body: Buffer.concat(chunks),
                })
                request.destroy()
              })
            },
          )
          request.on('error', reject)
          // The headers alone: the role refuses by the declared length, before it reads a byte.
          request.flushHeaders()
        })

      await startLlm(BODY_TURN_CALLS)
      const measured = []
      /** What the CLI sent, in its order, and what the turn came to. */
      const measure = async ({ label, outcome, rows, refused, sentBefore }) => {
        // A request of the turn or one for a compaction (it declares no tools), the status it
        // got, and its size against the first request.
        const first = outcome.exchanges[0]?.requestBody.length ?? 0
        const requests = outcome.exchanges.map((exchange) => {
          const request = chatRequestSummary(exchange.requestBody)
          return {
            kind: request?.compaction ? 'compaction' : 'turn',
            status: exchange.status,
            messages: request?.messages ?? null,
            grew: exchange.requestBody.length > first,
            byStand: exchange.answeredByStand,
          }
        })
        const failures = outcome.events
          .filter((event) => event.type === 'failed')
          .map((event) => event.reason)
        measured.push({
          label,
          exit: outcome.code,
          refused,
          requests: requests.map((request) => `${request.kind} ${request.status}`),
          provider: (await fakeChat()) - sentBefore,
          calls: rows.length,
          result: outcome.reading.taken,
          failures: failures.map((reason) => reason.split(':')[0]),
        })
        return { requests, failures }
      }
      for (const { label, answer, refusals } of [
        { label: 'one request refused by sandbox-gw', answer: fromGateway, refusals: 1 },
        { label: 'one request refused by the role llm', answer: fromRole, refusals: 1 },
        {
          label: 'every request refused by sandbox-gw',
          answer: fromGateway,
          refusals: BODY_REFUSALS_AT_MOST,
        },
      ]) {
        stage = `measurement: ${label}`
        budget.afford(BODY_TURN_CALLS, label)
        const turn = await issued()
        await script({
          scenario: 'text',
          text: JSON.stringify(resultFor('Synthetic turn after a refused body')),
        })
        for (let count = 0; count < refusals; count += 1) observer.answerNext(answer)
        const sentBefore = await fakeChat()
        const outcome = await runTurn({
          label,
          turn,
          prompt: 'Synthetic check. Do not call any tool. Reply with the final result only.',
        })
        const refused = refusals - observer.dropAnswers()
        const { rows } = await invariants(turn, outcome, { ceiling: BODY_TURN_CALLS })
        await revoke(turn)
        for (const exchange of outcome.exchanges.filter((item) => item.answeredByStand))
          assert.equal(JSON.parse(exchange.responseText).error.code, 'raditi_body', label)
        const { requests, failures } = await measure({ label, outcome, rows, refused, sentBefore })
        report(
          `${label}: exit ${outcome.code}, ${Math.round(outcome.ms / 1000)} s; the CLI sent ${requests.length} request(s): ${requests.map((request) => `${request.kind}/${request.status}/${request.messages} messages${request.grew ? '/longer than the first' : ''}`).join(', ')}; refused by the stand ${refused} of ${refusals} prepared; reached the role ${requests.filter((request) => !request.byStand).length + (answer === fromRole ? refused : 0)}, the provider ${measured.at(-1).provider}; calls of the key ${rows.length} of ${BODY_TURN_CALLS}; result ${outcome.reading.taken ? 'taken' : 'none'}; failures the driver reported: ${failures.join(' | ') || 'none'}`,
        )
      }

      {
        const label = 'a request above the limit, refused by sandbox-gw itself'
        stage = `measurement: ${label}`
        budget.afford(BODY_TURN_CALLS, label)
        const turn = await issued()
        await script({
          scenario: 'tools',
          calls: [bash('echo filler')],
          // As many bytes of reasoning as a whole request may have: the next one is above it.
          filler: llmJsonLimits.bytes,
          text: JSON.stringify(resultFor('never reached')),
        })
        const sentBefore = await fakeChat()
        const outcome = await runTurn({
          label,
          turn,
          prompt:
            'Synthetic check. Run the shell command `echo filler` once, then reply with the final result.',
        })
        // Not `invariants`: the observer keeps the first megabytes of an exchange, and the usage
        // of this answer stands behind sixteen of them.
        const rows = await settled(turn)
        await revoke(turn)
        assert.deepEqual(
          rows.map((row) => [row.state, row.tokenUsage?.estimated]),
          [['completed', false]],
          `${label}: the step before the refused request is the one call of the key`,
        )
        const { requests, failures } = await measure({
          label,
          outcome,
          rows,
          refused: 0,
          sentBefore,
        })
        // The refused request never came to the observer, so not to the role either, and the
        // text of the refusal is that of sandbox-gw: the role says another sentence.
        assert.equal(outcome.exchanges.at(0)?.truncated, true, `${label}: the answer was short`)
        assert.deepEqual(
          failures,
          ['APIError 400 raditi_body: Request body is too large'],
          `${label}: the CLI did not report the refusal of sandbox-gw`,
        )
        assert.ok(
          outcome.events.some((event) => event.type === 'command'),
          `${label}: the CLI did not run the tool of the first step`,
        )
        report(
          `${label}: exit ${outcome.code}, ${Math.round(outcome.ms / 1000)} s; the CLI sent ${requests.length} request(s) that reached the role: ${requests.map((request) => `${request.kind}/${request.status}`).join(', ')}, the answer of ${llmJsonLimits.bytes} bytes of reasoning beside a tool call, and one more that sandbox-gw refused itself; the provider got ${measured.at(-1).provider}; calls of the key ${rows.length} of ${BODY_TURN_CALLS}; result ${outcome.reading.taken ? 'taken' : 'none'}; failures the driver reported: ${failures.join(' | ') || 'none'}`,
        )
      }
      report(`refused bodies, measured: ${JSON.stringify(measured)}`)
      const { given, uploaded } = BODY_REFUSAL_MEASURED
      assert.deepEqual(
        measured,
        [
          { label: 'one request refused by sandbox-gw', ...given },
          { label: 'one request refused by the role llm', ...given },
          { label: 'every request refused by sandbox-gw', ...given },
          {
            label: 'a request above the limit, refused by sandbox-gw itself',
            ...uploaded,
          },
        ],
        'The pinned CLI reacted to HTTP 400 raditi_body otherwise than measured',
      )
      passed(
        'rehearsal: HTTP 400 raditi_body, the real refusal of sandbox-gw and of the role llm, as the pinned OpenCode takes it: a failure reported and the end of the turn in that one request, exit 1, no request for a compaction and no repeat; the same for a request of the CLI that really is above the limit, which sandbox-gw refuses itself',
      )
    }

    stage = 'the end of the run'
    // Every row of llm_calls of the run, by state, and what the role's log says of the provider.
    const states = await live.reportCalls(db)
    const forms = new Set(
      observer
        .exchanges()
        .filter(streamed)
        .flatMap((exchange) => streamSummary(exchange.responseText).forms),
    )
    report(
      `stream forms no scenario of the synthetic provider makes (of the ${STREAM_FORMS.length} the stand looks for): ${[...forms].join(' ') || 'none'}; the pinned user-agent was ${Object.keys(states).length ? 'accepted' : 'never sent'}`,
    )
    if (!rehearsal || !live.tripped()) {
      for (const turn of refs) await revoke(turn).catch(() => {})
      if (!mode.measure && !rehearsal && !mode.api) {
        const after = await live.quota({ llm, accountId, what: 'at the end' })
        live.growth(before, after)
      }
    }
    await live.keepExchanges()

    stage = `the search for the ${live.keyWord}`
    const projectContainers = (
      await run('docker', [
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${stack.project}`,
      ])
    ).stdout
      .split('\n')
      .filter(Boolean)
    const inspected = await run('docker', [
      'inspect',
      ...projectContainers,
      ...(live.tripped() ? [] : [cli.containerName, `${stack.project}-guard`]),
    ])
    const places = await live.assertKeyNowhere({
      stack,
      places: [
        {
          name: 'logs of the services',
          text: (await stack.compose(['logs', '--no-color'])).stdout,
        },
        {
          name: 'audit log of OpenBao',
          text: (await stack.compose(['exec', '-T', 'vault', 'cat', '/audit/audit.jsonl'])).stdout,
        },
        {
          name: 'database dump',
          text: (
            await stack.compose([
              'exec',
              '-T',
              'postgres',
              'pg_dump',
              '-U',
              'postgres',
              '-d',
              'raditi',
              '--data-only',
            ])
          ).stdout,
        },
        { name: 'events and output of the CLI', texts: outputs },
        {
          name: 'control port of the synthetic services',
          text: JSON.stringify(rehearsal ? await control('zai') : await control('state')),
        },
        { name: 'docker inspect of the containers', text: inspected.stdout },
      ],
    })
    passed(
      `the ${live.keyWord} is in none of ${places} places: logs, audit, database, CLI events, exchanges, control port, docker inspect, the files of the sandbox and of the stand`,
    )
    const what = mode.measure
      ? 'measurement'
      : mode.results
        ? 'measurement of results'
        : 'verification'
    if (rehearsal && !mode.measure) {
      // The cap was reached on purpose: the count of the run says so itself.
      assert.throws(() => live.settle(), /reached its cap of \d+ provider requests/)
      assert.equal(live.tripped(), true)
      console.log(
        `Rehearsal of the live gateway ${what} passed: ${live.checks()} checks; the cap of ${live.limits.requests} provider requests was reached on purpose and held.`,
      )
    } else {
      const state = live.settle()
      // The exit code is of what the platform owes: the last line says where the model's part is.
      console.log(
        `${rehearsal ? 'Rehearsal of the live' : 'Live'} gateway ${what} passed: ${live.checks()} checks; ${state.used} of ${state.cap} provider requests; OpenCode 1.18.34 on the ${rehearsal ? 'synthetic' : 'real'} provider.${mode.measure ? '' : " The checks are of what the platform owes; the model's outcomes are shares in the REPORT lines."}`,
      )
    }
  } catch (error) {
    code = 1
    if (error instanceof LiveRefusal) {
      console.error(`Live verification refused to start: ${error.message}`)
      code = REFUSED
    } else {
      if (error.infrastructureDiagnostic) console.error(error.infrastructureDiagnostic)
      // The first line of the failure: the stand's own words, names and numbers. Never when
      // the failure, read whole, holds the key.
      const line = failureLine(error, live.key)
      if (line) console.error(line)
      const reason = live.expired()
        ? ' (the time limit of the run)'
        : interrupted
          ? ' (interrupted)'
          : ''
      console.error(`Live gateway verification failed at: ${stage}${reason}.`)
      try {
        const state = budget.state()
        report(
          `provider requests at the failure: ${state.used} of ${state.cap} (refused ${state.refused})`,
        )
      } catch {
        /* The ledger is gone with the run directory. */
      }
    }
    // Before the cleanup removes it: the search for the key over what the run still holds,
    // and with --keep the exchanges, for the diagnosis of the failure.
    await live.afterFailure({
      stack,
      places: [{ name: 'events and output of the CLI', texts: outputs }],
    })
  } finally {
    // The OpenBao container holds the plan key until the stack is removed: the stack last, and
    // every step tried whatever the others did.
    const cleanup = [
      () => cli?.close(),
      ...workers
        .slice()
        .reverse()
        .map((worker) => () => worker.close()),
      () => db?.$disconnect(),
      async () => {
        if (!(await live.close())) throw new Error('cleanup')
      },
      () => stack?.close(),
    ]
    for (const close of cleanup) {
      try {
        await close()
      } catch {
        console.error('An owned verification resource could not be cleaned up')
        code ||= 1
      }
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  return code
}
