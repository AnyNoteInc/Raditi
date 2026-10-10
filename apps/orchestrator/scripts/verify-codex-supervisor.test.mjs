import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { URL } from 'node:url'

import {
  cleanEnvironment,
  localDesktop,
  ownedContainers,
  runnerSettings,
  scenarioEnvironment,
  verifyAgentSupervisor,
} from './verify-agent-supervisor.mjs'

const endpoint = 'unix:///local/desktop.sock'
const image = `local/p4@sha256:${'a'.repeat(64)}`
const settings = {
  P2_RUNNER_DOCKER_SOCKET: '/local/colima/docker.sock',
  P2_GITLEAKS_BINARY: '/local/gitleaks',
  P2_SANDBOX_IMAGE: image,
  P2_RUNNER_NODE_IMAGE: image,
  SANDBOX_GATEWAY_IMAGE: image,
  SANDBOX_NETWORK_GUARD_IMAGE: image,
}
const dirtyEnvironment = {
  PATH: process.env.PATH,
  HOME: '/local/user',
  ...settings,
  DATABASE_URL: 'postgresql://do-not-use:secret@production/db',
  S3_ENDPOINT: 'https://production.invalid',
  S3_ACCESS_KEY_ID: 'old-s3-key',
  S3_SECRET_ACCESS_KEY: 'old-s3-secret',
  S3_BUCKET_SESSIONS: 'old-sessions',
  S3_RUNNER_ENDPOINT: 'https://external.invalid',
  VAULT_ADDR: 'https://vault.invalid',
  VAULT_DEV_ROOT_TOKEN: 'old-root',
  VAULT_ROLE_ID: 'old-role',
  VAULT_SECRET_ID: 'old-secret',
  HTTP_PROXY: 'http://proxy.invalid',
  NODE_OPTIONS: '--require=/do-not-load.cjs',
  DOTENV_CONFIG_PATH: '/do-not-load.env',
  DOCKER_TLS_VERIFY: '1',
  BUILDX_BUILDER: 'remote',
}
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })

test('remote Docker endpoints stop before any engine command', async () => {
  const calls = []
  const command = async (...args) => {
    calls.push(args)
    return ok('ssh://remote')
  }
  await assert.rejects(localDesktop({ DOCKER_HOST: 'tcp://remote:2376' }, command), /local Unix/)
  assert.deepEqual(calls, [])
  await assert.rejects(localDesktop({ DOCKER_CONTEXT: 'remote' }, command), /local Unix/)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][1].slice(0, 3), ['context', 'inspect', 'remote'])
})

test('explicit local context overrides host and pins a clean Desktop connection', async () => {
  const calls = []
  const connection = await localDesktop(
    { ...dirtyEnvironment, DOCKER_CONTEXT: 'desktop-linux', DOCKER_HOST: 'ssh://remote' },
    async (binary, args, options) => {
      calls.push({ binary, args, options })
      return ok(args[0] === 'context' ? endpoint : 'Docker Desktop')
    },
  )
  assert.deepEqual(connection.args, ['--host', endpoint])
  assert.deepEqual(connection.env, { PATH: process.env.PATH, HOME: '/local/user' })
  assert.deepEqual(calls[1].args.slice(0, 3), ['--host', endpoint, 'info'])
  assert.deepEqual(calls[0].options.env, connection.env)
  await assert.rejects(
    localDesktop({ DOCKER_HOST: endpoint }, async () => ok('Ubuntu 24.04')),
    /Docker Desktop/,
  )
})

