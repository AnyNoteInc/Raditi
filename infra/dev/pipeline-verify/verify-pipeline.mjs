// Spike N18: the obligatory pipeline of a site on a real Gitea 1.27.3 with real runners and a real
// OpenBao. Everything is a disposable resource of this run: two Giteas, two runners, an OpenBao,
// two networks and a volume, all named raditi-pipeline-verify-<id> and labelled. Never the dev
// infrastructure, the repository .env, a pull or a real token. The checks are in scenario.mjs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { generatedGiteaPassword, giteaAccountArgs } from '../gitea-verify/stand.mjs'
import { scenario } from './scenario.mjs'
import {
  GITEA_IMAGE,
  HOSTING_IMAGE,
  HOSTING_ROOT,
  HOSTING_USER,
  JOB_IMAGE,
  OPENBAO_IMAGE,
  RUNNER_IMAGE,
  caWriterArgs,
  certificateConfigs,
  giteaContainerArgs,
  helperContainerArgs,
  hostKeyFingerprint,
  hostingContainerArgs,
  openbaoContainerArgs,
  runnerConfig,
  runnerContainerArgs,
  sanitizeWebhookBody,
  siteServerArgs,
  standNames,
  standOptions,
} from './stand.mjs'
import { tagScenario } from './tag-scenario.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const root = resolve(here, '../../..')
const names = standNames(randomBytes(4).toString('hex'))
const controller = new AbortController()
const interrupt = () => controller.abort(new Error('Local verification interrupted'))
const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => ['PATH', 'HOME'].includes(key) || key.startsWith('DOCKER_'),
  ),
)
/** Uuids of the stand's runners: their job volumes carry the label com.gitea.runner.uuid. */
const runnerUuids = new Set()
/** Every secret value of the run: a recorded sample that carries one is refused. */
const secrets = new Set()
const secret = (value) => {
  secrets.add(value)
  return value
}
let directory
let resourcesCreated = false
let receiver
let stage = 'preflight'
let checks = 0
const passed = (text) => {
  checks += 1
  console.log(`PASS ${text}`)
}

/**
 * Output is captured privately. An error names the stage and, for Docker commands that carry no
 * secret in their arguments, the first line of stderr; never arguments or stdout.
 */
function run(binary, args, options = {}) {
  const { env, input, allowFailure = false, cleanup = false, timeoutMs, quiet = false } = options
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { env, stdio: 'pipe' })
    const output = []
    const errors = []
    let stopped = false
    const cancel = () => {
      stopped = true
      child.kill('SIGKILL')
    }
    if (!cleanup) {
      controller.signal.addEventListener('abort', cancel, { once: true })
      if (controller.signal.aborted) cancel()
    }
    const timer = setTimeout(cancel, timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.once('error', () => reject(new Error(`${binary} could not start during ${stage}`)))
    child.once('close', (code) => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', cancel)
      const detail = quiet
        ? ''
        : `: ${Buffer.concat(errors).toString('utf8').split('\n')[0].slice(0, 200)}`
      if (stopped) reject(new Error(`${binary} was interrupted or timed out during ${stage}`))
      else if (code !== 0 && !allowFailure)
        reject(new Error(`${binary} failed during ${stage} (exit ${code ?? 'unknown'})${detail}`))
      else done({ code, stdout: Buffer.concat(output).toString('utf8') })
    })
    child.stdin.end(input)
  })
}
const docker = (args, options) => run('docker', args, { env: dockerEnv, ...options })
const pause = (ms) => sleep(ms, undefined, { signal: controller.signal })

async function availableLoopbackPort() {
  const server = createNetServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  // Another process may bind it after the close: Docker then fails instead of replacing it.
  return port
}

