import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  GITEA_IMAGE,
  certificateConfigs,
  generatedGiteaPassword,
  giteaAccountArgs,
  giteaContainerArgs,
  scenarioEnvironment,
  standOptions,
} from './stand.mjs'

test('the Gitea of the stand is the pinned 1.27.3 image, never pulled', () => {
  assert.match(GITEA_IMAGE, /^gitea\/gitea:1\.27\.3-rootless@sha256:[a-f0-9]{64}$/)
  const args = giteaContainerArgs({ name: 'raditi-gitea-verify-0123abcd', port: 43210 })
  assert.deepEqual(args.slice(0, 4), ['create', '--pull', 'never', '--name'])
  assert.equal(args.at(-1), GITEA_IMAGE)
})

test('the container is its own, on loopback only, with HTTPS and no host mounts', () => {
  const args = giteaContainerArgs({ name: 'raditi-gitea-verify-0123abcd', port: 43210 })
  const values = (flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
  assert.deepEqual(values('--name'), ['raditi-gitea-verify-0123abcd'])
  assert.deepEqual(values('--label'), ['raditi.stand=raditi-gitea-verify-0123abcd'])
  assert.deepEqual(values('-p'), ['127.0.0.1:43210:3000'])
  assert.deepEqual(values('-v'), [])
  assert.deepEqual(values('--volume'), [])
  assert.deepEqual(values('--network'), [])
  assert.deepEqual(values('--add-host'), ['host.docker.internal:host-gateway'])
  const env = Object.fromEntries(values('-e').map((pair) => pair.split(/=(.*)/s).slice(0, 2)))
  assert.equal(env.GITEA__server__PROTOCOL, 'https')
  assert.equal(env.GITEA__server__ROOT_URL, 'https://127.0.0.1:43210/')
  assert.equal(env.GITEA__server__CERT_FILE, '/tls/server.pem')
  assert.equal(env.GITEA__server__KEY_FILE, '/tls/server-key.pem')
  assert.equal(env.GITEA__service__DISABLE_REGISTRATION, 'true')
  assert.equal(env.GITEA__server__START_SSH_SERVER, 'false')
  // Runs are created and stay queued (no runner); webhooks reach a private address only.
  assert.equal(env.GITEA__actions__ENABLED, 'true')
  assert.equal(env.GITEA__webhook__ALLOWED_HOST_LIST, 'private')
  // Workflow files of a repository run here: the tag runs and dispatch of the scenario need them.
  assert.ok(!('GITEA__actions__WORKFLOW_DIRS' in env))
})

test('the dev Gitea runs no workflow file of a site repository (plan 53, Р28)', async () => {
  const { REPOSITORY_WORKFLOWS_OFF } = await import('../pipeline-verify/stand.mjs')
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
  const gitea = /\n {2}gitea:\n([\s\S]*?)\n {2}[a-z][a-z-]*:\n/.exec(compose)?.[1] ?? ''
  assert.match(gitea, /image: gitea\/gitea:1\.27\.3-rootless/)
  assert.equal(
    /GITEA__actions__WORKFLOW_DIRS: (\S+)/.exec(gitea)?.[1],
    REPOSITORY_WORKFLOWS_OFF,
    'the dev Gitea must keep workflow files of repositories from running',
  )
  assert.equal(REPOSITORY_WORKFLOWS_OFF, '.git/raditi-no-repository-workflows')
})

test('a name that is not the stand’s own is refused', () => {
  for (const name of ['raditi-dev-gitea-1', 'gitea', 'raditi-gitea-verify-', ''])
    assert.throws(() => giteaContainerArgs({ name, port: 43210 }), /stand's own container/)
  for (const port of [0, 80, 65536, '43210', 1.5])
    assert.throws(() => giteaContainerArgs({ name: 'raditi-gitea-verify-0123abcd', port }), /port/)
})

test('the server certificate is for the loopback address and for server use only', () => {
  const { authority, server } = certificateConfigs()
  assert.match(authority, /basicConstraints = critical, CA:true/)
  assert.match(authority, /keyUsage = critical, keyCertSign/)
  assert.match(server, /basicConstraints = critical, CA:false/)
  assert.match(server, /extendedKeyUsage = serverAuth/)
  assert.match(server, /subjectAltName = IP:127\.0\.0\.1, DNS:localhost/)
})

test('the scenario gets a synthetic HOME and nothing of the caller but PATH', () => {
  const env = scenarioEnvironment({
    path: '/usr/bin:/bin',
    directory: '/tmp/raditi-gitea-verify-x',
    url: 'https://127.0.0.1:43210',
    token: 'synthetic-bot-token',
    gitleaks: '/opt/gitleaks/gitleaks',
    ownerToken: 'synthetic-owner-token',
    writerToken: 'synthetic-writer-token',
    receiverHost: '127.0.0.1',
  })
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/raditi-gitea-verify-x/home',
    TMPDIR: '/tmp/raditi-gitea-verify-x/tmp',
    APP_ENV: 'test',
    NODE_EXTRA_CA_CERTS: '/tmp/raditi-gitea-verify-x/ca.pem',
    GIT_CA_FILE: '/tmp/raditi-gitea-verify-x/ca.pem',
    GITEA_URL: 'https://127.0.0.1:43210',
    GITEA_TOKEN: 'synthetic-bot-token',
    P2_GITLEAKS_BINARY: '/opt/gitleaks/gitleaks',
    STAND_OWNER_TOKEN: 'synthetic-owner-token',
    STAND_WRITER_TOKEN: 'synthetic-writer-token',
    STAND_RECEIVER_HOST: '127.0.0.1',
  })
})

