// The checks of `pnpm verify:gitea`, run by verify-gitea.mjs in a process of its own: synthetic
// HOME, the stand's CA through NODE_EXTRA_CA_CERTS (REST) and GIT_CA_FILE (git), the built
// orchestrator composed as GitWorkspaceModule composes it.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import { loadConfig } from '../../../apps/core/dist/config/config.js'
import { emptyUntrackedArchive } from '../../../apps/core/dist/git-workspace/archive.js'
import {
  configuredGitProvider,
  gitWorkspaceOptions,
} from '../../../apps/core/dist/git-workspace/git-config.js'
import { GitWorkspaceService } from '../../../apps/core/dist/git-workspace/git-workspace.service.js'
import { verifyReleaseCalls } from './release-scenario.mjs'
import { verifyWorkingSet } from './working-set-scenario.mjs'

const {
  GITEA_URL,
  GITEA_TOKEN,
  GIT_CA_FILE,
  P2_GITLEAKS_BINARY,
  STAND_OWNER_TOKEN,
  STAND_WRITER_TOKEN,
  STAND_RECEIVER_HOST,
} = process.env
const repo = { provider: 'gitea', owner: 'sites', name: 'demo' }
const protectedPaths = ['wp-config.php', 'wp-admin/', 'wp-includes/']
const createdAt = '2026-10-04T06:00:00.000Z'
const execute = promisify(execFile)
const passed = (text) => console.log(`PASS ${text}`)
let stage = 'configuration'

/** Core settings that open no connection here; only the git part is under test. */
const coreEnv = (git) => ({
  APP_ENV: 'test',
  APP_URL: 'http://127.0.0.1:1',
  DATABASE_URL: 'postgresql://raditi:synthetic@127.0.0.1:1/raditi',
  REDIS_URL: 'redis://127.0.0.1:1',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  S3_ACCESS_KEY_ID: 'synthetic',
  S3_SECRET_ACCESS_KEY: 'synthetic-secret',
  VAULT_ADDR: 'http://127.0.0.1:1',
  VAULT_DEV_ROOT_TOKEN: 'synthetic',
  SANDBOX_IMAGE: `raditi/sbx-wordpress@sha256:${'a'.repeat(64)}`,
  METRICS_TOKEN: 'synthetic-metrics-token',
  ...git,
})

/** Plain git of the fixture: its own HOME, no system or user configuration, the stand CA. */
async function git(cwd, args, { grant, allowFailure = false, trustStandCa = true } = {}) {
  const auth = grant
    ? `Authorization: Basic ${Buffer.from(`${grant.username}:${grant.token}`).toString('base64')}`
    : undefined
  try {
    const { stdout } = await execute(
      'git',
      [...(auth ? ['--config-env=http.extraHeader=STAND_GIT_AUTH'] : []), ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          ...(trustStandCa ? { GIT_SSL_CAINFO: GIT_CA_FILE } : {}),
          GIT_AUTHOR_NAME: 'Stand agent',
          GIT_AUTHOR_EMAIL: 'agent@example.test',
          GIT_COMMITTER_NAME: 'Stand agent',
          GIT_COMMITTER_EMAIL: 'agent@example.test',
          ...(auth ? { STAND_GIT_AUTH: auth } : {}),
        },
      },
    )
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    if (!allowFailure) throw new Error(`Fixture git ${args[0]} failed during ${stage}`)
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(error.stderr ?? '').toString('utf8'),
    }
  }
}

/** The server as an outside observer sees it: the REST API with the bot token. */
async function gitea(path, { basic = false, token = GITEA_TOKEN } = {}) {
  const response = await fetch(`${GITEA_URL}/api/v1${path}`, {
    headers: {
      accept: 'application/json',
      authorization: basic
        ? `Basic ${Buffer.from(`raditi-bot:${token}`).toString('base64')}`
        : `token ${token}`,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // Raw file content is not JSON.
  }
  return { status: response.status, json, text }
}
const serverHead = async (branch) => {
  const answer = await gitea(`/repos/sites/demo/branches/${encodeURIComponent(branch)}`)
  if (answer.status === 404) return null
  assert.equal(answer.status, 200, 'Gitea did not answer a branch lookup')
  return answer.json.commit.id
}
const serverCommit = async (sha) => {
  const answer = await gitea(`/repos/sites/demo/git/commits/${sha}`)
  assert.equal(answer.status, 200, 'Gitea did not answer a commit lookup')
  return answer.json
}
/** Every page of the bot's token list, read to its end. */
const grantNames = async () => {
  const names = []
  for (let page = 1; ; page++) {
    const answer = await gitea(`/users/raditi-bot/tokens?page=${page}&limit=50`, { basic: true })
    assert.equal(answer.status, 200, 'Gitea did not list the tokens of the bot')
    assert.ok(answer.json.length <= 50, 'Gitea answered a longer page than was asked for')
    if (answer.json.length === 0) return names.filter((name) => name.startsWith('raditi-git-'))
    names.push(...answer.json.map((token) => token.name))
  }
}
/** A token call of Gitea with a credential as the Basic password, as the adapter makes them. */
const tokenCall = (method, credential, body) =>
  fetch(`${GITEA_URL}/api/v1/users/raditi-bot/tokens`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`raditi-bot:${credential}`).toString('base64')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  })
