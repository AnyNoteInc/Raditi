/* global process, URL */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const verifier = fileURLToPath(new URL('./verify-llm-firewall.mjs', import.meta.url))
const localSocket = 'unix:///tmp/raditi-firewall-test.sock'
const remoteSocket = 'ssh://secret-user@remote.example'

// Every Docker invocation goes to this local executable, including rejected remote cases.
// Changing current context after build reproduces the cleanup race without any daemon access.
const fakeDocker = `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FIREWALL_TEST_LOG, JSON.stringify({
  args,
  context: process.env.DOCKER_CONTEXT,
  host: process.env.DOCKER_HOST,
  builder: process.env.BUILDX_BUILDER,
}) + '\\n');
if (args[0] === 'context' && args[1] === 'inspect') {
  if (process.env.FIREWALL_TEST_INSPECT_FAIL) {
    console.error('secret diagnostic must not escape');
    process.exit(1);
  }
  if (existsSync(process.env.FIREWALL_TEST_SWITCH)) console.log(${JSON.stringify(remoteSocket)});
  else console.log(process.env.FIREWALL_TEST_ENDPOINT);
  process.exit(0);
}
if (args[0] !== '--host') process.exit(90);
if (args[2] === 'build') {
  writeFileSync(process.env.FIREWALL_TEST_SWITCH, 'changed');
  if (process.env.FIREWALL_TEST_BUILD_FAIL) process.exit(91);
}
if (args[2] === 'run') {
  process.stdin.resume();
  process.stdin.on('end', () => console.log('packet proof passed'));
}
`

async function invoke(settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-firewall-docker-test-'))
  try {
    const log = join(directory, 'calls.jsonl')
    await writeFile(log, '')
    await writeFile(join(directory, 'docker'), fakeDocker, { mode: 0o700 })
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (key.startsWith('DOCKER_') || key.startsWith('BUILDX_')) delete env[key]
    Object.assign(env, {
      PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
      FIREWALL_TEST_LOG: log,
      FIREWALL_TEST_SWITCH: join(directory, 'context-switched'),
      FIREWALL_TEST_ENDPOINT: localSocket,
      ...settings,
    })
    const result = spawnSync(process.execPath, [verifier], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    })
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    return { ...result, calls }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('firewall verifier rejects TCP/SSH hosts before build, run or cleanup', async () => {
  for (const endpoint of ['tcp://remote.example:2376', remoteSocket]) {
    const result = await invoke({ DOCKER_HOST: endpoint })
    assert.equal(result.status, 1)
    assert.deepEqual(result.calls, [])
    assert.match(result.stderr, /Firewall verification requires a local Docker socket/u)
    assert.equal(result.stderr.includes(endpoint), false)
  }
})

test('firewall verifier rejects remote selected contexts before build, run or cleanup', async () => {
  for (const endpoint of ['tcp://remote.example:2376', remoteSocket]) {
    for (const context of ['', 'remote-context']) {
      const result = await invoke({
        DOCKER_CONTEXT: context,
        FIREWALL_TEST_ENDPOINT: endpoint,
        ...(context ? { DOCKER_HOST: localSocket } : {}),
      })
      assert.equal(result.status, 1)
      assert.equal(result.calls.length, 1)
      assert.deepEqual(result.calls[0].args, [
        'context',
        'inspect',
        ...(context ? [context] : []),
        '--format',
        '{{.Endpoints.docker.Host}}',
      ])
      assert.match(result.stderr, /Firewall verification requires a local Docker socket/u)
      assert.equal(result.stderr.includes(endpoint), false)
    }
  }
})

test('firewall verifier fails closed with a fixed diagnostic if context inspection fails', async () => {
  const result = await invoke({ FIREWALL_TEST_INSPECT_FAIL: '1' })
  assert.equal(result.status, 1)
  assert.equal(result.calls.length, 1)
  assert.match(result.stderr, /Could not resolve Docker endpoint for firewall verification/u)
  assert.equal(result.stderr.includes('secret diagnostic'), false)
})

function assertPinned(result, endpoint, inspected) {
  assert.equal(result.status, 0, result.stderr)
  const commands = result.calls.slice(inspected ? 1 : 0)
  assert.deepEqual(
    commands.map(({ args }) => args[2]),
    ['build', 'run', 'rm', 'image', 'ps', 'image'],
  )
  for (const call of commands) {
    assert.deepEqual(call.args.slice(0, 2), ['--host', endpoint])
    assert.equal(call.context, undefined)
    assert.equal(call.host, undefined)
    assert.equal(call.builder, undefined)
  }
}

test('explicit local context overrides remote DOCKER_HOST and pins cleanup after a context switch', async () => {
  const result = await invoke({
    DOCKER_CONTEXT: 'local-test',
    DOCKER_HOST: remoteSocket,
    BUILDX_BUILDER: 'remote-builder',
  })
  assert.deepEqual(result.calls[0].args, [
    'context',
    'inspect',
    'local-test',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ])
  assertPinned(result, localSocket, true)
})

test('explicit local host overrides remote current context without inspecting it', async () => {
  const result = await invoke({ DOCKER_HOST: localSocket, FIREWALL_TEST_ENDPOINT: remoteSocket })
  assertPinned(result, localSocket, false)
})

test('local current context and local Windows pipe remain supported', async () => {
  assertPinned(await invoke(), localSocket, true)
  const pipe = 'npipe:////./pipe/docker_engine'
  assertPinned(await invoke({ FIREWALL_TEST_ENDPOINT: pipe }), pipe, true)
  const remotePipe = await invoke({ DOCKER_HOST: 'npipe:////remote.example/pipe/docker_engine' })
  assert.equal(remotePipe.status, 1)
  assert.deepEqual(remotePipe.calls, [])
})

test('failed builds clean up only through the pinned socket after a context switch', async () => {
  const result = await invoke({ FIREWALL_TEST_BUILD_FAIL: '1' })
  assert.equal(result.status, 1)
  const commands = result.calls.slice(1)
  assert.deepEqual(
    commands.map(({ args }) => args[2]),
    ['build', 'rm', 'image', 'ps', 'image'],
  )
  for (const call of commands) assert.deepEqual(call.args.slice(0, 2), ['--host', localSocket])
})