/** The stand's own CA (two days) and one server certificate for both Giteas. */
async function createCertificates() {
  const openssl = (...args) =>
    run('openssl', args, { env: { PATH: process.env.PATH, HOME: directory }, timeoutMs: 30_000 })
  const key = (file) =>
    openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', file)
  const configs = certificateConfigs()
  const file = (leaf) => join(directory, leaf)
  await writeFile(file('ca.ext'), configs.authority)
  await writeFile(file('server.ext'), configs.server)
  await mkdir(file('tls'), { mode: 0o755 })
  await key(file('ca-key.pem'))
  await openssl(
    ...['req', '-new', '-key', file('ca-key.pem'), '-subj', `/CN=${names.stand} CA`],
    ...['-out', file('ca.csr')],
  )
  await openssl(
    ...['x509', '-req', '-in', file('ca.csr'), '-signkey', file('ca-key.pem'), '-days', '2'],
    ...['-sha256', '-extfile', file('ca.ext'), '-out', file('ca.pem')],
  )
  await key(file('tls/server-key.pem'))
  await openssl(
    ...['req', '-new', '-key', file('tls/server-key.pem'), '-subj', '/CN=gitea'],
    ...['-out', file('server.csr')],
  )
  await openssl(
    ...['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey'],
    ...[file('ca-key.pem'), '-days', '2', '-sha256', '-set_serial'],
    ...[`0x${randomBytes(16).toString('hex')}`, '-extfile', file('server.ext')],
    ...['-out', file('tls/server.pem')],
  )
  // A synthetic key of a two-day certificate: the container's uid 1000 must be able to read it.
  await chmod(file('tls/server-key.pem'), 0o444)
  await chmod(file('tls/server.pem'), 0o444)
}

/** One request; the body is read whole (at most 4 MiB). Never follows a redirect. */
function exchange(send, options, payload) {
  return new Promise((done, reject) => {
    const req = send(
      { ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 4 * 1024 * 1024) response.destroy(new Error('too large'))
          else chunks.push(chunk)
        })
        response.on('error', () => reject(new Error(`No answer during ${stage}`)))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            // A non-JSON body matters only to a caller that reads it.
          }
          done({ status: response.statusCode, headers: response.headers, text, json })
        })
      },
    )
    req.once('error', () => reject(new Error(`No answer during ${stage}`)))
    req.end(payload)
  })
}

/**
 * A client of one Gitea of the stand, trusted through the stand's CA only: `api` — REST below
 * /api/v1 as an account (Basic) or with a token, `web` — the web forms with a session cookie.
 */
function giteaClient(port, ca) {
  const send = async (method, path, { headers = {}, payload, expect }) => {
    const answer = await exchange(
      httpsRequest,
      { host: '127.0.0.1', port, path, method, ca, headers },
      payload,
    )
    if (expect !== undefined && ![expect].flat().includes(answer.status))
      throw new Error(`Gitea answered HTTP ${answer.status} to ${method} ${path} during ${stage}`)
    return answer
  }
  const authorization = (as) =>
    as?.token
      ? { authorization: `token ${as.token}` }
      : as
        ? { authorization: `Basic ${Buffer.from(`${as.user}:${as.password}`).toString('base64')}` }
        : {}
  return {
    port,
    api: (method, path, { as, body, expect } = {}) =>
      send(method, `/api/v1${path}`, {
        headers: {
          accept: 'application/json',
          ...authorization(as),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        payload: body === undefined ? undefined : JSON.stringify(body),
        expect,
      }),
    health: () => send('GET', '/api/healthz', {}),
    /** The session cookie of an account: Gitea 1.27 web forms carry no CSRF token. */
    login: async (account) => {
      const answer = await send('POST', '/user/login', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          user_name: account.user,
          password: account.password,
        }).toString(),
        expect: 303,
      })
      const cookies = (answer.headers['set-cookie'] ?? []).map((line) => line.split(';')[0])
      // Gitea first drops the anonymous session, then sets the new one: the last cookie wins.
      const session = cookies.filter((cookie) => cookie.startsWith('i_like_gitea=')).at(-1)
      assert.ok(session, 'Gitea returned no session cookie')
      return secret(session)
    },
    web: (method, path, { cookie, form, headers = {}, expect } = {}) =>
      send(method, path, {
        headers: {
          accept: 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          ...headers,
        },
        payload: form,
        expect,
      }),
  }
}

