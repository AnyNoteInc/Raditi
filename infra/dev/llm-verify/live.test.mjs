import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { egressConfigFromEnv } from '../../../apps/orchestrator/src/config/llm-config.ts'
import { startFakeSubscriptions } from './fake-subscriptions.mjs'
import { llmBackends } from '../../../packages/llm-backends/src/index.ts'
import * as liveModule from './live.mjs'
import {
  chatRequestSummary,
  createBudget,
  createStreamSearch,
  guardImport,
  LIVE_LIMITS,
  liveServices,
  liveStartRefusal,
  PROVIDER,
  readLedger,
  resultVerdict,
  roleProfileProblems,
  searchPlaces,
  standMode,
  startLlmObserver,
  streamSummary,
  sumUsage,
  takePlanKey,
  windowGrowth,
  windowStartRefusal,
} from './live.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
// Invented for these tests: shaped like a key so that the search has something real to find.
const SYNTHETIC_KEY = 'zai-live-test-0123456789abcdef.SYNTHETICsecret' // gitleaks:allow
let directory
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'raditi-live-test-'))
})
after(async () => rm(directory, { recursive: true, force: true }))

test('the limits of a live run are the numbers of the plan', () => {
  assert.deepEqual(LIVE_LIMITS, {
    gateway: { requests: 20, minutes: 10 },
    content: { requests: 30, minutes: 20 },
    measure: { requests: 40, minutes: 20 },
    // The default of the owner's question П30: a live check of the result within 20 requests.
    results: { requests: 20, minutes: 10 },
  })
  assert.deepEqual(PROVIDER, { host: 'api.z.ai', port: 443 })
})

test('a stand takes --live, --measure, --results, --rehearsal, --no-build and --keep, and nothing else', () => {
  const plain = {
    live: false,
    measure: false,
    results: false,
    rehearsal: false,
    noBuild: false,
    keep: null,
  }
  assert.deepEqual(standMode([], { stand: 'gateway' }), plain)
  assert.deepEqual(standMode(['--', '--no-build'], { stand: 'gateway' }), {
    ...plain,
    noBuild: true,
  })
  assert.deepEqual(standMode(['--live', '--measure'], { stand: 'gateway' }), {
    ...plain,
    live: true,
    measure: true,
  })
  assert.deepEqual(standMode(['--rehearsal', '--keep=/private/x'], { stand: 'content' }), {
    ...plain,
    rehearsal: true,
    keep: '/private/x',
  })
  // The measurement is rehearsed like the acceptance, before it spends real requests.
  assert.deepEqual(standMode(['--rehearsal', '--measure'], { stand: 'gateway' }), {
    ...plain,
    rehearsal: true,
    measure: true,
  })
  // The narrow measurement of the turn result, live and rehearsed, with the other options.
  assert.deepEqual(standMode(['--live', '--results'], { stand: 'gateway' }), {
    ...plain,
    live: true,
    results: true,
  })
  assert.deepEqual(
    standMode(['--results', '--rehearsal', '--no-build', '--keep=/private/x'], {
      stand: 'gateway',
    }),
    { ...plain, rehearsal: true, results: true, noBuild: true, keep: '/private/x' },
  )
  for (const [args, stand] of [
    // Never implemented, and gone from the documents.
    [['--real'], 'gateway'],
    [['--record'], 'gateway'],
    [['--live', '--real'], 'gateway'],
    // The owner's answer П9: the key comes from the environment, there is no key file.
    [['--live', '--key-file', '/x'], 'gateway'],
    [['--measure'], 'gateway'],
    [['--results'], 'gateway'],
    [['--results', '--no-build'], 'gateway'],
    // Two measurements are two runs, each under its own cap.
    [['--live', '--measure', '--results'], 'gateway'],
    [['--rehearsal', '--results', '--measure'], 'gateway'],
    [['--live', '--results', '--results'], 'gateway'],
    [['--live', '--results'], 'content'],
    [['--rehearsal', '--results'], 'content'],
    [['--live', '--measure'], 'content'],
    [['--rehearsal', '--measure'], 'content'],
    [['--live', '--rehearsal'], 'gateway'],
    [['--live', '--live'], 'gateway'],
    [['--keep=/private/x'], 'gateway'],
    [['--live', '--keep=relative'], 'gateway'],
    [['--live', `--keep=${join(repository, 'docs/x')}`], 'gateway'],
    [['--live', '--keep='], 'gateway'],
  ])
    assert.throws(() => standMode(args, { stand }), /option/i, args.join(' '))
})

