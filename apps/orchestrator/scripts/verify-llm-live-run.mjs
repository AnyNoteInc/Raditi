/* global Buffer, clearTimeout, console, fetch, setTimeout, URL */
// What a live run of a stand is, shared by verify:llm-gateway and verify:agent-content: the
// refusals before anything starts, the plan key held in this process alone, the ledger and the
// guards of the request cap, the role llm in its live profile behind the stand's observer, the
// import of the key by the operator command, the windows the run starts and ends on, the watch
// of the ledger while a turn runs, and the search for the key — whole at the end of a run that
// passed, over what the run still holds after a failure. `--rehearsal` runs the same code on
// the synthetic Z.ai, with the guards pointed at it: the cap, the refusals and the search are
// proven there before a request is sent to the real provider. Rules and limits:
// infra/dev/llm-verify/README.md.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { CLI_IMAGE, dockerCommand } from '../../../infra/dev/llm-verify/cli.mjs'
import { SYNTHETIC_ZAI_KEY } from '../../../infra/dev/llm-verify/fake-zai.mjs'
import {
  commandAnswer,
  createBudget,
  createStreamSearch,
  guardImport,
  keepExchanges,
  LIVE_LIMITS,
  LiveRefusal,
  liveStartRefusal,
  PROVIDER,
  providerSignals,
  searchPlaces,
  searchWhatIsLeft,
  startLlmObserver,
  takePlanKey,
  watchLedger,
  WINDOW_GROWTH_LIMIT,
  windowGrowth,
  windowStartRefusal,
} from '../../../infra/dev/llm-verify/live.mjs'
import {
  abortVerification,
  eventually,
  repository,
  run,
} from '../../../infra/dev/llm-verify/stack.mjs'
import { startWorker } from '../../../infra/dev/llm-verify/workers.mjs'
import { bridgeGatewayAddress, freePort } from './verify-agent-content-role.mjs'
import { OPENCODE_HOME, ZAI_BACKEND } from './verify-llm-zai-setup.mjs'

/** The exit code of a run that refused to start: nothing was started and nothing was sent. */
export const REFUSED = 2
const LABEL = 'live-zai'
// Everything the agent can write to in the CLI container, the session database included.
const SANDBOX_ROOTS = ['/agent-home', '/workspace', '/tmp', '/run/raditi']
const GUARD_IMAGE = 'raditi-p3verify-guard:b13'

/**
 * Opens a run, or returns REFUSED after saying why. `kind` names the limits: gateway, content
 * or measure. The plan key leaves the environment here, before any other process exists.
 * `onExpire` is called when the run outlives its minutes.
 */
