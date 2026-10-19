// Real Gitea 1.27.3 for the GitProvider methods a turn and a release need and for git over HTTPS
// with the stand's own CA. The Gitea is a disposable container of this run: never the dev Gitea,
// the repository .env, a pull or a real token. The checks themselves are in scenario.mjs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  GITEA_IMAGE,
  certificateConfigs,
  generatedGiteaPassword,
  giteaAccountArgs,
  giteaContainerArgs,
  scenarioEnvironment,
  standOptions,
} from './stand.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const root = resolve(here, '../../..')
const name = `raditi-gitea-verify-${randomBytes(4).toString('hex')}`
const controller = new AbortController()
const interrupt = () => controller.abort(new Error('Local verification interrupted'))
const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => ['PATH', 'HOME'].includes(key) || key.startsWith('DOCKER_'),
  ),
)
let directory
let containerCreated = false
let stage = 'preflight'
const passed = (text) => console.log(`PASS ${text}`)

/** Output is captured privately; an error names the stage, never arguments or output. */
function run(binary, args, { env, input, allowFailure = false, cleanup = false, timeoutMs } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { env, stdio: 'pipe' })
    const output = []
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
    child.stderr.resume()
    child.once('error', () => reject(new Error(`${binary} could not start during ${stage}`)))
    child.once('close', (code) => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', cancel)
      if (stopped) reject(new Error(`${binary} was interrupted or timed out during ${stage}`))
      else if (code !== 0 && !allowFailure)
        reject(new Error(`${binary} failed during ${stage} (exit ${code ?? 'unknown'})`))
      else done({ code, stdout: Buffer.concat(output).toString('utf8') })
    })
    child.stdin.end(input)
  })
}
const docker = (args, options) => run('docker', args, { env: dockerEnv, ...options })

async function availableLoopbackPort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  // Another process may bind it after the close: Docker then fails instead of replacing it.
  return port
}