test('the live mode refuses to start in CI and with any address override or CA switch', () => {
  assert.equal(liveStartRefusal({ PATH: '/usr/bin', HOME: '/h', ZAI_API_KEY: SYNTHETIC_KEY }), null)
  // An empty variable switches nothing.
  assert.equal(liveStartRefusal({ CI: '', LLM_UPSTREAM_CA_FILE: ' ' }), null)
  for (const [name, value] of [
    ['CI', 'true'],
    ['CI', '1'],
    ['LLM_BACKEND_URL_ZAI_CODING', 'https://localhost:1'],
    ['LLM_BACKEND_URL_OPENAI', 'https://localhost:1'],
    ['LLM_BACKEND_URL_ANYTHING_LATER', 'https://localhost:1'],
    ['LLM_AUTH_URL_OPENAI', 'https://localhost:1'],
    ['LLM_EGRESS_PROXY_URL', 'https://localhost:1'],
    ['LLM_EGRESS_CA_FILE', '/x'],
    ['LLM_UPSTREAM_CA_FILE', '/x'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['NODE_USE_SYSTEM_CA', '1'],
    ['NODE_EXTRA_CA_CERTS', '/x'],
    ['NODE_USE_ENV_PROXY', '1'],
    ['SSL_CERT_FILE', '/x'],
    ['SSL_CERT_DIR', '/x'],
    ['NODE_OPTIONS', '--use-system-ca'],
    ['NODE_OPTIONS', '--max-old-space-size=64 --use-openssl-ca'],
    ['NODE_OPTIONS', '--use-bundled-ca'],
  ]) {
    const refusal = liveStartRefusal({ PATH: '/usr/bin', [name]: value })
    assert.ok(refusal?.includes(name), `${name} did not refuse the start`)
    // The name alone: a value may be an address or a path of the operator.
    if (!['1', 'true', '0'].includes(value)) assert.equal(refusal.includes(value), false)
  }
  assert.equal(liveStartRefusal({ NODE_OPTIONS: '--max-old-space-size=64' }), null)
})

test('the plan key is read once, leaves the environment and cannot be printed', () => {
  const env = { PATH: '/usr/bin', ZAI_API_KEY: SYNTHETIC_KEY }
  const key = takePlanKey(env)
  assert.equal(Object.hasOwn(env, 'ZAI_API_KEY'), false)
  assert.equal(key.input(), `${SYNTHETIC_KEY}\n`)
  // Nothing that turns the holder into text carries the value.
  for (const text of [
    String(key),
    `${key}`,
    JSON.stringify(key),
    JSON.stringify({ key }),
    inspect(key),
  ])
    assert.equal(text.includes(SYNTHETIC_KEY), false, text)
  assert.deepEqual(Object.keys(key), [])
  assert.equal(key.foundIn(`a ${SYNTHETIC_KEY} b`), true)
  assert.equal(key.foundIn(Buffer.from(`\0\xff${SYNTHETIC_KEY}\0`, 'latin1')), true)
  assert.equal(key.foundIn(Buffer.from(SYNTHETIC_KEY).toString('base64')), true)
  assert.equal(key.foundIn(Buffer.from(SYNTHETIC_KEY).toString('hex')), true)
  assert.equal(key.foundIn(encodeURIComponent(`Bearer ${SYNTHETIC_KEY}`)), true)
  assert.equal(key.foundIn('nothing here'), false)
  // A second read finds nothing: the first one took it.
  assert.throws(() => takePlanKey(env), /ZAI_API_KEY is not set/)
})

test('without a usable key in the environment the live mode refuses to start', () => {
  for (const env of [
    {},
    { ZAI_API_KEY: '' },
    { ZAI_API_KEY: '   ' },
    { ZAI_API_KEY: 'short' },
    { ZAI_API_KEY: `two\nlines-0123456789abcdef` },
    { ZAI_API_KEY: `with space 0123456789abcdef` },
  ]) {
    assert.throws(
      () => takePlanKey(env),
      (error) => {
        assert.match(error.message, /ZAI_API_KEY/)
        if (env.ZAI_API_KEY?.trim()) assert.equal(error.message.includes(env.ZAI_API_KEY), false)
        return error.refusal === true
      },
    )
    // Whatever was there is gone from the environment all the same.
    assert.equal(Object.hasOwn(env, 'ZAI_API_KEY'), false)
  }
})

test('a five-hour window above 50 % or a week above 80 % refuses the run', () => {
  const windows = (fiveHour, week) => [
    { name: '5h', usedPct: fiveHour, resetsAt: '2026-10-10T12:00:00.000Z' },
    { name: 'week', usedPct: week, resetsAt: '2026-10-15T12:00:00.000Z' },
  ]
  assert.equal(windowStartRefusal(windows(0, 0)), null)
  assert.equal(windowStartRefusal(windows(50, 80)), null)
  assert.equal(
    windowStartRefusal([{ name: '5h', usedPct: 0, resetsAt: null }, windows(0, 3)[1]]),
    null,
  )
  assert.match(windowStartRefusal(windows(50.01, 0)), /five-hour window.*50/)
  assert.match(windowStartRefusal(windows(0, 80.5)), /week.*80/)
  // No snapshot is no capacity: the probe wrote nothing the run could be judged by.
  for (const unknown of [null, undefined, [], [windows(1, 1)[0]], [windows(1, 1)[1]], 'x'])
    assert.match(windowStartRefusal(unknown), /not known/)
  assert.match(windowStartRefusal([{ name: '5h', usedPct: 'NaN' }, windows(0, 0)[1]]), /not known/)
})

test('the growth of the five-hour window is read across a reset as well', () => {
  const at = (usedPct, resetsAt) => ({ name: '5h', usedPct, resetsAt })
  const reset = '2026-10-10T12:00:00.000Z'
  assert.equal(windowGrowth(at(10, reset), at(12.5, reset)), 2.5)
  // The provider's reset time moves by milliseconds between two answers of one window.
  assert.equal(windowGrowth(at(10, reset), at(11, '2026-10-10T12:00:00.250Z')), 1)
  // A window nobody had started: everything it holds now is this run's.
  assert.equal(windowGrowth(at(0, null), at(1.5, reset)), 1.5)
  // The old window ended during the run: the new one counts whole.
  assert.equal(windowGrowth(at(40, reset), at(3, '2026-10-10T17:00:05.000Z')), 3)
  assert.throws(() => windowGrowth(at(1, reset), null), /not known/)
  assert.throws(() => windowGrowth(at(1, reset), at(Number.NaN, reset)), /not known/)
})

const zaiOrigin = llmBackends
  .flatMap((backend) => backend.egress)
  .filter((entry) => entry.direct)
  .map((entry) => entry.origin)
const production = (env) => egressConfigFromEnv(env, 'production')
const profile = (overrides) =>
  roleProfileProblems({
    profile: 'live',
    env: {},
    processEnv: { PATH: '/usr/bin', NODE_ENV: 'test' },
    execArgv: [],
    guarded: true,
    directOrigins: zaiOrigin,
    productionEgress: production,
    ...overrides,
    egress: egressConfigFromEnv(overrides.env ?? {}, 'test'),
  })

test('the live profile of the role llm is the production list, on the direct path', () => {
  assert.deepEqual(zaiOrigin, ['https://api.z.ai'])
  assert.deepEqual(profile({}), [])
  for (const [name, value] of [
    ['LLM_UPSTREAM_CA_FILE', '/stand/root.pem'],
    ['LLM_BACKEND_URL_ZAI_CODING', 'https://localhost:8443'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['NODE_USE_SYSTEM_CA', '1'],
    ['NODE_OPTIONS', '--use-openssl-ca'],
    ['NODE_OPTIONS', '--use-system-ca'],
    ['NODE_EXTRA_CA_CERTS', '/stand/root.pem'],
  ]) {
    // In the configuration the stand hands the role, and in the real environment of the process.
    for (const place of ['env', 'processEnv']) {
      const problems = profile({ [place]: { [name]: value } })
      assert.ok(
        problems.some((problem) => problem.includes(name)),
        `${name} in ${place} did not stop the live role: ${problems.join('; ')}`,
      )
      assert.equal(problems.join(' ').includes('/stand/'), false)
    }
  }
  for (const flag of ['--use-system-ca', '--use-openssl-ca', '--use-bundled-ca'])
    assert.ok(
      profile({ execArgv: ['--import', 'x', flag] }).some((problem) => problem.includes('CA')),
      flag,
    )
  // The provider is reached without an egress node (the owner's answer П2): a proxy is another path.
  const proxied = {
    LLM_EGRESS_PROXY_URL: 'https://localhost:8443',
    LLM_EGRESS_CA_FILE: '/stand/root.pem',
    LLM_EGRESS_CLIENT_CERT_FILE: '/stand/client.pem',
    LLM_EGRESS_CLIENT_KEY_FILE: '/stand/client-key.pem',
  }
  assert.ok(profile({ env: proxied }).some((problem) => /proxy/i.test(problem)))
  // Without the request guard in the process a live role does not start.
  assert.ok(profile({ guarded: false }).some((problem) => /guard/.test(problem)))
})

test('the worker of the role llm decides its profile by that one function, before it listens', async () => {
  const worker = await readFile(
    join(repository, 'apps/orchestrator/scripts/verify-llm-worker.mjs'),
    'utf8',
  )
  assert.match(worker, /profile: z\.enum\(\['synthetic', 'live'\]\)\.default\('synthetic'\)/)
  assert.match(
    worker,
    /productionEgress: \(values\) => egressConfigFromEnv\(values, 'production'\)/,
  )
  assert.match(worker, /processEnv: process\.env,\n\s+execArgv: process\.execArgv,/)
  assert.match(worker, /guarded: globalThis\[Symbol\.for\('raditi\.live-guard'\)\] !== undefined/)
  assert.ok(
    worker.indexOf('roleProfileProblems({') < worker.indexOf('new LlmRuntime('),
    'The role is created before its profile is checked',
  )
  // The same symbol the guard sets when it is installed.
  const guard = await readFile(new URL('./live-guard.mjs', import.meta.url), 'utf8')
  assert.match(guard, /Symbol\.for\('raditi\.live-guard'\)/)
})

test('the synthetic profile of the role llm still demands the synthetic CA and local fakes', () => {
  const synthetic = (env) =>
    roleProfileProblems({
      profile: 'synthetic',
      env,
      processEnv: {},
      execArgv: [],
      directOrigins: zaiOrigin,
      productionEgress: production,
      egress: egressConfigFromEnv(env, 'test'),
    })
  const ca = { LLM_UPSTREAM_CA_FILE: '/stand/root.pem' }
  const fake = { LLM_BACKEND_URL_ZAI_CODING: 'https://localhost:8443' }
  const proxy = {
    LLM_EGRESS_PROXY_URL: 'https://127.0.0.1:8443',
    LLM_EGRESS_CA_FILE: '/stand/root.pem',
    LLM_EGRESS_CLIENT_CERT_FILE: '/stand/client.pem',
    LLM_EGRESS_CLIENT_KEY_FILE: '/stand/client-key.pem',
  }
  assert.deepEqual(synthetic({ ...ca, ...fake }), [])
  assert.deepEqual(synthetic({ ...ca, ...proxy }), [])
  // What the live profile is: exactly what the synthetic one refuses.
  assert.notDeepEqual(synthetic({}), [])
  assert.notDeepEqual(synthetic(fake), [])
  assert.notDeepEqual(synthetic(ca), [])
  assert.notDeepEqual(
    synthetic({ ...ca, ...proxy, LLM_EGRESS_PROXY_URL: 'https://egress.example:8443' }),
    [],
  )
  assert.throws(() => roleProfileProblems({ profile: 'other' }), /profile/)
})

test('the live stack starts no service that could answer in the name of a provider', async () => {
  const source = await readFile(new URL('./compose.yml', import.meta.url), 'utf8')
  const service = (name) => {
    const [, body] = new RegExp(`^ {2}${name}:\\n((?: {4}.*\\n)+)`, 'm').exec(source) ?? []
    assert.ok(body, `compose.yml has no ${name} service`)
    return body
  }
  assert.deepEqual(liveServices({ content: false }), [
    'postgres',
    'vault',
    'sandbox-gw',
    'synthetic-mcp',
  ])
  assert.deepEqual(liveServices({ content: true }), ['postgres', 'vault', 'sandbox-gw', 's3'])
  for (const name of new Set([
    ...liveServices({ content: false }),
    ...liveServices({ content: true }),
  ])) {
    const body = service(name)
    assert.doesNotMatch(body, /::443\b/, `${name} publishes a TLS port`)
    assert.doesNotMatch(body, /aliases:/, `${name} has a network alias`)
    assert.doesNotMatch(body, /\btls\b/i, `${name} mounts TLS material`)
    assert.doesNotMatch(body, /providers/, `${name} joins the network of the fakes`)
    assert.doesNotMatch(body, /api\.z\.ai|chatgpt\.com|kimi/, `${name} names a provider`)
  }
  // The MCP side alone, started only by the live stack; the fakes never start with it.
  const mcp = service('synthetic-mcp')
  assert.match(mcp, /^ {4}profiles: \[live\]$/m)
  assert.match(mcp, /'--mcp-only'/)
  assert.match(mcp, /^ {4}networks: \[trusted\]$/m)
  for (const name of ['fake-subscriptions', 'llm-egress'])
    assert.equal(liveServices({ content: false }).includes(name), false)
  const stack = await readFile(new URL('./stack.mjs', import.meta.url), 'utf8')
  // Named services, never the whole file: `up` of a live stack cannot start a fake.
  assert.match(stack, /\['up', '-d', \.\.\.\(live \? liveServices\(\{ content \}\) : \[\]\)\]/)
  assert.match(stack, /live \? null : await createVerificationCertificates\(/)
})

test('with --mcp-only the synthetic services hold no provider: an MCP server and its control', async (t) => {
  const fake = await startFakeSubscriptions({ mcpOnly: true, mcpPort: 0 })
  t.after(() => fake.close())
  // No TLS listener exists, so there is no address of one.
  assert.equal(fake.address, undefined)
  const control = (path, body) =>
    fetch(`${fake.controlAddress.url}${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    })
  const tools = [{ name: 'site_info', description: 'Synthetic', inputSchema: { type: 'object' } }]
  const turnToken = `mcp_${'5a'.repeat(32)}`
  assert.equal((await control('/mcp', { token: turnToken, tools })).status, 200)
  const rpc = (body, token = turnToken) =>
    fetch(`${fake.mcpAddress.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
    })
  assert.equal((await rpc({ id: 1, method: 'tools/list' }, 'another')).status, 401)
  const listed = await (await rpc({ id: 1, method: 'tools/list' })).json()
  assert.deepEqual(listed.result.tools, tools)
  const called = await rpc({ id: 2, method: 'tools/call', params: { name: 'site_info' } })
  assert.equal((await called.json()).result.isError, false)
  // The state is what the MCP side saw and nothing of a provider.
  const state = await (await control('/state')).json()
  assert.deepEqual(Object.keys(state), ['mcp'])
  assert.deepEqual(
    state.mcp.requests.map((request) => [request.rpc, request.tool, request.authorized]),
    [
      // A request without the turn token is refused before its body is read.
      [null, null, false],
      ['tools/list', null, true],
      ['tools/call', 'site_info', true],
    ],
  )
  assert.equal(JSON.stringify(state).includes(turnToken), false)
  // Nothing of the providers' control exists either.
  for (const path of ['/zai', '/tokens', '/scenario', '/reset'])
    assert.equal((await control(path, {})).status, 404, path)
  await assert.rejects(startFakeSubscriptions({ mcpOnly: true }), /MCP/)
  await assert.rejects(
    startFakeSubscriptions({ mcpOnly: true, mcpPort: 0, key: 'k', cert: 'c' }),
    /TLS/,
  )
})

test('the --mcp-only process takes no TLS option and reports no provider port', async () => {
  const script = fileURLToPath(new URL('./fake-subscriptions.mjs', import.meta.url))
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (stdout.includes('\n')) child.kill('SIGTERM')
      })
      child.on('close', (code) => resolve({ code, stdout }))
    })
  const ready = await run(['--mcp-only', '--control-port', '0', '--mcp-port', '0'])
  assert.deepEqual(Object.keys(JSON.parse(ready.stdout)), ['ready', 'controlPort', 'mcpPort'])
  for (const args of [
    ['--mcp-only', '--mcp-port', '0', '--port', '0'],
    ['--mcp-only', '--mcp-port', '0', '--tls-dir', directory],
    ['--mcp-only', '--mcp-port', '0', '--tls-key', 'k', '--tls-cert', 'c'],
    ['--mcp-only', '--control-port', '0'],
  ]) {
    const refused = await run(args)
    assert.equal(refused.code, 1, args.join(' '))
    assert.equal(refused.stdout, '')
  }
})