test('an account gets a password Gitea generates: it is never a process argument', () => {
  const container = 'raditi-gitea-verify-0123abcd'
  const args = giteaAccountArgs({ container, user: 'raditi-bot' })
  assert.deepEqual(args, [
    ...['exec', container, 'gitea', 'admin', 'user', 'create', '--username', 'raditi-bot'],
    ...['--random-password', '--random-password-length', '36'],
    ...['--email', 'raditi-bot@example.test', '--must-change-password=false'],
  ])
  assert.deepEqual(giteaAccountArgs({ container, user: 'stand-admin', admin: true }), [
    ...['exec', container, 'gitea', 'admin', 'user', 'create', '--username', 'stand-admin'],
    ...['--random-password', '--random-password-length', '36'],
    ...['--email', 'stand-admin@example.test', '--must-change-password=false', '--admin'],
  ])
  // The Gitea of the pipeline stand is created the same way.
  assert.equal(
    giteaAccountArgs({ container: 'raditi-pipeline-verify-0123abcd-gitea', user: 'raditi-bot' })[1],
    'raditi-pipeline-verify-0123abcd-gitea',
  )
  // And the Gitea of the release stand.
  assert.equal(
    giteaAccountArgs({ container: 'raditi-release-verify-0123abcd-gitea', user: 'raditi-bot' })[1],
    'raditi-release-verify-0123abcd-gitea',
  )
  for (const other of [
    'raditi-dev-gitea-1',
    'gitea',
    '',
    'raditi-gitea-verify-0123abcd x',
    'raditi-release-verify-0123abcd-runner',
  ])
    assert.throws(
      () => giteaAccountArgs({ container: other, user: 'raditi-bot' }),
      /stand's own container/,
    )
  for (const user of ['', '--admin', 'a b', 'Bot', 'x'.repeat(41)])
    assert.throws(() => giteaAccountArgs({ container, user }), /account name/)

  // What Gitea 1.27.3 prints (recorded from the pinned image; the value here is synthetic).
  const password = 'Zx9'.repeat(12)
  const output = `generated random password is '${password}'\nNew user 'raditi-bot' has been successfully created!\n`
  assert.equal(generatedGiteaPassword(output), password)
  for (const text of [
    '',
    "New user 'raditi-bot' has been successfully created!\n",
    "generated random password is ''\n",
    "generated random password is 'short'\n",
  ])
    assert.throws(() => generatedGiteaPassword(text), /generated password/)

  const stand = readFileSync(new URL('./verify-gitea.mjs', import.meta.url), 'utf8')
  assert.match(stand, /docker\(giteaAccountArgs\(\{ container: name, user, admin \}\)\)/)
  assert.match(stand, /generatedGiteaPassword\(/)
  assert.doesNotMatch(stand, /'--password'/)
})

test('the stand takes no options: neither an external Gitea nor a real token', () => {
  assert.deepEqual(standOptions([]), {})
  assert.deepEqual(standOptions(['--']), {})
  for (const argv of [['--url=https://gitea.example.test'], ['--token', 'x'], ['--keep']])
    assert.throws(() => standOptions(argv), /accepts no options/)
})

test('a repeated signal cannot end the cleanup', () => {
  const stand = readFileSync(new URL('./verify-gitea.mjs', import.meta.url), 'utf8')
  // With `once` no listener is left after the first signal: the second one (a second Ctrl-C,
  // a CI cancellation) ends the process in the middle of its cleanup and the container stays.
  assert.match(stand, /process\.on\('SIGINT', interrupt\)\n {2}process\.on\('SIGTERM', interrupt\)/)
  assert.doesNotMatch(stand, /process\.once\('SIG/)
  // Removed only after the container and the temporary directory are gone.
  assert.match(
    stand,
    /passed\('temporary directory of the stand removed'\)[\s\S]*process\.removeListener\('SIGTERM', interrupt\)/,
  )
})

test('a signal to pnpm reaches the stand: its script line replaces the shell', () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  )
  // pnpm passes a signal on to the `sh -c` of the line, and sh does not pass it on to a child
  // it waits for. Without `exec` pnpm ends at once while the stand is still running.
  assert.equal(
    scripts['verify:gitea'],
    'pnpm --filter core build && exec node infra/dev/gitea-verify/verify-gitea.mjs',
  )
})
