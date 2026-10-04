import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { startWorker } from './workers.mjs'

let directory, fixture
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'raditi-worker-test-'))
  fixture = join(directory, 'worker.mjs')
  await writeFile(
    fixture,
    `let mode;
process.on('message', (message) => {
  if (message.type === 'init') {
    mode = message.config.mode;
    if (mode === 'exit-before-ready') return process.exit(1);
    if (mode === 'never-ready') return;
    process.send({type: 'ready'});
  } else if (message.operation === 'crash') {
    process.exit(1);
  } else if (message.operation === 'close') {
    process.stdout.write('close\\n');
    if (mode === 'ignore-close') return;
    process.send({id: message.id, ok: true, result: null}, () => {
      if (mode !== 'ack-without-exit') process.exit(0);
    });
  }
});
`,
  )
})
after(async () => rm(directory, { recursive: true, force: true }))

function launch(mode, overrides = {}) {
  let child
  const result = startWorker(
    'core',
    { mode, privateMarker: 'SYNTHETIC_PRIVATE_CONFIG' },
    {
      startupTimeoutMs: 1000,
      shutdownTimeoutMs: 100,
      forkChild: (_path, args, options) => {
        child = fork(fixture, args, { ...options, execArgv: [], ...overrides })
        return child
      },
    },
  )
  return { result, child: () => child }
}

const clean = (child) => {
  assert.equal(child.listenerCount('message'), 0)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
}

test('spawn failure rejects safely and reaches caller cleanup without an exit event', async () => {
  const { result, child } = launch('ready', {
    execPath: join(directory, 'nonexistent-node'),
  })
  let cleaned
  try {
    await assert.rejects(result, (error) => {
      assert.match(error.message, /^Verification .*failed|^Verification .*disconnected/)
      assert.equal(error.message.includes('SYNTHETIC_PRIVATE_CONFIG'), false)
      return true
    })
  } finally {
    cleaned = true
  }
  assert.equal(cleaned, true)
  assert.equal(child().pid, undefined)
  clean(child())
})

test('early child death rejects startup and removes startup listeners', async () => {
  const { result, child } = launch('exit-before-ready')
  await assert.rejects(result, /Verification .*exited at startup/)
  clean(child())
})

test('startup timeout terminates the owned process and clears listeners', async () => {
  const { result, child } = launch('never-ready')
  await assert.rejects(result, /Verification worker startup timed out/)
  assert.equal(child().signalCode, 'SIGKILL')
  clean(child())
})

test('abrupt exit rejects every pending RPC and close remains safe', async () => {
  const { result } = launch('ready')
  const worker = await result
  const pending = await Promise.allSettled([worker.call('wait'), worker.call('crash')])
  assert.ok(pending.every((reply) => reply.status === 'rejected'))
  await worker.exited
  await assert.rejects(worker.call('wait'), /Verification worker disconnected/)
  await worker.close()
  clean(worker.child)
})

test('concurrent close sends one shutdown and waits for output to drain', async () => {
  const { result } = launch('ready')
  const worker = await result
  const first = worker.close()
  assert.equal(worker.close(), first)
  await first
  assert.deepEqual(await worker.exited, { code: 0, signal: null })
  assert.equal(worker.logs.join(''), 'close\n')
  clean(worker.child)
})

test('each role starts its own worker script; an unknown role starts nothing', async () => {
  const started = []
  const forkChild = (path, args, options) => {
    started.push(path.slice(path.lastIndexOf('/') + 1))
    return fork(fixture, args, { ...options, execArgv: [] })
  }
  for (const role of ['core', 'llm'])
    await (await startWorker(role, { mode: 'ready' }, { forkChild })).close()
  assert.deepEqual(started, ['verify-core-worker.mjs', 'verify-llm-worker.mjs'])
  // The role mcp is the regular one, started from the build by the agent-content stand.
  for (const role of ['mcp', 'runner'])
    await assert.rejects(startWorker(role, {}, { forkChild }), /Invalid verification role/)
  assert.equal(started.length, 2)
})

for (const mode of ['ignore-close', 'ack-without-exit'])
  test(`shutdown is bounded for ${mode}`, async () => {
    const { result } = launch(mode)
    const worker = await result
    await worker.close()
    assert.equal(worker.child.signalCode, 'SIGKILL')
    clean(worker.child)
  })