async function startGitea({ port, repositoryWorkflows, ca }) {
  const name = repositoryWorkflows ? names.containers.gitea : names.containers.giteaHardened
  await docker(giteaContainerArgs({ names, port, repositoryWorkflows }))
  // Runners and jobs of the deploy side reach either Gitea by its alias on the deploy network.
  const alias = repositoryWorkflows ? 'gitea' : 'gitea-hardened'
  await docker(['network', 'connect', '--alias', alias, names.networks.deploy, name])
  await docker(['cp', join(directory, 'tls'), `${name}:/tls`])
  await docker(['start', name])
  const binding = (await docker(['port', name, '3000/tcp'])).stdout.trim()
  assert.equal(binding, `127.0.0.1:${port}`, 'Gitea is not published on loopback only')
  const client = giteaClient(port, ca)
  const deadline = Date.now() + 90_000
  for (;;) {
    const health = await client.health().catch(() => null)
    if (health?.status === 200) break
    if (controller.signal.aborted) throw new Error('Interrupted')
    if (Date.now() > deadline) throw new Error('Gitea did not become healthy in 90 seconds')
    await pause(500)
  }
  const version = await client.api('GET', '/version', { expect: 200 })
  assert.equal(version.json?.version, '1.27.3', 'Unexpected Gitea version')
  // Gitea generates each password and prints it: it is never an argument of a process.
  const account = async (user, admin) => {
    const created = await docker(giteaAccountArgs({ container: name, user, admin }), {
      quiet: true,
    })
    return { user, password: secret(generatedGiteaPassword(created.stdout)) }
  }
  const admin = await account('stand-admin', true)
  const bot = await account('raditi-bot', false)
  return { ...client, name, admin, bot }
}

/** A regular in-memory OpenBao, initialised and unsealed through its API. */
async function startOpenbao() {
  const name = names.containers.openbao
  await docker(openbaoContainerArgs({ names }))
  await docker(['start', name])
  const binding = (await docker(['port', name, '8200/tcp'])).stdout.trim()
  const [, port] = /^127\.0\.0\.1:(\d+)$/.exec(binding) ?? []
  assert.ok(port, 'OpenBao is not published on loopback only')
  const bao = (method, path, { token, body, headers = {} } = {}) =>
    exchange(
      httpRequest,
      {
        host: '127.0.0.1',
        port: Number(port),
        path: `/v1/${path}`,
        method,
        headers: {
          ...(token ? { 'x-vault-token': token } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      },
      body === undefined ? undefined : JSON.stringify(body),
    )
  const deadline = Date.now() + 30_000
  for (;;) {
    const health = await bao('GET', 'sys/health').catch(() => null)
    if (health && [200, 501, 503].includes(health.status)) break
    if (controller.signal.aborted) throw new Error('Interrupted')
    if (Date.now() > deadline) throw new Error('OpenBao did not answer in 30 seconds')
    await pause(200)
  }
  const init = await bao('POST', 'sys/init', { body: { secret_shares: 1, secret_threshold: 1 } })
  assert.equal(init.status, 200, 'OpenBao initialization failed')
  const rootToken = secret(init.json.root_token)
  const unseal = await bao('POST', 'sys/unseal', {
    body: { key: secret(init.json.keys_base64[0]) },
  })
  assert.equal(unseal.json?.sealed, false, 'OpenBao remains sealed')
  return { bao, rootToken }
}

/**
 * The receiver of Gitea's webhooks is this process. Docker Desktop and Colima route
 * host.docker.internal to the loopback of the host; on a Linux host the name is the gateway of
 * the default bridge, so the receiver listens there (not checked on Linux yet).
 */
async function startReceiver() {
  /**
   * The release API of the stand and its presigned uploads (tag-scenario.mjs):
   * `async ({ method, path, headers, body }) → { status, json }`.
   */
  let releaseApi = null
  let host = '127.0.0.1'
  if (process.platform === 'linux') {
    const format = '{{(index .IPAM.Config 0).Gateway}}'
    host = (await docker(['network', 'inspect', 'bridge', '--format', format])).stdout.trim()
  }
  const deliveries = []
  const server = createHttpServer((request, response) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size <= 1024 * 1024) chunks.push(chunk)
    })
    request.on('end', async () => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers))
        headers.set(key, [value].flat().join(', '))
      if (/^\/(v1\/releases\/|upload\/|health$)/.test(request.url ?? '')) {
        let answer = { status: 503, json: null }
        try {
          if (releaseApi && size <= 1024 * 1024)
            answer = await releaseApi({
              method: request.method,
              path: request.url,
              headers,
              body: Buffer.concat(chunks),
            })
        } catch {
          answer = { status: 500, json: null }
        }
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(answer.json === null ? '' : JSON.stringify(answer.json))
        return
      }
      deliveries.push({
        event: headers.get('x-gitea-event') ?? '',
        headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(204).end()
    })
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, host, done)
  })
  return {
    deliveries,
    port: server.address().port,
    serveReleaseApi: (handler) => {
      releaseApi = handler
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(done)
      }),
  }
}