const guardedChild = (url, script, args = []) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', url, '-e', script, ...args], {
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
// Connects `count` times to host:port one after another and prints the outcome of each.
const CONNECTS = `
const net = require('node:net')
const [host, port, count] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])]
;(async () => {
  const out = []
  for (let i = 0; i < count; i++)
    out.push(await new Promise((resolve) => {
      const socket = net.connect({ host, port })
      socket.once('connect', () => { socket.destroy(); resolve('open') })
      socket.once('error', (error) => resolve(error.code ?? 'error'))
    }))
  console.log(JSON.stringify(out))
})()`

test('the guard of a live run lets a process open only so many provider connections', async (t) => {
  const accepted = []
  const server = createServer((socket) => {
    accepted.push(socket.remotePort)
    socket.on('error', () => {})
    socket.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const other = createServer((socket) => socket.end())
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
  t.after(() => other.close())
  const { port } = server.address()
  const ledger = join(directory, 'ledger-one')
  const url = guardImport({ ledger, cap: 3, provider: { host: 'localhost', port } })
  assert.match(url, /^file:\/\//)

  const first = await guardedChild(url, CONNECTS, ['localhost', String(port), '5'])
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(JSON.parse(first.stdout), [
    'open',
    'open',
    'open',
    'ERR_LIVE_BUDGET',
    'ERR_LIVE_BUDGET',
  ])
  assert.equal(accepted.length, 3)
  assert.partialDeepStrictEqual(readLedger(ledger), { requests: 3, refused: 2, foreign: [] })
  assert.equal(readLedger(ledger).entries.length, 3)

  // Another process of the same run shares the ledger: the cap is the run's, not a process's.
  const second = await guardedChild(url, CONNECTS, ['localhost', String(port), '2'])
  assert.deepEqual(JSON.parse(second.stdout), ['ERR_LIVE_BUDGET', 'ERR_LIVE_BUDGET'])
  assert.equal(accepted.length, 3)
  assert.partialDeepStrictEqual(readLedger(ledger), { requests: 3, refused: 4 })

  // Loopback that is not the provider passes and is not counted; any other host is refused
  // before a packet leaves and is named in the ledger.
  const local = await guardedChild(url, CONNECTS, ['127.0.0.1', String(other.address().port), '2'])
  assert.deepEqual(JSON.parse(local.stdout), ['open', 'open'])
  const foreign = await guardedChild(url, CONNECTS, ['192.0.2.1', '443', '1'])
  assert.deepEqual(JSON.parse(foreign.stdout), ['ERR_LIVE_FOREIGN_HOST'])
  const named = await guardedChild(url, CONNECTS, ['chatgpt.com', '443', '1'])
  assert.deepEqual(JSON.parse(named.stdout), ['ERR_LIVE_FOREIGN_HOST'])
  // The provider's name on another port is not the provider.
  const otherPort = await guardedChild(
    guardImport({ ledger, cap: 3, provider: PROVIDER }),
    CONNECTS,
    ['api.z.ai', '80', '1'],
  )
  assert.deepEqual(JSON.parse(otherPort.stdout), ['ERR_LIVE_FOREIGN_HOST'])
  assert.deepEqual(readLedger(ledger).foreign, ['192.0.2.1:443', 'chatgpt.com:443', 'api.z.ai:80'])
  assert.partialDeepStrictEqual(readLedger(ledger), { requests: 3, refused: 4 })
})

test('two processes racing for the last provider connections never pass the cap together', async (t) => {
  let accepted = 0
  const server = createServer((socket) => {
    accepted += 1
    socket.on('error', () => {})
    socket.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  const ledger = join(directory, 'ledger-race')
  const url = guardImport({ ledger, cap: 7, provider: { host: 'localhost', port } })
  const results = await Promise.all(
    Array.from({ length: 4 }, () => guardedChild(url, CONNECTS, ['localhost', String(port), '5'])),
  )
  const outcomes = results.flatMap((result) => JSON.parse(result.stdout))
  assert.equal(outcomes.filter((outcome) => outcome === 'open').length, 7)
  assert.equal(outcomes.filter((outcome) => outcome === 'ERR_LIVE_BUDGET').length, 13)
  assert.equal(accepted, 7)
  assert.partialDeepStrictEqual(readLedger(ledger), { requests: 7, refused: 13 })
})

test('a guard that cannot keep its ledger opens no provider connection at all', async (t) => {
  let accepted = 0
  const server = createServer((socket) => {
    accepted += 1
    socket.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  const provider = { host: 'localhost', port }
  const missing = join(directory, 'no-such-directory', 'ledger')
  const closed = await guardedChild(guardImport({ ledger: missing, cap: 3, provider }), CONNECTS, [
    'localhost',
    String(port),
    '2',
  ])
  assert.deepEqual(JSON.parse(closed.stdout), ['ERR_LIVE_BUDGET', 'ERR_LIVE_BUDGET'])
  // A cap of zero is a process that must never reach the provider (the core worker).
  const ledger = join(directory, 'ledger-zero')
  const zero = await guardedChild(guardImport({ ledger, cap: 0, provider }), CONNECTS, [
    'localhost',
    String(port),
    '1',
  ])
  assert.deepEqual(JSON.parse(zero.stdout), ['ERR_LIVE_BUDGET'])
  assert.partialDeepStrictEqual(readLedger(ledger), { requests: 0, refused: 1 })
  assert.equal(accepted, 0)
  for (const bad of [
    { ledger: 'relative', cap: 3, provider },
    { ledger, cap: -1, provider },
    { ledger, cap: 1.5, provider },
    { ledger, cap: 3, provider: { host: '', port } },
    { ledger, cap: 3, provider: { host: 'localhost', port: 0 } },
  ])
    assert.throws(() => guardImport(bad))
  // A guard loaded with a broken address refuses to load: the process does not start unguarded.
  const broken = await guardedChild(
    `${new URL('./live-guard.mjs', import.meta.url).href}?cap=3`,
    'console.log("started")',
  )
  assert.notEqual(broken.code, 0)
  assert.equal(broken.stdout.includes('started'), false)
  assert.deepEqual(readLedger(join(directory, 'never-written')), {
    requests: 0,
    refused: 0,
    foreign: [],
    entries: [],
  })
})

test('the budget of a run stops a turn it cannot afford before the turn starts', async () => {
  const ledger = join(directory, 'ledger-budget')
  const budget = createBudget({ cap: 10, ledger, reserve: 1 })
  assert.deepEqual(budget.state(), { cap: 10, used: 0, refused: 0, foreign: [], remaining: 10 })
  budget.afford(9, 'a turn')
  assert.throws(() => budget.afford(10, 'a turn'), /request budget.*a turn/)
  await writeFile(ledger, 'c 1 100 1\nc 2 100 2\nc 3 100 3\nr 4 100 4\n')
  assert.partialDeepStrictEqual(budget.state(), { used: 3, refused: 1, remaining: 7 })
  // A refusal of the guard is a run that tried to pass the cap: it fails whatever else passed.
  assert.throws(() => budget.assertHeld(), /cap/)
  await writeFile(ledger, 'c 1 100 1\nf 2 100 2 example.org:443\n')
  assert.throws(() => budget.assertHeld(), /another host/)
  await writeFile(ledger, 'c 1 100 1\n')
  budget.assertHeld()
  assert.throws(() => createBudget({ cap: 10, ledger, reserve: 11 }))
})

test('the search for the key names every place that holds it and never the value', async () => {
  const key = takePlanKey({ ZAI_API_KEY: SYNTHETIC_KEY })
  const tree = join(directory, 'stand')
  await mkdir(join(tree, 'cli/home/.local/share/opencode'), { recursive: true })
  await writeFile(join(tree, 'compose.env'), 'VERIFY_DIR=/x\n')
  await writeFile(join(tree, 'cli/home/.local/share/opencode/opencode.db'), 'SQLite format 3\0')
  // A link out of the tree is not followed: the stand searches what it owns.
  await symlink(directory, join(tree, 'link-out'))
  const clean = () => [
    { name: 'role logs', text: '{"event":"llm_call","code":"zai_1302"}\n' },
    { name: 'database dump', text: 'COPY public.llm_calls (id) FROM stdin;\n' },
    { name: 'Vault audit', text: '{"type":"request"}\n' },
    { name: 'S3 objects', texts: [Buffer.from('encrypted'), Buffer.from('bytes')] },
    { name: 'CLI events', texts: ['{"type":"step_finish"}'] },
    { name: 'control port', text: '{"mcp":{"requests":[]}}' },
    { name: 'docker inspect', text: '[{"Config":{"Env":["PATH=/usr/bin"]}}]' },
    { name: 'sandbox files', text: Buffer.from('tar\0stream') },
    // The output of a process as its pipes were read: chunk by chunk, one list a pipe.
    { name: 'role pipes', streams: [['{"event":"llm_', 'call"}\n'], []] },
    { name: 'stand directory', directory: tree },
  ]
  assert.deepEqual(await searchPlaces(key, clean()), [])
  // Planted in each place in turn, as text and among binary bytes.
  for (const [index, place] of clean().entries()) {
    const places = clean()
    const planted = Buffer.concat([
      Buffer.from([0, 255, 1]),
      Buffer.from(`Bearer ${SYNTHETIC_KEY}`),
      Buffer.from([0]),
    ])
    if (place.directory) {
      const file = join(tree, 'cli/home/.local/share/opencode/opencode.db-wal')
      await writeFile(file, planted)
      const found = await searchPlaces(key, places)
      await rm(file)
      assert.deepEqual(found, ['stand directory: cli/home/.local/share/opencode/opencode.db-wal'])
      assert.equal(JSON.stringify(found).includes(SYNTHETIC_KEY), false)
      continue
    }
    if (place.streams) {
      // A read of the pipe ended inside the value: the two chunks of one pipe are one text.
      const cut = 3 + 'Bearer '.length + Math.floor(SYNTHETIC_KEY.length / 2)
      const pieces = [planted.subarray(0, cut).toString('latin1'), planted.subarray(cut)]
      places[index] = { ...place, streams: [place.streams[0], pieces] }
      assert.deepEqual(await searchPlaces(key, places), [place.name])
      // The same value cut between two pipes, or handed over as two texts, is not one value.
      places[index] = { ...place, streams: [[pieces[0]], [pieces[1]]] }
      assert.deepEqual(await searchPlaces(key, places), [])
      places[index] = { name: place.name, texts: pieces }
      assert.deepEqual(await searchPlaces(key, places), [])
      continue
    }
    if (place.texts) places[index] = { ...place, texts: [place.texts[0], planted] }
    else places[index] = { ...place, text: planted }
    assert.deepEqual(await searchPlaces(key, places), [place.name])
  }
  // The value across the boundary of two read blocks of a large file is still one value.
  const large = join(tree, 'large.bin')
  const block = 4 * 1024 * 1024
  await writeFile(
    large,
    Buffer.concat([
      Buffer.alloc(block - 10, 0x61),
      Buffer.from(SYNTHETIC_KEY),
      Buffer.alloc(block, 0x62),
    ]),
  )
  assert.deepEqual(await searchPlaces(key, clean()), ['stand directory: large.bin'])
  await rm(large)
  // Encoded as a header value would be in a log of Docker or of a proxy.
  assert.deepEqual(
    await searchPlaces(key, [
      { name: 'encoded', text: Buffer.from(`Bearer ${SYNTHETIC_KEY}`).toString('base64') },
    ]),
    ['encoded'],
  )
  // A place that could not be read is no answer: the search fails instead of passing.
  await assert.rejects(
    searchPlaces(key, [{ name: 'gone', directory: join(directory, 'no-such-stand') }]),
    (error) => /gone/.test(error.message) && !error.message.includes(SYNTHETIC_KEY),
  )
  await assert.rejects(searchPlaces(key, [{ name: 'nothing' }]), /nothing/)
})

test('a stream is searched across the boundaries of its chunks, for several secrets at once', () => {
  const key = takePlanKey({ ZAI_API_KEY: SYNTHETIC_KEY })
  const control = 'control-marker-0123456789'
  const bytes = Buffer.concat([
    Buffer.alloc(5000, 0),
    Buffer.from(control),
    Buffer.alloc(3000, 0xff),
    Buffer.from(SYNTHETIC_KEY),
    Buffer.alloc(100, 1),
  ])
  for (const size of [1, 7, 64, 4096, bytes.length]) {
    const search = createStreamSearch([key.needles(), [control], ['never-there-0123456789']])
    for (let at = 0; at < bytes.length; at += size) search.push(bytes.subarray(at, at + size))
    assert.deepEqual(search.found(), [true, true, false], `chunks of ${size}`)
  }
  const clean = createStreamSearch([key.needles(), [control]])
  clean.push(Buffer.from(`only the ${control} here`))
  assert.deepEqual(clean.found(), [false, true])
})

test('the observer in front of the role llm passes the stream on as it comes and keeps no credential', async (t) => {
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"one"}}]}\n\n',
    'data: {"choices":[{"index":0,"finish_reason":"stop","delta":{"content":""}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ]
  let seen
  const upstream = createHttpServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      seen = { headers: req.headers, url: req.url, body: Buffer.concat(chunks).toString() }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'kept' })
      for (const frame of frames) {
        res.write(frame)
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      res.end()
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())
  const observer = await startLlmObserver({
    listenHost: '127.0.0.1',
    port: 0,
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  })
  t.after(() => observer.close())
  const body = JSON.stringify({
    model: 'glm-5.3',
    stream: true,
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'synthetic' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool said' },
    ],
    tools: [
      { type: 'function', function: { name: 'bash' } },
      { type: 'function', function: { name: 'raditi_site_info' } },
    ],
  })
  const arrivals = []
  const answer = await new Promise((resolve, reject) => {
    const request = httpRequest(
      `http://127.0.0.1:${observer.port}/zai/v4/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer rdt_turn_key_synthetic',
          'content-type': 'application/json',
          'user-agent': 'opencode/1.18.34',
          host: 'host.docker.internal:1',
        },
      },
      (response) => {
        let text = ''
        response.on('data', (chunk) => {
          arrivals.push(Date.now())
          text += chunk
        })
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, text }),
        )
      },
    )
    request.on('error', reject)
    request.end(body)
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.text, frames.join(''))
  assert.equal(answer.headers['x-upstream'], 'kept')
  // The frames were not held back until the end of the answer.
  assert.ok(arrivals.at(-1) - arrivals[0] >= 60, 'The observer buffered the stream')
  // The role sees the request as sandbox-gw sent it, under its own host name.
  assert.equal(seen.headers.authorization, 'Bearer rdt_turn_key_synthetic')
  assert.equal(seen.headers.host, `127.0.0.1:${upstream.address().port}`)
  assert.equal(seen.body, body)
  const [exchange] = observer.exchanges()
  assert.partialDeepStrictEqual(exchange, {
    method: 'POST',
    path: '/zai/v4/chat/completions',
    status: 200,
    contentType: 'text/event-stream',
    requestBody: body,
    responseText: frames.join(''),
    truncated: false,
  })
  assert.ok(exchange.ms >= 80 && exchange.firstByteMs <= exchange.ms)
  assert.equal(JSON.stringify(observer.exchanges()).includes('rdt_turn_key_synthetic'), false)
  assert.deepEqual(chatRequestSummary(exchange.requestBody), {
    model: 'glm-5.3',
    messages: 4,
    declared: ['bash', 'raditi_site_info'],
    toolOutputs: ['tool said'],
    compaction: false,
  })
  assert.deepEqual(chatRequestSummary('{"model":"glm-5.3","messages":[]}'), {
    model: 'glm-5.3',
    messages: 0,
    declared: [],
    toolOutputs: [],
    compaction: true,
  })
  assert.equal(chatRequestSummary('not json'), null)
  // An upstream that is gone is an answer of the hop, not a hang; the next request still passes.
  await new Promise((resolve) => upstream.close(resolve))
  upstream.closeAllConnections()
  const lost = await fetch(`http://127.0.0.1:${observer.port}/zai/v4/chat/completions`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(lost.status, 502)
  assert.equal(observer.exchanges().length, 2)
})

test('the forms of a stream are read from its frames', () => {
  const frame = (value) => `data: ${JSON.stringify(value)}\n\n`
  const delta = (value, finish) => ({
    id: 'x',
    choices: [{ index: 0, delta: value, ...(finish ? { finish_reason: finish } : {}) }],
  })
  const usage = {
    prompt_tokens: 7105,
    completion_tokens: 94,
    prompt_tokens_details: { cached_tokens: 6784 },
    completion_tokens_details: { reasoning_tokens: 54 },
  }
  const text =
    frame(delta({ role: 'assistant', reasoning_content: 'think' })) +
    frame(delta({ role: 'assistant', content: 'answer' })) +
    frame({ ...delta({ role: 'assistant', content: '' }, 'stop'), usage }) +
    'data: [DONE]\n\n'
  assert.deepEqual(streamSummary(text), {
    frames: 3,
    done: true,
    finishReasons: ['stop'],
    toolCalls: [],
    contentChars: 6,
    reasoningChars: 5,
    usage: { inputUncached: 321, cacheRead: 6784, cacheWrite: 0, output: 94, reasoning: 54 },
    error: null,
    forms: [],
  })
  const calls =
    frame(
      delta({
        tool_calls: [
          { id: 'call_1', index: 0, type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      }),
    ) +
    frame({ ...delta({ content: '' }, 'tool_calls'), usage }) +
    'data: [DONE]\n\n'
  assert.partialDeepStrictEqual(streamSummary(calls), { toolCalls: ['bash'], forms: [] })
  // The two forms report 43 left to the real model.
  assert.deepEqual(
    streamSummary(frame({ ...delta({ content: '' }, 'tool_calls'), usage }) + 'data: [DONE]\n\n')
      .forms,
    ['tool_calls_without_calls'],
  )
  assert.deepEqual(
    streamSummary(
      frame(delta({ reasoning_content: 'only thinking' })) +
        frame({ ...delta({ content: '' }, 'stop'), usage }) +
        'data: [DONE]\n\n',
    ).forms,
    ['stop_with_empty_answer'],
  )
  // The form the real model showed in the content run (record 81-g6-live-content/02): a
  // sentence and a tool call in one answer. No scenario of the synthetic Z.ai makes it.
  const beside =
    frame(delta({ role: 'assistant', content: 'I will read the page first.' })) +
    frame(
      delta({
        tool_calls: [
          { id: 'call_1', index: 0, type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      }),
    ) +
    frame({ ...delta({ content: '' }, 'tool_calls'), usage }) +
    'data: [DONE]\n\n'
  assert.partialDeepStrictEqual(streamSummary(beside), {
    toolCalls: ['bash'],
    forms: ['text_beside_tool_call'],
  })
  // White space beside a call is not text.
  assert.deepEqual(streamSummary(beside.replace('I will read the page first.', '\\n ')).forms, [])
  assert.deepEqual(liveModule.STREAM_FORMS, [
    'tool_calls_without_calls',
    'stop_with_empty_answer',
    'no_finish_reason',
    'no_done',
    'text_beside_tool_call',
  ])
  assert.partialDeepStrictEqual(streamSummary(frame(delta({ content: 'cut' }))), {
    done: false,
    usage: null,
    forms: ['no_finish_reason', 'no_done'],
  })
  assert.partialDeepStrictEqual(
    streamSummary(frame({ error: { code: '1302', message: 'busy' } })),
    { error: '1302' },
  )
  assert.deepEqual(
    sumUsage([
      { inputUncached: 1, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 1 },
      { inputUncached: 10, cacheRead: 20, cacheWrite: 0, output: 30, reasoning: 10 },
    ]),
    { inputUncached: 11, cacheRead: 22, cacheWrite: 0, output: 33, reasoning: 11 },
  )
  assert.deepEqual(sumUsage([]), {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  })
})

test('the verdict on a final message names what kept it from being a result, not its text', async () => {
  const { turnResultSchema } = await import('../../../packages/domain/src/index.ts')
  const result = {
    summary: 'Synthetic',
    change_type: 'none',
    client_message: 'Синтетическая проверка завершена.',
    files_changed: [],
    questions: [],
    needs_approval: false,
    risk: 'low',
  }
  const verdict = (...texts) =>
    resultVerdict(
      texts.map((text) => ({ type: 'message', text })),
      turnResultSchema,
    )
  assert.equal(verdict(JSON.stringify(result)), 'valid')
  assert.equal(verdict('earlier', `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``), 'valid')
  // The two forms the real model gave in the first live run (docs/plan/45-zai-live.md).
  assert.equal(
    verdict(`The file was created.\n\n${JSON.stringify(result)}`),
    'text before the JSON object',
  )
  const { files_changed: _omitted, ...without } = result
  assert.equal(verdict(JSON.stringify(without)), 'schema: files_changed')
  assert.equal(
    verdict(JSON.stringify({ ...without, risk: 'unknown' })),
    'schema: files_changed, risk',
  )
  assert.equal(verdict(`${JSON.stringify(result)}\nDone.`), 'text after the JSON object')
  assert.equal(verdict('Done.'), 'not a JSON object')
  assert.equal(verdict('[]'), 'not a JSON object')
  assert.equal(verdict(), 'no final message')
  assert.equal(
    resultVerdict(
      [
        { type: 'message', text: JSON.stringify(result) },
        { type: 'failed', reason: 'x' },
      ],
      turnResultSchema,
    ),
    'the turn failed',
  )
  // The same reading as the drivers: whatever the verdict calls valid, they take, and nothing else.
  const { createOpencodeDriver } = await import('../../../packages/agent-drivers/src/index.ts')
  const driver = createOpencodeDriver({ image: `raditi@sha256:${'a'.repeat(64)}` })
  for (const text of [
    JSON.stringify(result),
    `Prose.\n${JSON.stringify(result)}`,
    JSON.stringify(without),
    'Done.',
  ]) {
    const events = [
      { type: 'started', nativeSessionId: 'ses_test' },
      { type: 'message', text },
      { type: 'completed' },
    ]
    assert.equal(
      resultVerdict(events, turnResultSchema) === 'valid',
      driver.extractResult(events, null) !== null,
      text.slice(0, 20),
    )
  }
})

test('a budget says whether a step is covered without failing the run', async () => {
  const ledger = join(directory, 'ledger-covers')
  const budget = createBudget({ cap: 10, ledger, reserve: 1 })
  assert.equal(budget.covers(9), true)
  assert.equal(budget.covers(10), false)
  await writeFile(ledger, 'c 1 100 1\nc 1 100 2\nc 1 100 3\nc 1 100 4\n')
  assert.equal(budget.covers(5), true)
  assert.equal(budget.covers(6), false)
})

test('an outcome that depends on the model gets its attempts and never fails the run', async () => {
  const ledger = join(directory, 'ledger-outcome')
  const spend = async (count) => {
    const { requests } = readLedger(ledger)
    await writeFile(
      ledger,
      Array.from({ length: requests + count }, (_, index) => `c 1 100 ${index + 1}\n`).join(''),
    )
  }
  const outcome = (script, { worst = 2, cost = 1 } = {}) => {
    const seen = []
    const item = liveModule.createOutcome({
      label: 'tool turn',
      attempts: 3,
      worst,
      budget: createBudget({ cap: 10, ledger, reserve: 1 }),
      once: async (attempt) => {
        seen.push(attempt)
        await spend(cost)
        const step = script[attempt - 1]
        if (step instanceof Error) throw step
        return { ok: step, attempt }
      },
    })
    return { item, seen }
  }
  // Reached on the second attempt: no third one.
  await writeFile(ledger, '')
  const second = outcome([false, true, true])
  await second.item.first()
  assert.deepEqual(second.item.share(), {
    label: 'tool turn',
    reached: false,
    attempts: 1,
    ended: null,
  })
  await second.item.retries()
  await second.item.retries()
  assert.deepEqual(second.seen, [1, 2])
  assert.deepEqual(second.item.share(), {
    label: 'tool turn',
    reached: true,
    attempts: 2,
    ended: 'reached',
  })
  assert.deepEqual(second.item.last(), { ok: true, attempt: 2 })
  // Reached at once: the retries do nothing.
  await writeFile(ledger, '')
  const atOnce = outcome([true])
  await atOnce.item.first()
  await atOnce.item.retries()
  assert.deepEqual(atOnce.seen, [1])
  assert.partialDeepStrictEqual(atOnce.item.share(), { reached: true, attempts: 1 })
  // Never reached: three attempts, a share of zero, and nothing is thrown.
  await writeFile(ledger, '')
  const never = outcome([false, false, false])
  await never.item.first()
  await never.item.retries()
  assert.deepEqual(never.seen, [1, 2, 3])
  assert.deepEqual(never.item.share(), {
    label: 'tool turn',
    reached: false,
    attempts: 3,
    ended: 'attempts',
  })
  // A retry the budget does not cover ends the attempts and does not fail the run.
  await writeFile(ledger, '')
  const short = outcome([false, false, false], { worst: 4, cost: 4 })
  await short.item.first()
  await short.item.retries()
  assert.deepEqual(short.seen, [1, 2])
  assert.deepEqual(short.item.share(), {
    label: 'tool turn',
    reached: false,
    attempts: 2,
    ended: 'budget',
  })
  // The first attempt is another matter: every kind of turn must run once, so a run that
  // cannot afford it fails on its own count, before the turn starts.
  const unaffordable = outcome([true], { worst: 4 })
  await assert.rejects(unaffordable.item.first(), /request budget.*tool turn, attempt 1/)
  assert.deepEqual(unaffordable.seen, [])
  await assert.rejects(unaffordable.item.retries(), /first attempt/)
  // What the platform owes is still hard: a failed invariant of an attempt ends the run.
  await writeFile(ledger, '')
  const broken = outcome([false, new Error('the usage is an estimate')])
  await broken.item.first()
  await assert.rejects(broken.item.retries(), /the usage is an estimate/)
})

test('a refusal of a guard is noticed while a turn runs, once', async () => {
  const ledger = join(directory, 'ledger-watch')
  await writeFile(ledger, 'c 1 100 1\n')
  const budget = createBudget({ cap: 3, ledger, reserve: 1 })
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let stops = 0
  const watch = liveModule.watchLedger(budget, () => (stops += 1), 20)
  await settle(100)
  assert.equal(stops, 0)
  assert.equal(watch.tripped(), false)
  await writeFile(ledger, 'c 1 100 1\nc 1 100 2\nc 1 100 3\nr 1 100 4\n')
  await settle(200)
  assert.equal(stops, 1)
  assert.equal(watch.tripped(), true)
  // Further refusals of the same run stop nothing twice.
  await writeFile(ledger, 'c 1 100 1\nc 1 100 2\nc 1 100 3\nr 1 100 4\nr 1 100 5\n')
  await settle(100)
  assert.equal(stops, 1)
  watch.end()
  // Another host than the provider trips it as well; after `end` nothing is watched.
  await writeFile(ledger, 'c 1 100 1\n')
  let foreign = 0
  const second = liveModule.watchLedger(budget, () => (foreign += 1), 20)
  await writeFile(ledger, 'c 1 100 1\nf 1 100 2 example.org:443\n')
  await settle(200)
  assert.equal(foreign, 1)
  second.end()
  await writeFile(ledger, 'c 1 100 1\n')
  let late = 0
  const ended = liveModule.watchLedger(budget, () => (late += 1), 20)
  ended.end()
  await writeFile(ledger, 'r 1 100 1\n')
  await settle(100)
  assert.equal(late, 0)
  assert.equal(ended.tripped(), false)
})

test('the first line of a failure is printed only when its whole text is free of the key', () => {
  const key = takePlanKey({ ZAI_API_KEY: SYNTHETIC_KEY })
  const pieceOfKey = (text) => {
    for (let at = 0; at + 8 <= SYNTHETIC_KEY.length; at++)
      if (text.includes(SYNTHETIC_KEY.slice(at, at + 8))) return true
    return false
  }
  assert.equal(
    liveModule.failureLine(new Error('The turn hung\nat somewhere'), key),
    'The turn hung',
  )
  assert.equal(liveModule.failureLine(new Error(`a${'b'.repeat(500)}`), key).length, 400)
  // The value across the cut at 400 characters: a part of it must not be printed.
  for (const at of [380, 395, 399]) {
    const line = liveModule.failureLine(new Error(`${'x'.repeat(at)}${SYNTHETIC_KEY} y`), key)
    assert.equal(line === null || !pieceOfKey(line), true, `offset ${at}: ${line?.length}`)
    assert.equal(line, null)
  }
  // The value on a later line or only in the stack: nothing of the failure is printed.
  assert.equal(liveModule.failureLine(new Error(`first\nsecond ${SYNTHETIC_KEY}`), key), null)
  const stacked = new Error('clean')
  stacked.stack = `Error: clean\n    at ${SYNTHETIC_KEY}`
  assert.equal(liveModule.failureLine(stacked, key), null)
  const renamed = new Error('clean')
  renamed.message = `late ${SYNTHETIC_KEY}`
  assert.equal(liveModule.failureLine(renamed, key), null)
  assert.equal(liveModule.failureLine(new Error(''), key), null)
  assert.equal(liveModule.failureLine('a string was thrown', key), null)
})

test('a failed command of the operator is reported in fixed words, never in its own', () => {
  const pieceOfKey = (text) => {
    for (let at = 0; at + 6 <= SYNTHETIC_KEY.length; at++)
      if (text.includes(SYNTHETIC_KEY.slice(at, at + 6))) return true
    return false
  }
  const answer = { accountId: 'a', backend: 'zai-coding' }
  assert.deepEqual(
    liveModule.commandAnswer({ code: 0, stdout: JSON.stringify(answer) }, 'The import'),
    answer,
  )
  // The last line of its stderr, cut at 200 characters in the middle of the value.
  const failed = { code: 1, stdout: '', stderr: `warn\n${'x'.repeat(180)}${SYNTHETIC_KEY}\n` }
  assert.throws(
    () => liveModule.commandAnswer(failed, 'The import of the plan key'),
    (error) => {
      assert.equal(pieceOfKey(error.message), false, 'a part of the value is in the message')
      assert.equal(error.message, 'The import of the plan key failed with exit code 1')
      return true
    },
  )
  // An answer that is not JSON: the parser quotes a window of what it read.
  for (const stdout of [`{"accountId": ${SYNTHETIC_KEY}}`, SYNTHETIC_KEY, '', '[1]', 'null', '7'])
    assert.throws(
      () => liveModule.commandAnswer({ code: 0, stdout }, 'The import of the plan key'),
      (error) => {
        assert.equal(pieceOfKey(error.message), false, 'a part of the value is in the message')
        assert.equal(error.message, 'The import of the plan key did not answer with a JSON object')
        return true
      },
    )
  assert.throws(
    () => liveModule.commandAnswer({ code: null, stdout: '{}' }, 'The trusted return'),
    /^Error: The trusted return failed with exit code null$/,
  )
})

test('exchanges are kept only when the key is not in what would be written', async () => {
  const key = takePlanKey({ ZAI_API_KEY: SYNTHETIC_KEY })
  const exchange = (requestBody, responseText) => ({
    at: '2026-10-10T07:35:07.000Z',
    method: 'POST',
    path: '/zai/v4/chat/completions',
    status: 200,
    contentType: 'text/event-stream',
    requestBody,
    responseText,
    firstByteMs: 5,
    ms: 9,
    truncated: false,
  })
  const kept = join(directory, 'kept')
  const clean = [exchange('{"model":"glm-5.3"}', 'data: [DONE]\n\n'), exchange('not json', '')]
  assert.deepEqual(await liveModule.keepExchanges(key, kept, clean), { written: 2, held: false })
  const first = JSON.parse(await readFile(join(kept, '01-llm-post_chat_completions.json'), 'utf8'))
  assert.deepEqual(first, {
    at: '2026-10-10T07:35:07.000Z',
    request: {
      method: 'POST',
      path: '/zai/v4/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: { model: 'glm-5.3' },
    },
    response: {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      elapsedMs: 9,
      firstByteMs: 5,
      sse: 'data: [DONE]\n\n',
    },
  })
  const second = JSON.parse(await readFile(join(kept, '02-llm-post_chat_completions.json'), 'utf8'))
  assert.equal(second.request.body, 'not json')
  // The key in one exchange: nothing at all is written, the directory is not even made.
  const dirty = join(directory, 'kept-dirty')
  for (const held of [
    [clean[0], exchange(`{"x":"${SYNTHETIC_KEY}"}`, '')],
    [exchange('{}', `data: {"echo":"Bearer ${SYNTHETIC_KEY}"}\n\n`)],
  ]) {
    assert.deepEqual(await liveModule.keepExchanges(key, dirty, held), { written: 0, held: true })
    await assert.rejects(readFile(join(dirty, '01-llm-post_chat_completions.json')), /ENOENT/)
  }
  assert.deepEqual(await liveModule.keepExchanges(key, dirty, []), { written: 0, held: false })
})

test('after a failure the search goes on past a place it cannot read and names it', async () => {
  const key = takePlanKey({ ZAI_API_KEY: SYNTHETIC_KEY })
  const tree = join(directory, 'left')
  await mkdir(tree, { recursive: true })
  await writeFile(join(tree, 'ledger'), 'c 1 100 1\n')
  const places = (role) => [
    { name: 'role pipes', streams: [role, []] },
    // An interrupted run is already removing its files.
    { name: 'the stand directory', directory: join(directory, 'gone-already') },
    { name: 'the run directory', directory: tree },
    { name: 'CLI output', texts: ['{"type":"step_finish"}'] },
  ]
  assert.deepEqual(await liveModule.searchWhatIsLeft(key, places(['{"event":"a"}\n'])), {
    found: [],
    unread: ['the stand directory'],
  })
  const half = Math.floor(SYNTHETIC_KEY.length / 2)
  const result = await liveModule.searchWhatIsLeft(
    key,
    places([`x ${SYNTHETIC_KEY.slice(0, half)}`, `${SYNTHETIC_KEY.slice(half)} y`]),
  )
  assert.deepEqual(result, { found: ['role pipes'], unread: ['the stand directory'] })
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_KEY), false)
})

test('the codes and signals of the provider are read from the log lines the role writes', async () => {
  // The lines as apps/orchestrator/src/llm-gateway/server.ts writes them: one JSON object a
  // call, with `signal` and `code` only when the provider refused.
  const call = (extra) =>
    `${JSON.stringify({
      event: 'llm_call',
      path: '/zai/v4/chat/completions',
      backend: 'zai-coding',
      model: 'glm-5.3-standard',
      status: 200,
      aborted: false,
      durationMs: 6200,
      requestBytes: 18_000,
      responseBytes: 2400,
      ...extra,
    })}\n`
  const log =
    call({}) +
    call({ status: 429, signal: 'transient', code: 'zai_1302' }) +
    '[Nest] 123  - LOG {"event":"llm_egress_path","path":"direct"}\n' +
    call({ status: 429, signal: 'window_exhausted' }) +
    call({ status: 400, signal: 'request_rejected', code: 'zai_1261' }) +
    call({ status: 429, signal: 'transient', code: 'zai_1302' })
  assert.deepEqual(liveModule.providerSignals(log), {
    codes: ['zai_1302', 'zai_1261'],
    signals: ['transient', 'window_exhausted', 'request_rejected'],
  })
  assert.deepEqual(liveModule.providerSignals(call({}) + call({})), { codes: [], signals: [] })
  assert.deepEqual(liveModule.providerSignals(''), { codes: [], signals: [] })
  // The role writes these two fields exactly so, and only for a refusal.
  const server = await readFile(
    join(repository, 'apps/orchestrator/src/llm-gateway/server.ts'),
    'utf8',
  )
  assert.match(server, /event: 'llm_call',[\s\S]{0,700}\.\.\.signalLine\(finish\.signal\),/)
  assert.match(
    server,
    /return \{ signal: value\.kind, \.\.\.\(code === undefined \? \{\} : \{ code \}\) \}/,
  )
})

const node = dirname(process.execPath)
const stands = {
  gateway: 'apps/orchestrator/scripts/verify-llm-gateway.mjs',
  content: 'apps/orchestrator/scripts/verify-agent-content.mjs',
}
// PATH holds node alone: a stand that got past its refusals would fail on `docker`, not exit 2.
const started = (script, args, env) =>
  spawnSync(process.execPath, [join(repository, script), ...args], {
    env: { PATH: node, HOME: directory, TMPDIR: directory, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })

for (const [stand, script] of Object.entries(stands))
  test(`${stand} stand: the live mode refuses before it starts anything`, () => {
    for (const [name, env, expected] of [
      ['no key', {}, /ZAI_API_KEY is not set/],
      ['CI', { CI: 'true', ZAI_API_KEY: SYNTHETIC_KEY }, /CI/],
      [
        'an address override',
        { ZAI_API_KEY: SYNTHETIC_KEY, LLM_BACKEND_URL_ZAI_CODING: 'https://localhost:9' },
        /LLM_BACKEND_URL_ZAI_CODING/,
      ],
      [
        'a CA switch',
        { ZAI_API_KEY: SYNTHETIC_KEY, LLM_UPSTREAM_CA_FILE: join(directory, 'root.pem') },
        /LLM_UPSTREAM_CA_FILE/,
      ],
      [
        'a CA flag',
        { ZAI_API_KEY: SYNTHETIC_KEY, NODE_EXTRA_CA_CERTS: '/x' },
        /NODE_EXTRA_CA_CERTS/,
      ],
    ]) {
      const result = started(script, ['--live', '--no-build'], env)
      const output = `${result.stdout}${result.stderr}`
      assert.equal(result.status, 2, `${name}: exit ${result.status}: ${output.slice(0, 400)}`)
      assert.match(output, /Live verification refused to start/, name)
      assert.match(output, expected, name)
      assert.equal(output.includes(SYNTHETIC_KEY), false, `${name}: the key was printed`)
    }
    // The flags that never existed are not options of the stand.
    for (const flag of ['--real', '--record']) {
      const result = started(script, [flag], {})
      assert.notEqual(result.status, 0)
      assert.match(`${result.stdout}${result.stderr}`, /option/i)
    }
  })

for (const [stand, script] of Object.entries(stands))
  test(`${stand} stand: a run that fails before its stack starts leaves no run directory`, async () => {
    // A rehearsal with no Docker at all — no command on PATH, and no engine behind the address
    // should one be found: the first command of the stand fails. The synthetic key alone is
    // involved, and nothing is started.
    const temporary = await mkdtemp(join(directory, `no-docker-${stand}-`))
    const result = started(script, ['--rehearsal', '--no-build'], {
      TMPDIR: temporary,
      DOCKER_HOST: `unix://${join(temporary, 'no-engine.sock')}`,
    })
    const output = `${result.stdout}${result.stderr}`
    assert.equal(result.status, 1, `exit ${result.status}: ${output.slice(0, 400)}`)
    assert.match(output, /verification failed at: build/)
    assert.deepEqual(
      (await readdir(temporary)).filter((name) => name.startsWith('raditi-live-')),
      [],
    )
  })

test('gateway stand: the measurement of results refuses and cleans up like the acceptance', async () => {
  for (const [name, env, expected] of [
    ['no key', {}, /ZAI_API_KEY is not set/],
    ['CI', { CI: 'true', ZAI_API_KEY: SYNTHETIC_KEY }, /CI/],
    [
      'an address override',
      { ZAI_API_KEY: SYNTHETIC_KEY, LLM_BACKEND_URL_ZAI_CODING: 'https://localhost:9' },
      /LLM_BACKEND_URL_ZAI_CODING/,
    ],
  ]) {
    const result = started(stands.gateway, ['--live', '--results', '--no-build'], env)
    const output = `${result.stdout}${result.stderr}`
    assert.equal(result.status, 2, `${name}: exit ${result.status}: ${output.slice(0, 400)}`)
    assert.match(output, /Live verification refused to start/, name)
    assert.match(output, expected, name)
    assert.equal(output.includes(SYNTHETIC_KEY), false, `${name}: the key was printed`)
  }
  // Without --live or --rehearsal it is no option of the stand, and never one of the content stand.
  for (const [script, args] of [
    [stands.gateway, ['--results']],
    [stands.content, ['--live', '--results']],
  ]) {
    const result = started(script, args, { ZAI_API_KEY: SYNTHETIC_KEY })
    assert.notEqual(result.status, 0)
    assert.notEqual(result.status, 2)
    assert.match(`${result.stdout}${result.stderr}`, /option/i)
  }
  // Its rehearsal with no Docker at all fails at the first command and leaves no run directory.
  const temporary = await mkdtemp(join(directory, 'no-docker-results-'))
  const result = started(stands.gateway, ['--rehearsal', '--results', '--no-build'], {
    TMPDIR: temporary,
    DOCKER_HOST: `unix://${join(temporary, 'no-engine.sock')}`,
  })
  const output = `${result.stdout}${result.stderr}`
  assert.equal(result.status, 1, `exit ${result.status}: ${output.slice(0, 400)}`)
  assert.match(output, /verification failed at: build/)
  assert.deepEqual(
    (await readdir(temporary)).filter((name) => name.startsWith('raditi-live-')),
    [],
  )
})

test('a signal sent to the command of a stand reaches the stand: its package line ends with exec', async () => {
  // The stand removes its stacks on SIGINT and SIGTERM; in a live run that is what removes the
  // OpenBao container holding the plan key.
  const root = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).scripts
  const orchestrator = JSON.parse(
    await readFile(join(repository, 'apps/orchestrator/package.json'), 'utf8'),
  ).scripts
  assert.equal(root['verify:agent-content'], `exec node ${stands.content}`)
  assert.equal(root['verify:llm-gateway'], 'pnpm --filter orchestrator verify:llm-gateway')
  assert.equal(orchestrator['verify:llm-gateway'], 'exec node scripts/verify-llm-gateway.mjs')
  for (const script of Object.values(stands)) {
    const source = await readFile(join(repository, script), 'utf8')
    assert.match(source, /process\.on\('SIGINT', interrupt\)\nprocess\.on\('SIGTERM', interrupt\)/)
    assert.doesNotMatch(source, /process\.once\('SIG/)
  }
  // The live flow of the gateway stand is a run of its own with the same two listeners.
  const live = await readFile(
    join(repository, 'apps/orchestrator/scripts/verify-llm-live.mjs'),
    'utf8',
  )
  assert.match(live, /process\.on\('SIGINT', interrupt\)\n\s+process\.on\('SIGTERM', interrupt\)/)
  assert.match(live, /if \(interrupted\) return\n\s+interrupted = true/)
  assert.doesNotMatch(live, /process\.once\('SIG/)
})

test('no script of the stands and no document of theirs names the flags that never existed', async () => {
  for (const file of [
    stands.gateway,
    stands.content,
    'infra/dev/llm-verify/README.md',
    'infra/dev/site-verify/README.md',
    'infra/egress/README.md',
  ]) {
    const source = await readFile(join(repository, file), 'utf8')
    assert.equal(/--real\b|--record\b|--key-file\b/.test(source), false, file)
  }
})