const rejects = async (promise, code, message) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  )
  assert.equal(error?.code, code, message)
}

async function main() {
  // 1. CoreConfig.git and the composition of GitWorkspaceModule.
  const { git: gitConfig } = loadConfig(coreEnv({ GITEA_URL, GITEA_TOKEN, GIT_CA_FILE }))
  assert.deepEqual(
    gitConfig,
    { kind: 'gitea', baseUrl: GITEA_URL, token: GITEA_TOKEN, caFile: GIT_CA_FILE },
    'Core config did not take git from GITEA_URL, GITEA_TOKEN and GIT_CA_FILE',
  )
  const plain = loadConfig(
    coreEnv({ GITEA_URL: GITEA_URL.replace('https:', 'http:'), GITEA_TOKEN }),
  )
  assert.equal(plain.git, null, 'A plain-http Gitea must leave git unconfigured')
  const real = configuredGitProvider(gitConfig)
  const grants = []
  const provider = {
    ...real,
    issueCredentials: async (...args) => {
      const grant = await real.issueCredentials(...args)
      grants.push({ access: args[1], ttl: args[2], ...grant })
      return grant
    },
  }
  const count = (access) => grants.filter((grant) => grant.access === access).length
  const service = new GitWorkspaceService(provider, {
    ...gitWorkspaceOptions(gitConfig),
    gitleaksBinary: P2_GITLEAKS_BINARY,
  })
  passed('core config: git from GITEA_URL, GITEA_TOKEN, GIT_CA_FILE; plain http leaves it off')

  stage = 'repository lookup'
  assert.deepEqual(
    await provider.getRepository(repo),
    { ref: repo, defaultBranch: 'main', cloneUrl: `${GITEA_URL}/sites/demo.git`, private: true },
    'Unexpected repository of the site',
  )
  assert.equal(await provider.getRepository({ ...repo, name: 'missing' }), null)
  passed('getRepository: the private repository sites/demo; a missing one is null')

  stage = 'branch head'
  const taskId = `task${randomBytes(6).toString('hex')}`
  const branch = `agent/${taskId}`
  const baseSha = await service.readBranchHead({ repo, branch: 'main' })
  assert.match(baseSha ?? '', /^[a-f0-9]{40}$/, 'The head of main was not read')
  assert.equal(baseSha, await serverHead('main'), 'The head of main differs from the server')
  assert.equal(await service.readBranchHead({ repo, branch }), null, 'A missing branch has a head')
  assert.deepEqual([count('read'), count('write')], [2, 0], 'Branch heads need read grants only')
  passed('branch head: main matches the server, a missing task branch is null (read grants)')

  stage = 'clone with a read grant'
  const source = { repo, branch, expectedBaseSha: baseSha, protectedPaths }
  const directory = await mkdtemp(join(tmpdir(), 'scenario-'))
  const checkout = async (name, bundleSource) => {
    const bundle = await service.buildBaseBundle(bundleSource)
    const chunks = []
    for await (const chunk of bundle.read()) chunks.push(chunk)
    const file = join(directory, `${name}.bundle`)
    await writeFile(file, Buffer.concat(chunks))
    const work = join(directory, name)
    await git(directory, ['clone', '--quiet', '--branch', 'raditi-base', file, work])
    return { bundle, work }
  }
  const first = await checkout('turn1', source)
  assert.equal(first.bundle.baseSha, baseSha)
  assert.equal(
    (await git(first.work, ['rev-parse', 'HEAD'])).stdout.toString().trim(),
    baseSha,
    'The bundle does not carry the expected base',
  )
  assert.deepEqual([count('read'), count('write')], [3, 0], 'A clone needs one read grant')
  assert.deepEqual([grants.at(-1).access, grants.at(-1).ttl], ['read', 120])
  // The same read grant cannot push: Gitea, not the platform, refuses it.
  const refused = await git(
    first.work,
    ['push', `${GITEA_URL}/sites/demo.git`, 'HEAD:refs/heads/agent/read-grant-probe'],
    { grant: grants.at(-1), allowFailure: true },
  )
  assert.notEqual(refused.code, 0, 'A read grant pushed a branch')
  assert.equal(await serverHead('agent/read-grant-probe'), null)
  passed('clone over HTTPS with a 120-second read grant; the read grant cannot push')

  stage = 'push with a write grant'
  const change = async (work, files) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(work, path, '..'), { recursive: true })
      await writeFile(join(work, path), content)
    }
    await git(work, ['add', '--all'])
    const diff = ['diff', '--cached', '--binary', '--full-index', '--no-renames', 'HEAD', '--']
    return (await git(work, diff)).stdout
  }
  const metadata = { ...source, taskId, turn: 1, createdAt }
  const input = (overrides = {}) => ({
    ...metadata,
    untracked: emptyUntrackedArchive(),
    credentials: [],
    ...overrides,
  })
  const patch = await change(first.work, {
    'index.php': '<?php echo "changed by the turn";\n',
    'assets/site.css': 'body { color: #123456; }\n',
  })
  const candidate = await service.preparePublication(input({ patch }))
  assert.equal(await serverHead(branch), null, 'The branch appeared before publish()')
  assert.equal(count('write'), 0, 'A write grant was issued before publish()')
  let fenced = 0
  await candidate.publish(async () => void fenced++)
  assert.equal(fenced, 1, 'The publication fence was not asserted')
  assert.equal(count('write'), 1, 'A push needs exactly one write grant')
  assert.equal(await serverHead(branch), candidate.headSha, 'The server has another head')
  const pushed = await serverCommit(candidate.headSha)
  assert.deepEqual(
    [pushed.commit.author.name, pushed.commit.author.email, pushed.parents.map((p) => p.sha)],
    ['Raditi Bot', 'bot@raditi.ru', [baseSha]],
    'The published commit is not the bot commit on the base',
  )
  const published = await gitea(`/repos/sites/demo/raw/index.php?ref=${candidate.headSha}`)
  assert.equal(published.text, '<?php echo "changed by the turn";\n')
  assert.equal(await service.readBranchHead({ repo, branch }), candidate.headSha)
  // The term of a grant rests on this: a grant cannot create a token that outlives it.
  const writer = grants.findLast((grant) => grant.access === 'write')
  const probe = `raditi-probe-${randomBytes(8).toString('hex')}`
  for (const scope of ['write:repository', 'read:repository']) {
    const minted = await tokenCall('POST', writer.token, { name: probe, scopes: [scope] })
    assert.equal(minted.status, 403, 'A grant created another token')
  }
  assert.equal((await tokenCall('GET', writer.token)).status, 403, 'A grant listed the tokens')
  passed(`push to agent/<taskId> with a 120-second write grant; the server head is the bot commit`)
  passed('a write grant can neither create nor list tokens: it cannot outlive its term')

  stage = 'repeated push'
  await candidate.publish(async () => {})
  const again = await service.preparePublication(input({ patch }))
  assert.equal(again.headSha, candidate.headSha, 'The candidate is not deterministic')
  await again.publish(async () => {})
  assert.equal(await serverHead(branch), candidate.headSha, 'A repeated push moved the branch')
  assert.deepEqual(
    (await serverCommit(candidate.headSha)).parents.map((p) => p.sha),
    [baseSha],
  )
  await Promise.all([candidate.dispose(), again.dispose()])
  passed('a repeated publication of the same turn leaves the branch where it is')

  stage = 'second turn'
  const second = await checkout('turn2', { ...source, expectedBaseSha: candidate.headSha })
  const next = await service.preparePublication({
    ...input({ patch: await change(second.work, { 'index.php': '<?php echo "turn two";\n' }) }),
    expectedBaseSha: candidate.headSha,
    turn: 2,
  })
  await next.publish(async () => {})
  assert.equal(await serverHead(branch), next.headSha)
  assert.deepEqual(
    (await serverCommit(next.headSha)).parents.map((p) => p.sha),
    [candidate.headSha],
  )
  await next.dispose()
  passed('the next turn moves the task branch from the previous head (compare-and-swap push)')

  stage = 'turn without file changes'
  const quietId = `task${randomBytes(6).toString('hex')}`
  const quiet = await service.preparePublication({
    ...input({ patch: Buffer.alloc(0) }),
    branch: `agent/${quietId}`,
    taskId: quietId,
  })
  assert.notEqual(quiet.headSha, baseSha, 'A turn without changes produced no commit')
  assert.equal(quiet.patch.byteLength, 0, 'A turn without changes has a patch')
  await quiet.publish(async () => {})
  assert.equal(await serverHead(`agent/${quietId}`), quiet.headSha)
  const empty = await serverCommit(quiet.headSha)
  assert.deepEqual(
    empty.parents.map((p) => p.sha),
    [baseSha],
  )
  // The tree is compared by git itself: Gitea's commit API reports the commit id as the tree.
  const reader = await real.issueCredentials(repo, 'read', 30)
  await git(first.work, ['fetch', '--quiet', `${GITEA_URL}/sites/demo.git`, quiet.headSha], {
    grant: reader,
  })
  const tree = async (sha) =>
    (await git(first.work, ['rev-parse', `${sha}^{tree}`])).stdout.toString().trim()
  assert.equal(await tree(quiet.headSha), await tree(baseSha), 'The empty commit changed the tree')
  assert.match(empty.commit.message, new RegExp(`^Raditi task ${quietId}, turn 1\\n`))
  await quiet.dispose()
  passed('a turn without file changes publishes one empty bot commit on agent/<taskId>')

  stage = 'forbidden diff'
  const writes = count('write')
  for (const [name, files] of [
    ['a workflow under .gitea/', { '.gitea/workflows/deploy.yml': 'on: push\n' }],
    ['a protected path of the site', { 'wp-config.php': '<?php // changed\n' }],
  ]) {
    const id = `task${randomBytes(6).toString('hex')}`
    const work = (await checkout(id, { ...source, branch: `agent/${id}` })).work
    await rejects(
      service.preparePublication({
        ...input({ patch: await change(work, files) }),
        branch: `agent/${id}`,
        taskId: id,
      }),
      'PUBLICATION_FORBIDDEN',
      `A diff with ${name} was not refused`,
    )
    assert.equal(await serverHead(`agent/${id}`), null, `A branch exists after ${name}`)
  }
  assert.equal(count('write'), writes, 'A refused diff was given a write grant')
  passed('a diff that touches .gitea/ or a protected path is refused before any write grant')

  stage = 'expiry of a grant'
  const short = await real.issueCredentials(repo, 'read', 5)
  const url = `${GITEA_URL}/sites/demo.git`
  const lsRemote = () =>
    git(directory, ['ls-remote', '--refs', url, 'refs/heads/main'], {
      grant: short,
      allowFailure: true,
    })
  assert.equal((await lsRemote()).code, 0, 'A fresh grant does not work')
  const name = new RegExp(`^raditi-git-r-${Math.ceil(short.expiresAt.getTime() / 1000)}-`)
  assert.equal((await grantNames()).filter((n) => name.test(n)).length, 1)
  await sleep(short.expiresAt.getTime() - Date.now() + 2000)
  assert.notEqual((await lsRemote()).code, 0, 'git still works with an expired grant')
  const expired = await gitea('/repos/sites/demo', { token: short.token })
  assert.equal(expired.status, 401, 'The API still accepts an expired grant')
  assert.equal((await grantNames()).filter((n) => name.test(n)).length, 0)
  passed('a 5-second grant works at once and is refused by git and the API after its term')

  stage = 'sweep of expired grants'
  // What a process killed before its timers fired leaves behind — more than one page of the
  // token list — and a grant still alive.
  const fixture = (access, seconds) =>
    `raditi-git-${access}-${Math.floor(Date.now() / 1000) + seconds}-${randomBytes(8).toString('hex')}`
  const leftovers = Array.from({ length: 55 }, () => fixture('w', -60))
  const alive = fixture('r', 600)
  for (const token of [...leftovers, alive]) {
    const created = await tokenCall('POST', GITEA_TOKEN, {
      name: token,
      scopes: ['read:repository'],
    })
    assert.equal(created.status, 201, 'The fixture token was not created')
    await created.body?.cancel()
  }
  const before = await grantNames()
  assert.equal(leftovers.filter((token) => before.includes(token)).length, 55)
  // A new provider is a restarted core: it sweeps before the first grant it issues.
  await configuredGitProvider(gitConfig).issueCredentials(repo, 'read', 5)
  const names = await grantNames()
  assert.deepEqual(
    leftovers.filter((token) => names.includes(token)),
    [],
    'An expired grant survived the sweep',
  )
  assert.equal(names.includes(alive), true, 'The sweep deleted a grant that is still alive')
  passed('a restarted provider sweeps 55 expired grants over two pages and keeps the live ones')

  stage = 'start and stop of a process'
  // What GitWorkspaceModule does around the life of core: a sweep at start, before any grant
  // is asked for, and at shutdown the end of every grant this process issued.
  const stale = fixture('w', -60)
  const staleCreated = await tokenCall('POST', GITEA_TOKEN, {
    name: stale,
    scopes: ['read:repository'],
  })
  assert.equal(staleCreated.status, 201, 'The fixture token was not created')
  await staleCreated.body?.cancel()
  const restarted = configuredGitProvider(gitConfig)
  await restarted.sweepCredentials()
  const afterStart = await grantNames()
  assert.equal(afterStart.includes(stale), false, 'The sweep at start left an expired grant')
  assert.equal(afterStart.includes(alive), true, 'The sweep at start deleted a live grant')
  const held = await restarted.issueCredentials(repo, 'write', 120)
  assert.equal((await gitea('/repos/sites/demo', { token: held.token })).status, 200)
  await restarted.revokeCredentials()
  assert.equal(
    (await gitea('/repos/sites/demo', { token: held.token })).status,
    401,
    'A grant of a stopped process is still accepted',
  )
  assert.ok(held.expiresAt.getTime() - Date.now() > 60_000, 'The grant ended by its term instead')
  assert.equal(
    (await grantNames()).includes(alive),
    true,
    'A stop deleted a grant it did not issue',
  )
  passed('a starting provider sweeps before any grant; a stopping one ends its live grants at once')

  stage = 'TLS verification'
  const systemTrust = { ...gitWorkspaceOptions(gitConfig).transport }
  delete systemTrust.caFile
  await rejects(
    new GitWorkspaceService(provider, { transport: systemTrust }).readBranchHead({
      repo,
      branch: 'main',
    }),
    'GIT_OPERATION_FAILED',
    'git trusted the stand certificate without the CA file',
  )
  // The reason, from git itself with a valid grant: the certificate, not the credential.
  const untrusted = await git(directory, ['ls-remote', '--refs', url, 'refs/heads/main'], {
    grant: await real.issueCredentials(repo, 'read', 5),
    allowFailure: true,
    trustStandCa: false,
  })
  assert.notEqual(untrusted.code, 0, 'git trusted the stand certificate by the system store')
  assert.match(untrusted.stderr, /certificate/i, 'git failed for another reason than the CA')
  passed('without GIT_CA_FILE git refuses the certificate: verification stays on')

  await verifyReleaseCalls({
    url: GITEA_URL,
    botToken: GITEA_TOKEN,
    ownerToken: STAND_OWNER_TOKEN,
    writerToken: STAND_WRITER_TOKEN,
    receiverHost: STAND_RECEIVER_HOST,
    repo,
    git,
    directory,
    stage: (name) => {
      stage = name
    },
    passed,
  })

  // Last: it moves main of sites/demo.
  await verifyWorkingSet({
    url: GITEA_URL,
    repo,
    provider,
    real,
    count,
    options: { ...gitWorkspaceOptions(gitConfig), gitleaksBinary: P2_GITLEAKS_BINARY },
    git,
    directory,
    serverHead,
    serverCommit,
    createdAt,
    protectedPaths,
    stage: (name) => {
      stage = name
    },
    passed,
  })

  await rm(directory, { recursive: true, force: true })
}

try {
  await main()
} catch (error) {
  // Synthetic data only, but an assertion diff may still quote a token of the stand.
  const detail =
    error instanceof assert.AssertionError
      ? error.generatedMessage
        ? 'assertion'
        : error.message.split('\n')[0]
      : error instanceof Error
        ? `${error.code ? `${error.code}: ` : ''}${error.message}`
        : 'error'
  console.error(`FAIL scenario at ${stage}: ${detail}`)
  process.exitCode = 1
}