async function startRunner(kind, registrationToken, { deployImage } = {}) {
  const name = {
    check: names.containers.runnerCheck,
    deploy: names.containers.runnerDeploy,
    release: names.containers.runnerRelease,
  }[kind]
  const config = join(directory, `runner-${kind}`)
  await mkdir(config)
  await writeFile(
    join(config, 'runner.yaml'),
    runnerConfig({ names, kind, releaseApiPort: receiver.port }),
  )
  await writeFile(join(config, 'ca.pem'), await readFile(join(directory, 'ca.pem')))
  await writeFile(join(config, 'registration-token'), registrationToken, { mode: 0o600 })
  await docker(runnerContainerArgs({ names, kind, deployImage }))
  await docker(['cp', config, `${name}:/config`])
  await docker(['start', name])
  return name
}

/** The uuid of a started runner: its job volumes carry it as a label. */
async function rememberRunner(runner) {
  // The registration file also holds the runner's token: only the uuid is taken.
  const state = await docker(['exec', runner, 'cat', '/data/.runner'], { quiet: true })
  const { uuid } = JSON.parse(state.stdout)
  assert.match(uuid, /^[0-9a-f-]{36}$/, 'The runner has no uuid')
  runnerUuids.add(uuid)
}

/**
 * The hosting of the site of a release: SFTP (internal-sftp) on the deploy network, its password
 * a file copied in before the start, its host key read from the container. The stand reads and
 * writes the site's files with `docker exec`, as the hosting's own user.
 */
async function startHosting() {
  const name = names.containers.hosting
  await docker(['volume', 'create', '--label', names.label, names.hostingVolume])
  await docker(hostingContainerArgs({ names }))
  const password = secret(randomBytes(18).toString('base64url'))
  const files = join(directory, 'hosting')
  await mkdir(files, { mode: 0o755 })
  await writeFile(join(files, 'password'), password, { mode: 0o644 })
  await docker(['cp', files, `${name}:/stand`])
  await docker(['start', name])
  const quiet = { allowFailure: true, quiet: true }
  const deadline = Date.now() + 60_000
  let publicKey
  for (;;) {
    const key = await docker(
      ['exec', name, 'cat', '/config/ssh_host_keys/ssh_host_ed25519_key.pub'],
      quiet,
    )
    const listening = await docker(['exec', name, 'test', '-s', '/config/sshd.pid'], quiet)
    if (key.code === 0 && listening.code === 0) {
      publicKey = key.stdout
      break
    }
    if (Date.now() > deadline) throw new Error('The hosting did not start in 60 seconds')
    await pause(500)
  }
  await docker(['exec', name, 'chown', '1000:1000', HOSTING_ROOT])
  const inside = (relative) => {
    if (
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(relative) ||
      relative.split('/').includes('..')
    )
      throw new Error('Invalid path of the hosting')
    return `${HOSTING_ROOT}/${relative}`
  }
  return {
    access: {
      v: '1',
      host: 'hosting',
      port: '2222',
      hostKey: hostKeyFingerprint(publicKey),
      rootPath: HOSTING_ROOT,
      username: HOSTING_USER,
      auth: 'password',
      password,
    },
    /** A file of the site, or null. */
    read: async (relative) => {
      const read = await docker(['exec', name, 'cat', inside(relative)], quiet)
      return read.code === 0 ? read.stdout : null
    },
    write: (relative, text) =>
      docker(
        [
          'exec',
          '-i',
          '-u',
          '1000:1000',
          name,
          'sh',
          '-c',
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          'sh',
          inside(relative),
        ],
        { input: text },
      ),
    /** Every path below the root, sorted. */
    list: async () =>
      (await docker(['exec', name, 'find', HOSTING_ROOT, '-mindepth', '1'])).stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(HOSTING_ROOT.length + 1))
        .sort(),
  }
}

