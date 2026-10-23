import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, test } from 'node:test'

import { repository } from './stack.mjs'
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
    if (mode === 'two-pipes') {
      process.stdout.write('out-one ');
      process.stderr.write('err-one ');
      process.stdout.write('out-two');
      process.stderr.write('err-two');
    }
    process.send({type: 'ready', execArgv: process.execArgv, held: process.env.SYNTHETIC_ENV_FILE_MARK ?? null});
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
    started.push(relative(repository, path))
    return fork(fixture, args, { ...options, execArgv: [] })
  }
  for (const role of ['core', 'llm'])
    await (await startWorker(role, { mode: 'ready' }, { forkChild })).close()
  // Each worker lives with the app whose build it hosts.
  assert.deepEqual(started, [
    'apps/core/scripts/verify-core-worker.mjs',
    'apps/llm/scripts/verify-llm-worker.mjs',
  ])
  for (const script of started) assert.ok(existsSync(join(repository, script)), script)
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

test('a worker loads the modules it is given before its script, and nothing else changes', async () => {
  const seen = []
  const start = (options) =>
    startWorker(
      'llm',
      { mode: 'ready' },
      {
        startupTimeoutMs: 1000,
        shutdownTimeoutMs: 100,
        ...options,
        forkChild: (_path, args, forkOptions) => {
          seen.push(forkOptions)
          return fork(fixture, args, { ...forkOptions, execArgv: [] })
        },
      },
    )
  const plain = await start({ execArgv: ['--max-old-space-size=256'] })
  await plain.close()
  // The arguments of the parent, named: never fork's own default, which copies all of them.
  assert.deepEqual(seen[0].execArgv, ['--max-old-space-size=256'])
  const guarded = await start({
    execArgv: ['--max-old-space-size=256'],
    imports: ['file:///stand/live-guard.mjs?cap=20'],
  })
  await guarded.close()
  assert.deepEqual(seen[1].execArgv, [
    '--max-old-space-size=256',
    '--import',
    'file:///stand/live-guard.mjs?cap=20',
  ])
  // The environment of a worker is the same two names either way: nothing of the stand's own.
  for (const options of seen) assert.deepEqual(Object.keys(options.env), ['PATH', 'NODE_ENV'])
})

test('a worker never loads the env file its stand was started with', async () => {
  // Real processes first: a stand started with `node --env-file=…` (the way spec names for
  // handing it the plan key) and the worker it forks, with and without an import.
  const envFile = join(directory, 'stand.env')
  await writeFile(envFile, 'SYNTHETIC_ENV_FILE_MARK=synthetic-value-of-the-env-file\n')
  const parent = join(directory, 'stand.mjs')
  await writeFile(
    parent,
    `import { fork } from 'node:child_process'
import { startWorker } from ${JSON.stringify(new URL('./workers.mjs', import.meta.url).href)}
const held = [process.env.SYNTHETIC_ENV_FILE_MARK !== undefined]
for (const imports of [[], [${JSON.stringify(new URL('./workers.mjs', import.meta.url).href)}]]) {
  const worker = await startWorker('llm', { mode: 'ready' }, {
    imports,
    forkChild: (_path, args, options) => fork(${JSON.stringify(fixture)}, args, options),
  })
  held.push(worker.ready.held !== null, worker.ready.execArgv.some((arg) => arg.includes('env-file')))
  await worker.close()
}
console.log(JSON.stringify(held))
`,
  )
  const stand = spawnSync(process.execPath, [`--env-file=${envFile}`, parent], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(stand.status, 0, stand.stderr)
  // The stand itself holds the variable; neither worker holds it or was told of the file.
  assert.deepEqual(JSON.parse(stand.stdout), [true, false, false, false, false])

  const seen = []
  const start = (options) =>
    startWorker(
      'core',
      { mode: 'ready' },
      {
        startupTimeoutMs: 1000,
        shutdownTimeoutMs: 100,
        ...options,
        forkChild: (_path, args, forkOptions) => {
          seen.push(forkOptions.execArgv)
          return fork(fixture, args, { ...forkOptions, execArgv: [] })
        },
      },
    )
  // Then both spellings of both options, among arguments that stay.
  const execArgv = [
    '--env-file=/checkout/.env',
    '--max-old-space-size=256',
    '--env-file',
    '/checkout/.env.local',
    '--env-file-if-exists=/checkout/.env',
    '--env-file-if-exists',
    '/checkout/.env.local',
    '--import',
    'file:///stand/kept.mjs',
  ]
  const kept = ['--max-old-space-size=256', '--import', 'file:///stand/kept.mjs']
  await (await start({ execArgv })).close()
  await (await start({ execArgv, imports: ['file:///stand/live-guard.mjs?cap=20'] })).close()
  assert.deepEqual(seen, [kept, [...kept, '--import', 'file:///stand/live-guard.mjs?cap=20']])
})

test('the output of a worker is kept by pipe as well: a text is whole in the pipe it was written to', async () => {
  const { result } = launch('two-pipes')
  const worker = await result
  await worker.close()
  // `logs` is every chunk in the order it was read, the two pipes mixed; `streams` keeps the
  // chunks of each pipe apart, so that a value cut by a read is whole again once they are joined.
  assert.equal(worker.streams.length, 2)
  assert.equal(worker.streams[0].join(''), 'out-one out-twoclose\n')
  assert.equal(worker.streams[1].join(''), 'err-one err-two')
  assert.equal(worker.logs.join('').length, 'out-one out-twoclose\nerr-one err-two'.length)
})