/** The stand's own CA (two days) and a server certificate for 127.0.0.1. */
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
    'req',
    '-new',
    '-key',
    file('ca-key.pem'),
    '-subj',
    `/CN=${name} CA`,
    '-out',
    file('ca.csr'),
  )
  await openssl(
    ...['x509', '-req', '-in', file('ca.csr'), '-signkey', file('ca-key.pem'), '-days', '2'],
    ...['-sha256', '-extfile', file('ca.ext'), '-out', file('ca.pem')],
  )
  await key(file('tls/server-key.pem'))
  await openssl(
    ...['req', '-new', '-key', file('tls/server-key.pem'), '-subj', '/CN=127.0.0.1'],
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

/** One JSON request below /api of the stand's Gitea, trusted through the stand's CA only. */
function gitea(port, ca, method, path, { user, password, body, expect }) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((done, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/api${path}`,
        method,
        ca,
        headers: {
          accept: 'application/json',
          ...(user
            ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
            : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', () => reject(new Error(`Gitea did not answer during ${stage}`)))
        response.on('end', () => {
          if (expect !== undefined && response.statusCode !== expect)
            return reject(new Error(`Gitea answered HTTP ${response.statusCode} during ${stage}`))
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            // A non-JSON body matters only to a caller that reads it.
          }
          done({ status: response.statusCode, json })
        })
      },
    )
    req.once('error', () => reject(new Error(`Gitea did not answer during ${stage}`)))
    req.end(payload)
  })
}

async function main() {
  standOptions(process.argv.slice(2))
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
  if ((await docker(['image', 'inspect', GITEA_IMAGE], { allowFailure: true })).code !== 0)
    throw new Error('The pinned Gitea 1.27.3 image is missing locally; no image was pulled')
  const gitleaks = process.env.P2_GITLEAKS_BINARY
  if (!gitleaks || !isAbsolute(gitleaks))
    throw new Error('P2_GITLEAKS_BINARY must be the absolute path of Gitleaks 8.30.1')
  const toolEnv = { PATH: process.env.PATH }
  assert.equal(
    (await run(gitleaks, ['version'], { env: toolEnv })).stdout.trim(),
    '8.30.1',
    'Use the verified Gitleaks 8.30.1 release',
  )
  await run('git', ['--version'], { env: toolEnv })
  await run('openssl', ['version'], { env: toolEnv })
  try {
    await access(join(root, 'apps/orchestrator/dist/git-workspace/git-config.js'))
  } catch {
    throw new Error('Build the orchestrator first: pnpm --filter orchestrator build')
  }

  directory = await mkdtemp(join(tmpdir(), 'raditi-gitea-verify-'))
  await chmod(directory, 0o700)
  await mkdir(join(directory, 'home'))
  await mkdir(join(directory, 'tmp'))
  stage = 'issuing the stand certificates'
  await createCertificates()
  const ca = await readFile(join(directory, 'ca.pem'))

  stage = 'starting the disposable Gitea'
  const port = await availableLoopbackPort()
  // Set before the create, so a partial start is cleaned too.
  containerCreated = true
  await docker(giteaContainerArgs({ name, port }))
  await docker(['cp', join(directory, 'tls'), `${name}:/tls`])
  await docker(['start', name])
  const binding = (await docker(['port', name, '3000/tcp'])).stdout.trim()
  assert.equal(binding, `127.0.0.1:${port}`, 'Gitea is not published on loopback only')
  const deadline = Date.now() + 90_000
  for (;;) {
    const health = await gitea(port, ca, 'GET', '/healthz', {}).catch(() => null)
    if (health?.status === 200) break
    if (controller.signal.aborted) throw new Error('Interrupted')
    if (Date.now() > deadline) throw new Error('Gitea did not become healthy in 90 seconds')
    await sleep(500)
  }
  const version = await gitea(port, ca, 'GET', '/v1/version', { expect: 200 })
  assert.equal(version.json?.version, '1.27.3', 'Unexpected Gitea version')
  passed(`disposable Gitea 1.27.3 answers over HTTPS with the stand CA on 127.0.0.1:${port}`)

  stage = 'creating the organization, the bot and the site repository'
  // Gitea generates each password and prints it: it is never an argument of a process.
  const account = async (user, admin) => {
    const created = await docker(giteaAccountArgs({ container: name, user, admin }))
    return { user, password: generatedGiteaPassword(created.stdout) }
  }
  const admin = await account('stand-admin', true)
  const bot = await account('raditi-bot', false)
  // An owner of the organization (Actions secrets, tag protection) and a second write member.
  const owner = await account('stand-owner', false)
  const writer = await account('stand-writer', false)
  const post = (path, body, as = admin, expect = 201) =>
    gitea(port, ca, 'POST', `/v1${path}`, { ...as, body, expect })
  await post('/orgs', { username: 'sites', visibility: 'private' })
  const team = await post('/orgs/sites/teams', {
    name: 'bots',
    permission: 'write',
    includes_all_repositories: true,
    units: ['repo.code', 'repo.pulls', 'repo.actions'],
  })
  for (const member of [bot, writer])
    await gitea(port, ca, 'PUT', `/v1/teams/${team.json.id}/members/${member.user}`, {
      ...admin,
      expect: 204,
    })
  const teams = await gitea(port, ca, 'GET', '/v1/orgs/sites/teams', { ...admin, expect: 200 })
  const owners = teams.json?.find((entry) => entry.name === 'Owners')
  assert.ok(owners, 'Gitea made no Owners team')
  await gitea(port, ca, 'PUT', `/v1/teams/${owners.id}/members/${owner.user}`, {
    ...admin,
    expect: 204,
  })
  for (const name of ['demo', 'other'])
    await post('/orgs/sites/repos', {
      name,
      private: true,
      auto_init: true,
      default_branch: 'main',
    })
  for (const [path, content] of [
    ['index.php', '<?php echo "synthetic site";\n'],
    ['wp-config.php', '<?php // synthetic protected file\n'],
  ])
    await post(`/repos/sites/demo/contents/${path}`, {
      content: Buffer.from(content).toString('base64'),
      message: `fixture: ${path}`,
      branch: 'main',
    })
  // The narrowest bot token that can issue grants: token calls need write:user, and a grant
  // cannot be broader than the token that creates it (Gitea 1.27.3).
  const token = await post(
    `/users/${bot.user}/tokens`,
    { name: 'raditi-core', scopes: ['write:user', 'write:repository'] },
    bot,
  )
  assert.match(token.json?.sha1 ?? '', /^[0-9a-f]{40}$/, 'Gitea returned no bot token')
  // The narrowest tokens of the other two: what GiteaProvider asks of the owner's.
  const repositoryToken = async (account) => {
    const made = await post(
      `/users/${account.user}/tokens`,
      { name: 'raditi-stand', scopes: ['write:repository'] },
      account,
    )
    assert.match(made.json?.sha1 ?? '', /^[0-9a-f]{40}$/, 'Gitea returned no token')
    return made.json.sha1
  }
  const tokens = { owner: await repositoryToken(owner), writer: await repositoryToken(writer) }
  passed(
    'organization sites: bot and a second member with write access, an owner; private repositories sites/demo and sites/other',
  )

  stage = 'scenario'
  // Docker Desktop and Colima route host.docker.internal to the loopback of the host; on a Linux
  // host the name is the gateway of the default bridge, so the receiver listens there.
  let receiverHost = '127.0.0.1'
  if (process.platform === 'linux') {
    const format = '{{(index .IPAM.Config 0).Gateway}}'
    receiverHost = (
      await docker(['network', 'inspect', 'bridge', '--format', format])
    ).stdout.trim()
  }
  const env = scenarioEnvironment({
    path: process.env.PATH,
    directory,
    url: `https://127.0.0.1:${port}`,
    token: token.json.sha1,
    gitleaks,
    ownerToken: tokens.owner,
    writerToken: tokens.writer,
    receiverHost,
  })
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(here, 'scenario.mjs')], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    const stop = () => child.kill('SIGKILL')
    controller.signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, 5 * 60_000)
    child.once('error', reject)
    child.once('close', (exit) => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', stop)
      done(exit)
    })
  })
  if (controller.signal.aborted) throw new Error('Interrupted')
  if (code !== 0) throw new Error('The scenario failed')
  console.log(
    'PASS Gitea 1.27.3: repository lookup, short-lived grants, git over HTTPS and the release calls',
  )
}

export async function verifyGitea() {
  // Kept until the cleanup has ended, not `once`: with no listener left a repeated signal would
  // end the process in the middle of the cleanup and leave the container behind.
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  let failure
  try {
    await main()
  } catch (error) {
    console.error(`FAIL Gitea stand at ${stage}: ${error instanceof Error ? error.message : ''}`)
    failure = new Error(`Gitea verification failed at ${stage}`)
  } finally {
    stage = 'cleanup'
    if (containerCreated) {
      try {
        await docker(['rm', '--force', '--volumes', name], { cleanup: true, allowFailure: true })
        const left = await docker(['ps', '-aq', '--filter', `label=raditi.stand=${name}`], {
          cleanup: true,
        })
        assert.equal(left.stdout.trim(), '', 'The stand container survived cleanup')
        passed('owned Gitea container removed')
      } catch {
        console.error(`FAIL cleanup of the stand container ${name}`)
        failure = new Error(`Cleanup of ${name} failed`)
      }
    }
    // Certificates, the synthetic HOME and every clone of the scenario (its TMPDIR).
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
  await verifyGitea().catch(() => {
    process.exitCode = 1
  })
}