/** The server of the site's pages on the deploy network (`site:8080`), from the deploy image. */
async function startSiteServer(deployImage) {
  await docker(siteServerArgs({ names, deployImage }))
  await docker(['start', names.containers.siteServer])
}

/** Waits until `count` runners of a Gitea are online. */
async function runnersOnline(gitea, count) {
  const deadline = Date.now() + 90_000
  for (;;) {
    const list = await gitea.api('GET', '/admin/actions/runners', { as: gitea.admin, expect: 200 })
    const online = (list.json?.runners ?? []).filter((runner) => runner.status === 'online')
    if (online.length === count) return
    if (Date.now() > deadline) throw new Error('The runners did not register in 90 seconds')
    await pause(500)
  }
}

async function main() {
  const options = standOptions(process.argv.slice(2))
  const context = await docker([
    'context',
    'inspect',
    '--format',
    '{{json .Endpoints.docker.Host}}',
  ])
  const endpoint = dockerEnv.DOCKER_CONTEXT
    ? JSON.parse(context.stdout)
    : (dockerEnv.DOCKER_HOST ?? JSON.parse(context.stdout))
  if (typeof endpoint !== 'string' || !/^(unix|npipe):\/\//.test(endpoint))
    throw new Error('This stand needs a local Docker socket; remote Docker endpoints are refused')
  await docker(['info', '--format', '{{.ServerVersion}}'])
  for (const image of [GITEA_IMAGE, RUNNER_IMAGE, OPENBAO_IMAGE, JOB_IMAGE, HOSTING_IMAGE])
    if ((await docker(['image', 'inspect', image], { allowFailure: true })).code !== 0)
      throw new Error(`The pinned image ${image} is missing locally; no image was pulled`)
  if ((await docker(['image', 'inspect', options.deployImage], { allowFailure: true })).code !== 0)
    throw new Error(
      `The deploy image ${options.deployImage} is missing: build it with docker build -f apps/orchestrator/Dockerfile --target runtime -t ${options.deployImage} .`,
    )
  await run('openssl', ['version'], { env: { PATH: process.env.PATH } })

  directory = await mkdtemp(join(tmpdir(), 'raditi-pipeline-verify-'))
  await chmod(directory, 0o700)
  stage = 'issuing the stand certificates'
  await createCertificates()
  const ca = await readFile(join(directory, 'ca.pem'))

  stage = 'creating the networks and the site volume'
  // Set before the first create, so a partial start is cleaned too.
  resourcesCreated = true
  for (const network of Object.values(names.networks))
    await docker(['network', 'create', '--label', names.label, network])
  await docker(['volume', 'create', '--label', names.label, names.siteVolume])
  await docker(['volume', 'create', '--label', names.label, names.caVolume])
  await docker(caWriterArgs({ names }), { input: ca })
  await docker(helperContainerArgs({ names }))
  await docker(['start', names.containers.site])

  stage = 'starting the disposable Gitea'
  const gitea = await startGitea({
    port: await availableLoopbackPort(),
    repositoryWorkflows: true,
    ca,
  })
  passed(`disposable Gitea 1.27.3 with Actions answers over HTTPS on 127.0.0.1:${gitea.port}`)

  stage = 'starting the disposable OpenBao'
  const { bao, rootToken } = await startOpenbao()
  // What a job of each kind reaches is measured by the probes of Q7, not stated here.
  passed('disposable OpenBao 2.7.0 initialised through its API, attached to the deploy network')

  stage = 'starting the webhook receiver'
  receiver = await startReceiver()

  const common = {
    names,
    root,
    signal: controller.signal,
    passed,
    secret,
    setStage: (text) => {
      stage = text
    },
    pause,
    bao,
    rootToken,
    deliveries: receiver.deliveries,
    receiverPort: receiver.port,
    /** The second Gitea: the same image with repository workflow directories switched off. */
    startHardenedGitea: async () =>
      startGitea({ port: await availableLoopbackPort(), repositoryWorkflows: false, ca }),
  }

  let samples = {}
  if (!options.only) {
    stage = 'starting the runners'
    const registration = await gitea.api('POST', '/admin/actions/runners/registration-token', {
      as: gitea.admin,
      expect: 200,
    })
    const registrationToken = secret(registration.json.token)
    const runners = [
      await startRunner('check', registrationToken),
      await startRunner('deploy', registrationToken),
    ]
    await runnersOnline(gitea, 2)
    for (const runner of runners) await rememberRunner(runner)
    passed(
      'two runners of gitea/runner 4.0.0 online: `check` and `deploy`, each on its own network',
    )

    stage = 'scenario'
    samples = await scenario({
      ...common,
      gitea,
      /** A file of the "site" (the deploy runner's volume), or null. */
      site: async (path) => {
        const read = await docker(['exec', names.containers.site, 'cat', `/site/${path}`], {
          allowFailure: true,
        })
        return read.code === 0 ? read.stdout : null
      },
      /** What Docker knows about the job containers and volumes of the run right now. */
      jobContainers: async () => {
        const format = '{{.Names}}\t{{.Label "raditi.stand"}}\t{{.Networks}}'
        const list = await docker(['ps', '--format', format, '--filter', 'name=GITEA-ACTIONS-TASK'])
        return list.stdout.split('\n').filter((line) => line.includes(names.stand))
      },
    })
  }

  stage = 'the release tag on the second Gitea'
  await tagScenario({
    ...common,
    deployImage: options.deployImage,
    serveReleaseApi: receiver.serveReleaseApi,
    releaseApiPort: receiver.port,
    startHosting,
    startSiteServer: () => startSiteServer(options.deployImage),
    /** The deploy runner of the second Gitea: the label `deploy` is the deploy image. */
    startReleaseRunner: async (hardened) => {
      const registration = await hardened.api('POST', '/admin/actions/runners/registration-token', {
        as: hardened.admin,
        expect: 200,
      })
      const runner = await startRunner('release', secret(registration.json.token), {
        deployImage: options.deployImage,
      })
      await runnersOnline(hardened, 1)
      await rememberRunner(runner)
    },
  })

  if (options.record) {
    stage = 'recording sanitised webhook samples'
    await mkdir(options.record, { recursive: true })
    const forbidden = [...secrets, hostname(), userInfo().username].filter(Boolean)
    for (const [name, delivery] of Object.entries(samples)) {
      const body = sanitizeWebhookBody(delivery.raw, { port: gitea.port, forbidden })
      await writeFile(join(options.record, `${name}.${delivery.event}.json`), body)
    }
    passed(
      `${Object.keys(samples).length} sanitised webhook bodies written to the --record directory`,
    )
  }
  console.log(`PASS pipeline spike on Gitea 1.27.3 and gitea/runner 4.0.0: ${checks} checks`)
}

async function cleanup() {
  const quiet = { cleanup: true, allowFailure: true }
  const lines = (result) => result.stdout.split('\n').filter(Boolean)
  // The runners first: after this nothing creates a job container, a volume or a network.
  let runners = 0
  for (const runner of [
    names.containers.runnerCheck,
    names.containers.runnerDeploy,
    names.containers.runnerRelease,
  ]) {
    // Counted only if it was created: an early failure leaves no runner to remove.
    if ((await docker(['container', 'inspect', runner], quiet)).code === 0) runners += 1
    await docker(['rm', '--force', '--volumes', runner], quiet)
  }
  // Every container of the run: by its label and by the networks job containers are put on.
  const containers = new Set()
  const filters = [`label=${names.label}`]
  for (const network of Object.values(names.networks)) filters.push(`network=${network}`)
  for (const filter of filters)
    for (const id of lines(await docker(['ps', '-aq', '--filter', filter], quiet)))
      containers.add(id)
  // A job container has two named volumes of the runner; `rm --volumes` removes anonymous ones only.
  const volumes = new Set()
  const mounts = '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}'
  for (const id of containers) {
    for (const volume of lines(await docker(['inspect', '--format', mounts, id], quiet)))
      volumes.add(volume)
    await docker(['rm', '--force', '--volumes', id], quiet)
  }
  // A runner killed between creating the volumes and the container leaves them with its label.
  for (const uuid of runnerUuids) {
    const mine = ['--filter', `label=com.gitea.runner.uuid=${uuid}`]
    for (const volume of lines(await docker(['volume', 'ls', '-q', ...mine], quiet)))
      volumes.add(volume)
  }
  const labelled = ['--filter', `label=${names.label}`]
  for (const volume of lines(await docker(['volume', 'ls', '-q', ...labelled], quiet)))
    volumes.add(volume)
  for (const volume of volumes) await docker(['volume', 'rm', '--force', volume], quiet)
  for (const network of Object.values(names.networks))
    await docker(['network', 'rm', network], quiet)

  const left = []
  for (const kind of ['ps', 'volume', 'network']) {
    const list = kind === 'ps' ? ['ps', '-aq', ...labelled] : [kind, 'ls', '-q', ...labelled]
    left.push(...lines(await docker(list, { cleanup: true })))
  }
  for (const filter of filters.slice(1))
    left.push(...lines(await docker(['ps', '-aq', '--filter', filter], quiet)))
  for (const uuid of runnerUuids) {
    const mine = ['--filter', `label=com.gitea.runner.uuid=${uuid}`]
    left.push(...lines(await docker(['volume', 'ls', '-q', ...mine], { cleanup: true })))
  }
  for (const volume of volumes)
    if ((await docker(['volume', 'inspect', volume], quiet)).code === 0) left.push(volume)
  assert.deepEqual(left, [], 'A resource of the stand survived cleanup')
  return { containers: containers.size + runners, volumes: volumes.size }
}

export async function verifyPipeline() {
  // Kept until the cleanup has ended, not `once`: with no listener left a repeated signal would
  // end the process in the middle of the cleanup and leave containers behind.
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  let failure
  try {
    await main()
  } catch (error) {
    console.error(`FAIL pipeline stand at ${stage}: ${error instanceof Error ? error.message : ''}`)
    failure = new Error(`Pipeline verification failed at ${stage}`)
  } finally {
    stage = 'cleanup'
    if (receiver) await receiver.close()
    if (resourcesCreated) {
      try {
        const removed = await cleanup()
        passed(
          `owned containers (${removed.containers}), volumes (${removed.volumes}) and networks (2) removed; nothing with the label of the run is left`,
        )
      } catch (error) {
        console.error(
          `FAIL cleanup of ${names.stand}: ${error instanceof Error ? error.message : ''}`,
        )
        failure = new Error(`Cleanup of ${names.stand} failed`)
      }
    }
    // Certificates, runner configuration and the registration token file.
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true })
        passed('temporary directory of the stand removed')
      } catch {
        console.error('FAIL cleanup of the temporary directory of the stand')
        failure = new Error('Cleanup of the temporary directory failed')
      }
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  if (failure) throw failure
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyPipeline().catch(() => {
    process.exitCode = 1
  })
}