export async function openLiveRun({ mode, kind, onExpire = () => {} }) {
  const rehearsal = mode.rehearsal
  const limits = LIVE_LIMITS[kind]
  let key
  let refusal = rehearsal ? null : liveStartRefusal(process.env)
  try {
    // A rehearsal never touches a real key: whatever the environment holds is dropped unread.
    if (rehearsal) delete process.env.ZAI_API_KEY
    key = takePlanKey(rehearsal ? { ZAI_API_KEY: SYNTHETIC_ZAI_KEY } : process.env)
  } catch (error) {
    if (!(error instanceof LiveRefusal)) throw error
    refusal ??= error.message
  }
  if (refusal) {
    console.error(`Live verification refused to start: ${refusal}`)
    return REFUSED
  }

  const directory = await mkdtemp(join(tmpdir(), 'raditi-live-'))
  const ledger = join(directory, 'ledger')
  // One request is kept for the reading of the quota the run ends on.
  const budget = createBudget({ cap: limits.requests, ledger, reserve: 1 })
  let provider = rehearsal ? null : PROVIDER
  const guard = (cap) => guardImport({ ledger, cap, provider })
  // The stand's own process reaches no provider at all, whatever its code does.
  if (provider) await import(guard(0))

  let checks = 0
  const startedAt = Date.now()
  let expired = false
  const deadline = setTimeout(() => {
    expired = true
    abortVerification()
    onExpire()
  }, limits.minutes * 60_000)
  deadline.unref()
  const closers = []
  const logs = []
  let observer
  let tripped = false
  let closing

  const live = {
    rehearsal,
    kind,
    limits,
    key,
    budget,
    guard,
    label: LABEL,
    /** A line of the report: numbers and names the stand measured, never content. */
    report: (line) => console.log(`REPORT ${line}`),
    passed(name) {
      checks += 1
      console.log(`PASS ${name}`)
    },
    checks: () => checks,
    seconds: () => Math.round((Date.now() - startedAt) / 1000),
    expired: () => expired,
    /**
     * What the run printed outside the stack — every worker, every command of the operator —
     * as a list of chunks for each pipe: a search joins the chunks of one pipe.
     */
    logs,
    onClose: (close) => closers.push(close),

    /** The synthetic provider of a rehearsal stands where the real one stands in a live run. */
    async useProvider(stack) {
      if (!rehearsal) return
      provider = { host: 'localhost', port: Number(new URL(stack.providerOrigin).port) }
      await import(guard(0))
    },

    /**
     * The environment of the role llm: the direct path, the turn-key ceiling of this run, and
     * in a live run nothing that names a CA or an address. The role listens on loopback behind
     * the stand's observer.
     */
    roleEnvironment({ stack, rolePort, metricsToken, callsPerKey, overrides = {} }) {
      return {
        APP_ENV: 'test',
        DATABASE_URL: stack.databaseUrl,
        VAULT_ADDR: stack.vaultAddress,
        METRICS_TOKEN: metricsToken,
        LLM_GATEWAY_PORT: String(rolePort),
        LLM_GATEWAY_LISTEN_HOST: '127.0.0.1',
        LLM_GATEWAY_CLIENTS: '127.0.0.1/32',
        LLM_GATEWAY_HOSTS: `127.0.0.1:${rolePort}`,
        LLM_MAX_CALLS_PER_KEY: String(callsPerKey),
        ...(rehearsal
          ? {
              LLM_UPSTREAM_CA_FILE: join(stack.certificates.authority, 'root.pem'),
              LLM_BACKEND_URL_ZAI_CODING: stack.providerOrigin,
            }
          : {}),
        ...overrides,
      }
    },

    /** The role llm as a worker of its own, under AppRole llm and the request guard. */
    async startLlm({ stack, env }) {
      const worker = await startWorker(
        'llm',
        {
          env: {
            ...env,
            VAULT_ROLE_ID: stack.roles.llm.roleId,
            VAULT_SECRET_ID: stack.roles.llm.secretId,
          },
          profile: rehearsal ? 'synthetic' : 'live',
        },
        { imports: [guard(limits.requests)] },
      )
      logs.push(...worker.streams)
      const port = env.LLM_GATEWAY_PORT
      await eventually(async () => (await fetch(`http://127.0.0.1:${port}/health`)).status === 200)
      // The role says which way it goes when it starts: its own connection, no proxy.
      const line = '{"event":"llm_egress_path","path":"direct"}'
      await eventually(async () => worker.logs.join('').includes(line), 10_000)
      return worker
    },

    /** The trusted core worker; a connection of its own to the provider would be a defect. */
    async startCore({ stack, env, rolePort }) {
      const worker = await startWorker(
        'core',
        {
          env: {
            ...env,
            VAULT_ROLE_ID: stack.roles.core.roleId,
            VAULT_SECRET_ID: stack.roles.core.secretId,
          },
          llmControlUrl: `http://127.0.0.1:${rolePort}`,
        },
        { imports: [guard(0)] },
      )
      logs.push(...worker.streams)
      return worker
    },

    /**
     * The stand's hop in front of the role llm, on the port sandbox-gw sends to; the role
     * itself then listens on a loopback port of its own.
     */
    async startObserver(stack) {
      const rolePort = await freePort()
      let listenHost = '127.0.0.1'
      if (process.platform === 'linux') {
        const inspected = await run('docker', [
          'network',
          'inspect',
          'bridge',
          '--format',
          '{{(index .IPAM.Config 0).Gateway}}',
        ])
        listenHost = bridgeGatewayAddress(inspected.stdout)
      }
      observer = await startLlmObserver({
        listenHost,
        port: stack.llmPort,
        upstream: `http://127.0.0.1:${rolePort}`,
      })
      closers.push(() => observer.close())
      return { observer, rolePort }
    },

    /**
     * `subscriptions:login --backend zai-coding` with the key on its input: the one place the
     * value goes. The command runs under the guard, so its quota request is counted with the
     * rest. Returns the id of the account, created switched off.
     */
    async importKey({ stack, db }) {
      budget.afford(1, 'the import of the plan key')
      const writerFile = join(stack.directory, 'writer.token')
      await writeFile(writerFile, stack.tokens['subscriptions-writer'], { mode: 0o400 })
      const imported = await run(
        process.execPath,
        [
          '--import',
          guard(limits.requests),
          join(repository, 'apps/orchestrator/scripts/subscription-login.mjs'),
          '--backend',
          ZAI_BACKEND,
          '--label',
          LABEL,
          '--plan',
          'lite',
          '--vault-token-file',
          writerFile,
        ],
        {
          input: key.input(),
          env: {
            APP_ENV: 'test',
            DATABASE_URL: stack.databaseUrl,
            VAULT_ADDR: stack.vaultAddress,
            ...(rehearsal
              ? {
                  LLM_UPSTREAM_CA_FILE: join(stack.certificates.authority, 'root.pem'),
                  LLM_BACKEND_URL_ZAI_CODING: stack.providerOrigin,
                }
              : {}),
          },
          allowFailure: true,
        },
      )
      logs.push([imported.stdout], [imported.stderr])
      // The command was handed the key: what it printed is kept for the search, never quoted.
      const answer = commandAnswer(imported, 'The import of the plan key')
      assert.deepEqual(answer, {
        accountId: answer.accountId,
        backend: ZAI_BACKEND,
        credentialVersion: 1,
        enabled: false,
      })
      // The import asked the quota once, and an account exists only because the provider
      // answered it: nobody has written its windows yet.
      assert.equal(budget.state().used, 1, 'The import did not ask the provider exactly once')
      const account = await db.subscriptionAccount.findUniqueOrThrow({
        where: { id: answer.accountId },
      })
      assert.partialDeepStrictEqual(account, { driverId: 'opencode', health: 'ok', enabled: false })
      assert.equal(account.limitWindows?.length ?? 0, 0)
      return answer.accountId
    },

    /**
     * The windows the role's probe stored for the account, once a first key was issued; a
     * LiveRefusal when the run must not start on them.
     */
    async admitWindows({ db, accountId }) {
      const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
      const refused = windowStartRefusal(account.limitWindows)
      if (refused) throw new LiveRefusal(refused)
      assert.ok(Date.now() - account.limitsSeenAt.getTime() < 120_000, 'The snapshot is not new')
      const windows = Object.fromEntries(account.limitWindows.map((w) => [w.name, w]))
      live.report(
        `windows at the start: 5h ${windows['5h'].usedPct.toFixed(2)} %, week ${windows.week.usedPct.toFixed(2)} %`,
      )
      return windows
    },

    /** The quota as the provider answers it now (the worker's `quota`), one request. */
    async quota({ llm, accountId, what }) {
      const reading = await llm.call('quota', { accountId }, 40_000)
      assert.equal(reading.status, 'ok', `The quota could not be read ${what}`)
      const windows = Object.fromEntries(reading.windows.map((w) => [w.name, w]))
      const credits = Object.fromEntries(
        reading.limits.map((limit) => [
          limit.unit === 3 && limit.number === 5
            ? '5h'
            : limit.unit === 6 && limit.number === 1
              ? 'week'
              : `${limit.unit}x${limit.number}`,
          limit,
        ]),
      )
      return { level: reading.level, windows, credits }
    },

    /** Fails the run when the five-hour window grew by more than the limit since `before`. */
    growth(before, after) {
      const grown = windowGrowth(before['5h'], after.windows['5h'])
      live.report(
        `windows at the end: 5h ${after.windows['5h'].usedPct.toFixed(2)} %, week ${after.windows.week.usedPct.toFixed(2)} %; the five-hour window grew by ${grown.toFixed(2)} points; plan level ${after.level ?? 'not named'}`,
      )
      assert.ok(
        grown <= WINDOW_GROWTH_LIMIT,
        `The five-hour window grew by ${grown.toFixed(2)} points, above ${WINDOW_GROWTH_LIMIT}`,
      )
      return grown
    },

    /**
     * Runs a turn under the watch of the ledger. A connection a guard refused — over the cap of
     * the run or to another host — ends the turn at once: `stop` closes the CLI, instead of the
     * CLI repeating until its own limits. Fail closed: the flow then asks `budget.assertHeld()`.
     */
    async watched(turn, stop) {
      const watch = watchLedger(budget, () => {
        tripped = true
        void Promise.resolve()
          .then(stop)
          .catch(() => {})
      })
      try {
        return await turn()
      } finally {
        watch.end()
      }
    },
    /** Whether a turn of the run was stopped by that watch. */
    tripped: () => tripped,

    /**
     * The calls of the run by state, and what the log of the role llm says of the provider's
     * refusals, as a line of the report.
     */
    async reportCalls(db) {
      const states = {}
      for (const row of await db.llmCall.findMany({ orderBy: { startedAt: 'asc' } }))
        states[row.state] = (states[row.state] ?? 0) + 1
      const { codes, signals } = providerSignals(logs.flat().join(''))
      live.report(
        `llm_calls: ${
          Object.entries(states)
            .map(([state, count]) => `${state} ${count}`)
            .join(', ') || 'none'
        }; provider codes in the log of the role: ${codes.join(' ') || 'none'}; signals: ${signals.join(' ') || 'none'}`,
      )
      return states
    },

    /**
     * The isolated CLI container's companion: the network guard of the sandbox image, in the
     * network namespace of the CLI container.
     */
    async startNetworkGuard({ stack, cli }) {
      const name = `${stack.project}-guard`
      await run('docker', [
        'run',
        '-d',
        '--pull=never',
        '--name',
        name,
        '--network',
        `container:${cli.containerName}`,
        '--user',
        '0:0',
        '--read-only',
        '--cap-drop=ALL',
        '--cap-add=NET_ADMIN',
        '--security-opt=no-new-privileges',
        '--tmpfs',
        '/run/raditi-guard:rw,nosuid,nodev,size=1m',
        '-e',
        `GATEWAY_IPV4=${stack.gatewayIp}`,
        '-e',
        'GATEWAY_PORT=8080',
        '--entrypoint',
        'node',
        GUARD_IMAGE,
        '/usr/local/lib/raditi/network-guard.mjs',
      ])
      closers.push(() => run('docker', ['rm', '-f', name], { allowFailure: true, cleanup: true }))
      await eventually(
        async () =>
          (
            await run('docker', ['exec', name, 'test', '-f', '/run/raditi-guard/ready'], {
              allowFailure: true,
            })
          ).code === 0,
      )
      return name
    },

    /**
     * Whether a file of the sandbox holds the plan key. The files leave the container as a tar
     * stream and are searched here: the value never enters the sandbox it is searched in. A
     * control file with a marker of this search is written first and must be found, among the
     * binary bytes the CLI keeps its session database in.
     */
    async sandboxHoldsKey(containerName) {
      const marker = `LIVE_SEARCH_CONTROL_${randomUUID()}`
      const file = `${OPENCODE_HOME}/.local/share/opencode/live-search-control.db`
      const planted = await dockerCommand([
        'exec',
        containerName,
        'node',
        '-e',
        `const fs=require('node:fs'),path=require('node:path');
fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true,mode:0o700});
fs.writeFileSync(process.argv[1],Buffer.concat([Buffer.from('SQLite format 3\\0\\0\\u0001'),
  Buffer.from(process.argv[2]),Buffer.from([0,255,0])]),{mode:0o600})`,
        file,
        marker,
      ])
      assert.equal(planted.code, 0, 'The control file of the search could not be written')
      const search = createStreamSearch([key.needles(), [marker]])
      const code = await new Promise((resolve, reject) => {
        const child = spawn(
          'docker',
          ['exec', containerName, 'tar', '-cf', '-', '--', ...SANDBOX_ROOTS],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        )
        child.stdout.on('data', (chunk) => search.push(chunk))
        child.once('error', reject)
        child.once('close', resolve)
      })
      // tar answers 0 only when it read every file it listed.
      assert.equal(code, 0, 'The files of the sandbox could not be read whole')
      const [held, control] = search.found()
      assert.equal(control, true, 'The search does not see the home of the CLI')
      await dockerCommand(['exec', containerName, 'rm', '-f', file])
      return held
    },

    /**
     * Rehearsal only: the synthetic key written into a file of the sandbox must be found by the
     * search above, and be gone from it once the file is removed.
     */
    async proveSandboxSearch(containerName) {
      assert.equal(rehearsal, true, 'Only the synthetic key is ever planted')
      const file = `${OPENCODE_HOME}/.local/share/opencode/live-planted-key.db`
      const planted = await dockerCommand(
        ['exec', '-i', containerName, 'sh', '-c', `mkdir -p "$(dirname ${file})" && cat > ${file}`],
        { input: Buffer.concat([Buffer.from([0, 255]), Buffer.from(key.input())]) },
      )
      assert.equal(planted.code, 0, 'The synthetic key could not be planted in the sandbox')
      assert.equal(await live.sandboxHoldsKey(containerName), true, 'The planted key was not found')
      await dockerCommand(['exec', containerName, 'rm', '-f', file])
      assert.equal(await live.sandboxHoldsKey(containerName), false)
      live.passed(
        'rehearsal: the synthetic key planted in a file of the sandbox was found by the search',
      )
    },

    /**
     * The end of every run that passed its checks: the value of the key in none of the places
     * the run left, searched in this process. `places` are the stand's own; the ledger
     * directory, the observed exchanges and the kept files are added here. A canary planted in
     * the stand directory shows first that the search reads what it is given. A run that
     * failed or was interrupted does not get here: `afterFailure` searches what it still holds.
     */
    async assertKeyNowhere({ stack, places }) {
      const all = [
        ...places,
        { name: 'the stand directory', directory: stack.directory },
        { name: 'workers and operator commands', streams: logs },
        { name: 'the run directory', directory },
        {
          name: 'observed exchanges',
          texts: (observer?.exchanges() ?? []).flatMap((e) => [e.requestBody, e.responseText]),
        },
        ...(mode.keep ? [{ name: 'kept exchanges', directory: mode.keep }] : []),
      ]
      const canary = takePlanKey({ ZAI_API_KEY: `canary-${randomBytes(24).toString('hex')}` })
      const planted = join(stack.directory, 'live-search-canary')
      await writeFile(planted, Buffer.concat([Buffer.from([0, 255]), Buffer.from(canary.input())]))
      const control = await searchPlaces(canary, all)
      await rm(planted)
      assert.deepEqual(
        control,
        ['the stand directory: live-search-canary'],
        'The search does not read the stand directory',
      )
      const found = await searchPlaces(key, all)
      assert.deepEqual(found, [], `The plan key is in: ${found.join('; ')}`)
      // A rehearsal plants its synthetic key in each of these very places in turn, among
      // binary bytes: the search must name that place and no other. In the output of a
      // process it is planted as a read of the pipe may leave it: cut in two chunks.
      if (rehearsal) {
        const secret = Buffer.concat([Buffer.from([0, 255]), Buffer.from(key.input())])
        const cut = Math.floor(secret.length / 2)
        for (const [index, place] of all.entries()) {
          const with_ = all.slice()
          let file = null
          if (place.directory !== undefined) {
            file = join(place.directory, 'live-planted-key')
            await mkdir(place.directory, { recursive: true })
            await writeFile(file, secret)
          } else if (place.streams !== undefined)
            with_[index] = {
              name: place.name,
              streams: [...place.streams, [secret.subarray(0, cut), secret.subarray(cut)]],
            }
          else
            with_[index] = { name: place.name, texts: [...(place.texts ?? [place.text]), secret] }
          const named = await searchPlaces(key, with_)
          if (file) await rm(file)
          assert.deepEqual(
            named,
            [file ? `${place.name}: live-planted-key` : place.name],
            `The planted key was not found in ${place.name}`,
          )
        }
        live.passed(
          `rehearsal: the synthetic key planted in each of ${all.length} places in turn was found there and nowhere else`,
        )
      }
      return all.length
    },

    /** The exchanges the observer saw, for sanitize-samples.mjs: only with `--keep`. */
    async keepExchanges() {
      if (!mode.keep || !observer) return
      const kept = await keepExchanges(key, mode.keep, observer.exchanges())
      assert.equal(kept.held, false, 'The plan key is in the observed exchanges: none was kept')
    },

    /**
     * What a run that failed or was interrupted still does before its cleanup. The search for
     * the key over what it holds by then: the output of the workers and of the operator's
     * commands, the stand's own `places` (the output of the CLI), the observed exchanges, the
     * run directory and the stand directory. With `--keep`, the exchanges, for the diagnosis
     * of the failure — written only when the key is not in them. What only Docker can give
     * (logs of the services, the audit of OpenBao, the database, docker inspect, the files of
     * the sandbox) is not searched here: such a run may no longer have its containers.
     */
    async searchAfterFailure({ stack, places = [], keep = mode.keep }) {
      const exchanges = observer?.exchanges() ?? []
      const all = [
        ...places,
        { name: 'workers and operator commands', streams: logs },
        {
          name: 'observed exchanges',
          texts: exchanges.flatMap((e) => [e.requestBody, e.responseText]),
        },
        { name: 'the run directory', directory },
        ...(stack ? [{ name: 'the stand directory', directory: stack.directory }] : []),
      ]
      const { found, unread } = await searchWhatIsLeft(key, all)
      const kept = keep && exchanges.length ? await keepExchanges(key, keep, exchanges) : null
      return { found, unread, searched: all.map((place) => place.name), kept }
    },

    /** The same for the output of a failed run: names of places, never content; never throws. */
    async afterFailure(input) {
      try {
        const { found, unread, searched, kept } = await live.searchAfterFailure(input)
        if (found.length) console.error(`The plan key is in: ${found.join('; ')}`)
        live.report(
          `after the failure the plan key was searched for in what the run still held (${searched.filter((name) => !unread.includes(name)).join(', ')}): ${found.length ? `found in ${found.length} place(s)` : 'in none'}${unread.length ? `; could not be read: ${unread.join(', ')}` : ''}`,
        )
        if (kept)
          live.report(
            kept.held
              ? 'the observed exchanges hold the plan key: none was kept'
              : `${kept.written} observed exchange(s) kept for the diagnosis of the failure`,
          )
      } catch {
        console.error('The search for the plan key after the failure could not be made')
      }
    },

    /**
     * Rehearsal only: what a failed run would do, on what this run holds by now. The search
     * finds nothing and the exchanges are kept; with the synthetic key planted in the output
     * of a process, cut in two chunks as a read of its pipe may leave it, the place is named.
     */
    async proveFailureSearch({ stack, places }) {
      assert.equal(rehearsal, true, 'Only the synthetic key is ever planted')
      const keep = join(directory, 'kept-after-failure')
      const clean = await live.searchAfterFailure({ stack, places, keep })
      assert.deepEqual([clean.found, clean.unread], [[], []], 'The search of a failed run')
      const exchanges = observer.exchanges().length
      assert.ok(exchanges > 0, 'The rehearsal observed no exchange yet')
      assert.deepEqual(clean.kept, { written: exchanges, held: false })
      assert.equal((await readdir(keep)).length, exchanges)
      await rm(keep, { recursive: true })
      const secret = key.input()
      const cut = Math.floor(secret.length / 2)
      logs.push([secret.slice(0, cut), secret.slice(cut)])
      let planted
      try {
        planted = await live.searchAfterFailure({ stack, places, keep: null })
      } finally {
        logs.pop()
      }
      assert.deepEqual(planted.found, ['workers and operator commands'])
      live.passed(
        `rehearsal: the search a failed run makes before its cleanup read ${clean.searched.length} places and kept ${exchanges} exchange(s); the synthetic key planted across two chunks of a pipe was found`,
      )
    },

    /** What the guards counted, as the last lines of the report; fails when a guard refused. */
    settle() {
      const state = budget.state()
      live.report(
        `provider requests: ${state.used} of ${state.cap} (refused by the guard: ${state.refused}); ${live.seconds()} s of ${limits.minutes * 60}`,
      )
      budget.assertHeld()
      assert.equal(expired, false, `The run outlived its ${limits.minutes} minutes`)
      return state
    },

    /** Safe to call again: a stand closes its run wherever the run ended. */
    close: () =>
      (closing ??= (async () => {
        clearTimeout(deadline)
        let clean = true
        for (const close of closers.reverse()) {
          try {
            await close()
          } catch {
            clean = false
          }
        }
        await rm(directory, { recursive: true, force: true })
        return clean
      })()),
  }
  return live
}

/** The images a live run needs are the deterministic stand's: it never builds or pulls one. */
export async function assertImages() {
  for (const image of [CLI_IMAGE, GUARD_IMAGE]) {
    const inspected = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
      allowFailure: true,
    })
    assert.equal(
      inspected.code,
      0,
      `The image ${image} is missing: run the stand without --live once, it builds the images`,
    )
  }
}