test('a stand without a second daemon may use the native engine of a Linux host', async () => {
  const native = 'unix:///var/run/docker.sock'
  const calls = []
  const command = async (binary, args, options) => {
    calls.push({ args, options })
    return ok(args[0] === 'context' ? native : 'Ubuntu 24.04.3 LTS')
  }
  // No Desktop context exists there: the current context names the engine.
  const connection = await localDesktop(dirtyEnvironment, command, { nativeLinux: true })
  assert.deepEqual(connection.args, ['--host', native])
  assert.equal(connection.endpoint, native)
  assert.deepEqual(connection.env, { PATH: process.env.PATH, HOME: '/local/user' })
  assert.deepEqual(calls[0].args, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  assert.deepEqual(calls[1].args.slice(0, 3), ['--host', native, 'info'])
  // An explicit context or host still wins, and Docker Desktop stays acceptable.
  calls.length = 0
  await localDesktop({ DOCKER_CONTEXT: 'rootless' }, command, { nativeLinux: true })
  assert.deepEqual(calls[0].args.slice(0, 3), ['context', 'inspect', 'rootless'])
  await localDesktop({ DOCKER_HOST: endpoint }, async () => ok('Docker Desktop'), {
    nativeLinux: true,
  })
  // Still local only, and an engine that does not answer is not accepted.
  await assert.rejects(
    localDesktop({ DOCKER_HOST: 'tcp://remote:2376' }, command, { nativeLinux: true }),
    /local Unix/,
  )
  await assert.rejects(
    localDesktop({ DOCKER_HOST: native }, async () => ok(''), { nativeLinux: true }),
    /Docker Desktop/,
  )
  // Without the option nothing changes: the supervisor stands keep their data services on
  // Docker Desktop, apart from the runner's daemon.
  await assert.rejects(localDesktop({ DOCKER_HOST: native }, command), /Docker Desktop/)
  for (const options of [undefined, {}, { nativeLinux: false }]) {
    calls.length = 0
    await assert.rejects(localDesktop({}, command, options), /Docker Desktop/)
    assert.deepEqual(calls[0].args.slice(0, 3), ['context', 'inspect', 'desktop-linux'])
  }
})

test('the WordPress content stand admits the native engine on Linux only', async () => {
  const source = await readFile(
    new URL('../../../infra/dev/site-verify/verify-content.mjs', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /await localDesktop\(process\.env, command, \{\n\s+nativeLinux: process\.platform === 'linux',\n\s+\}\)/,
  )
  // The supervisor stands need Docker Desktop next to the runner's Colima daemon: unchanged.
  const supervisor = await readFile(
    new URL('./verify-agent-supervisor.mjs', import.meta.url),
    'utf8',
  )
  assert.match(supervisor, /await localDesktop\(environment, \(binary, args, options\) =>/)
  assert.doesNotMatch(
    supervisor.split('export async function verifyAgentSupervisor')[1],
    /nativeLinux/,
  )
})

test('runner settings reject tag-only images, remote socket URLs and public host addresses', () => {
  assert.equal(runnerSettings(settings).P2_RUNNER_HOST, '192.168.5.2')
  for (const invalid of [
    { P2_SANDBOX_IMAGE: 'local/image:latest' },
    { P2_RUNNER_DOCKER_SOCKET: 'ssh://vm/docker.sock' },
    { P2_GITLEAKS_BINARY: 'gitleaks' },
    { P2_RUNNER_HOST: '8.8.8.8' },
    { P2_RUNNER_HOST: 'vm.invalid' },
  ])
    assert.throws(() => runnerSettings({ ...settings, ...invalid }))
})

test('scenario env takes only owned endpoints and explicit runner inputs', () => {
  const env = scenarioEnvironment(dirtyEnvironment, runnerSettings(dirtyEnvironment), {
    marker: 'b'.repeat(32),
    databaseUrl: 'postgresql://raditi:own@127.0.0.1:1111/raditi',
    s3Endpoint: 'http://127.0.0.1:2222',
    vaultAddress: 'http://127.0.0.1:3333',
    accessKey: 'owned-access',
    secretKey: 'owned-secret',
    vaultToken: 'owned-token',
  })
  assert.equal(env.APP_ENV, 'test')
  assert.equal(env.NODE_ENV, 'test')
  assert.match(env.P4_DISPOSABLE_ID, /^[a-f0-9]{32}$/u)
  assert.equal(env.S3_ACCESS_KEY_ID, 'owned-access')
  assert.equal(env.VAULT_DEV_ROOT_TOKEN, 'owned-token')
  assert.equal(env.S3_BUCKET_SESSIONS, `raditi-p4-${'b'.repeat(32)}-sessions`)
  for (const name of [
    'S3_RUNNER_ENDPOINT',
    'VAULT_ROLE_ID',
    'VAULT_SECRET_ID',
    'NODE_OPTIONS',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'HTTP_PROXY',
    'DOTENV_CONFIG_PATH',
    'BUILDX_BUILDER',
  ])
    assert.equal(env[name], undefined, name)
  assert.doesNotMatch(
    JSON.stringify(env),
    /do-not-|old-|production|external\.invalid|vault\.invalid/u,
  )
  assert.deepEqual(cleanEnvironment(dirtyEnvironment), {
    PATH: process.env.PATH,
    HOME: '/local/user',
  })
})

test('cleanup owns a failed run intent and never removes a replaced container', async () => {
  const removed = []
  let attempts = 0
  const resources = ownedContainers(async (args, options) => {
    if (args[0] === 'run') {
      attempts++
      if (attempts === 2) throw new Error('created but CLI failed')
      return ok()
    }
    assert.equal(options.cleanup, true)
    if (args[0] === 'inspect') return ok(args[1].endsWith('-first') ? 'another-owner' : 'owned')
    if (args[0] === 'rm') {
      removed.push(args[2])
      return ok()
    }
    if (args[0] === 'ps') return ok()
    assert.fail('Unexpected command')
  }, 'owned')
  await resources.start('first', [image])
  await assert.rejects(resources.start('second', [image]))
  await assert.rejects(resources.close(), /cleanup failed/)
  assert.deepEqual(removed, ['raditi-p4-supervisor-owned-second'])
})

async function fakeRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'p4-launcher-test-'))
  const socket = join(directory, 'docker.sock')
  const server = createServer()
  await new Promise((resolve) => server.listen(socket, resolve))
  const gitleaks = join(directory, 'gitleaks')
  await writeFile(gitleaks, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  return {
    environment: {
      ...dirtyEnvironment,
      P2_RUNNER_DOCKER_SOCKET: socket,
      P2_GITLEAKS_BINARY: gitleaks,
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

// Every shell the launcher runs, with the name its PASS line carries.
const launchers = { codex: 'Codex', kimi: 'Kimi', opencode: 'OpenCode' }
for (const [driverId, driverName] of Object.entries(launchers))
  for (const interrupt of [false, true])
    test(`launcher ${driverId} ${interrupt ? 'SIGTERM failure' : 'success'} cleans resources and keeps environment pinned`, async () => {
      const runtime = await fakeRuntime()
      const signals = new EventEmitter()
      const containers = new Map()
      const envFiles = []
      const log = []
      let childEnv, fixtureDirectory, stdinConfig, failure
      const command = async (binary, args, options) => {
        if (binary !== 'docker') {
          assert.equal(binary, process.execPath)
          assert.deepEqual(args, ['scripts/verify-runner.mjs', `--${driverId}`])
          assert(options.abortGraceMs >= 60_000)
          childEnv = options.env
          assert.match(childEnv.P4_DISPOSABLE_ID, /^[a-f0-9]{32}$/u)
          assert.doesNotMatch(JSON.stringify(childEnv), /old-root|production|do-not-load/u)
          if (interrupt) {
            signals.emit('SIGTERM')
            assert.equal(options.signal.aborted, true)
            throw Object.assign(new Error('child failed'), {
              verificationOutput: childEnv.VAULT_DEV_ROOT_TOKEN,
            })
          }
          return ok(`Do not print this credential: ${childEnv.VAULT_DEV_ROOT_TOKEN}`)
        }
        if (args[0] === 'context') return ok(endpoint)
        assert.deepEqual(args.slice(0, 2), ['--host', endpoint])
        assert.deepEqual(options.env, cleanEnvironment(runtime.environment))
        const cmd = args.slice(2)
        if (cmd[0] === 'info') return ok('Docker Desktop')
        if (cmd[0] === 'image') return ok('sha256:owned-image')
        if (cmd[0] === 'run') {
          assert(cmd.includes('--pull=never'))
          assert(cmd.includes('--tmpfs'))
          assert(!cmd.includes('--volume') && !cmd.includes('-v'))
          assert.match(cmd[cmd.indexOf('-p') + 1], /^127\.0\.0\.1::/u)
          const name = cmd[cmd.indexOf('--name') + 1]
          containers.set(name, cmd[cmd.indexOf('--label') + 1].split('=')[1])
          if (cmd.includes('--env-file')) {
            const file = cmd[cmd.indexOf('--env-file') + 1]
            envFiles.push(file)
            assert.equal((await stat(file)).mode & 0o777, 0o600)
          }
          // A user's context change mid-flight cannot redirect any later operation.
          runtime.environment.DOCKER_HOST = 'ssh://elsewhere'
          return ok(name)
        }
        if (cmd[0] === 'exec') {
          stdinConfig = JSON.parse(options.input)
          return ok()
        }
        if (cmd[0] === 'port')
          return ok(
            `127.0.0.1:${cmd[2].startsWith('5432') ? 15432 : cmd[2].startsWith('8333') ? 18333 : 18200}`,
          )
        if (cmd[0] === 'inspect') {
          assert(options.cleanup)
          return ok(containers.get(cmd[1]))
        }
        if (cmd[0] === 'rm') {
          assert(options.cleanup)
          assert.equal(cmd[1], '-fv')
          containers.delete(cmd[2])
          return ok()
        }
        if (cmd[0] === 'ps') return ok([...containers.keys()].join('\n'))
        assert.fail(`Unexpected Docker command ${cmd[0]}`)
      }
      try {
        try {
          await verifyAgentSupervisor({
            driverId,
            environment: runtime.environment,
            command,
            signals,
            log: (value) => log.push(value),
            provision: async ({ directory, env }) => {
              fixtureDirectory = directory
              assert.equal(stdinConfig.identities[0].credentials[0].accessKey, env.S3_ACCESS_KEY_ID)
              assert.equal(
                stdinConfig.identities[0].credentials[0].secretKey,
                env.S3_SECRET_ACCESS_KEY,
              )
              assert.match(
                env.DATABASE_URL,
                /^postgresql:\/\/raditi:[a-f0-9]+@127\.0\.0\.1:15432\/raditi$/u,
              )
            },
          })
        } catch (error) {
          failure = error
        }
        assert.equal(Boolean(failure), interrupt)
        assert(childEnv)
        assert.equal(containers.size, 0)
        assert.equal(signals.listenerCount('SIGINT'), 0)
        assert.equal(signals.listenerCount('SIGTERM'), 0)
        await assert.rejects(stat(fixtureDirectory), { code: 'ENOENT' })
        for (const file of envFiles) await assert.rejects(stat(file), { code: 'ENOENT' })
        assert(!log.join('\n').includes(childEnv.VAULT_DEV_ROOT_TOKEN))
        if (failure) {
          assert(!failure.message.includes(childEnv.VAULT_DEV_ROOT_TOKEN))
          assert.equal((await stat(failure.diagnosticPath)).mode & 0o777, 0o600)
          assert.equal(
            (await readFile(failure.diagnosticPath, 'utf8')).trim(),
            childEnv.VAULT_DEV_ROOT_TOKEN,
          )
        } else assert(log.some((line) => line.startsWith(`PASS real ${driverName} supervisor`)))
      } finally {
        if (failure?.diagnosticPath)
          await rm(dirname(failure.diagnosticPath), { recursive: true, force: true })
        await runtime.close()
      }
    })
