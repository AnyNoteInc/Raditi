import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'

import { run, testTimeoutMs } from './command.mjs'

const options = { timeout: 15_000, skip: process.platform === 'win32' }
const node = (script, extra = {}) =>
  run(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    stage: 'synthetic stage',
    timeoutMs: 10_000,
    ...extra,
  })

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

test('the test suites get fifteen minutes unless the caller sets another limit', () => {
  assert.equal(testTimeoutMs({}), 15 * 60_000)
  assert.equal(testTimeoutMs({ VERIFY_DB_TEST_TIMEOUT_MS: '' }), 15 * 60_000)
  assert.equal(testTimeoutMs({ VERIFY_DB_TEST_TIMEOUT_MS: '2700000' }), 2_700_000)
  for (const value of ['0', '59999', '3600001', '15m', '1e6', '-1', '900000.5', ' ']) {
    assert.throws(
      () => testTimeoutMs({ VERIFY_DB_TEST_TIMEOUT_MS: value }),
      /VERIFY_DB_TEST_TIMEOUT_MS must be a whole number of milliseconds from 60000 to 3600000/,
      value,
    )
  }
})

test('returns the exit code and the trimmed output of both streams', options, async () => {
  assert.deepEqual(await node(`console.log(' out '); console.error('err')`), {
    code: 0,
    output: 'out \nerr',
  })
  assert.deepEqual(await node(`process.exit(3)`, { allowFailure: true }), { code: 3, output: '' })
})

test('a program that cannot be started is reported, not waited for', options, async () => {
  const started = Date.now()
  await assert.rejects(
    run('/nonexistent/raditi-db-verify-program', [], {
      cwd: process.cwd(),
      env: {},
      stage: 'synthetic stage',
      timeoutMs: 10_000,
    }),
    { message: 'Could not start /nonexistent/raditi-db-verify-program' },
  )
  assert.ok(Date.now() - started < 5_000)
})

test('a failed command reports its stage and the redacted end of its output', options, async () => {
  await assert.rejects(
    node(`console.log('password=hunter2'); process.exit(1)`, {
      redact: (text) => text.replaceAll('hunter2', '[redacted]'),
    }),
    (error) => {
      assert.match(error.message, /failed at synthetic stage:\npassword=\[redacted\]/)
      return true
    },
  )
})

test(
  'a command over its time limit is killed with its descendants and reports what it printed',
  options,
  async () => {
    // What a suite that does not fit looks like: results so far, then no exit.
    const script = `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log('descendant ' + child.pid + ' of ' + process.pid)
      console.log('Tests  1200 passed (1497) token=hunter2')
      setInterval(() => {}, 1000)`
    let message = ''
    await assert.rejects(
      node(script, {
        timeoutMs: 1_500,
        redact: (text) => text.replaceAll('hunter2', '[redacted]'),
      }),
      (error) => {
        message = error.message
        return true
      },
    )
    assert.match(message, /exceeded its 1\.5 s limit at synthetic stage; its last output:\n/)
    assert.match(message, /Tests {2}1200 passed \(1497\) token=\[redacted\]/)
    assert.doesNotMatch(message, /hunter2/)
    const [, descendant, parent] = /descendant (\d+) of (\d+)/.exec(message)
    assert.equal(alive(Number(parent)), false)
    for (let attempt = 0; alive(Number(descendant)); attempt += 1) {
      assert.ok(attempt < 100, 'The descendant of a timed out command is still running')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  },
)

test(
  'a command over its time limit takes the descendants that left its process group with it',
  options,
  async () => {
    // What pnpm does with a script: a process group of its own on the same output pipe. Killing
    // the group of the command alone would leave the suite running and its output open.
    const suite = `console.log('suite ' + process.pid); setTimeout(() => {}, 30_000)`
    const script = `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['-e', ${JSON.stringify(suite)}], { stdio: 'inherit', detached: true })
      console.log('runner ' + process.pid)
      setInterval(() => {}, 1000)`
    let message = ''
    await assert.rejects(node(script, { timeoutMs: 1_500 }), (error) => {
      message = error.message
      return true
    })
    assert.match(message, /exceeded its 1\.5 s limit at synthetic stage; its last output:\n/)
    const runner = Number(/runner (\d+)/.exec(message)[1])
    const detached = Number(/suite (\d+)/.exec(message)[1])
    for (let attempt = 0; alive(runner) || alive(detached); attempt += 1) {
      assert.ok(attempt < 100, 'A process of the timed out command is still running')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  },
)

test(
  'a killed command is reported even when a process that escaped still holds its output',
  options,
  async (t) => {
    // A daemon: its parent exits at once, so nothing links it to the command when the limit
    // comes. The verifier must go on to its cleanup instead of waiting for the pipe to close.
    const daemon = `console.log('daemon ' + process.pid); setTimeout(() => {}, 30_000)`
    const parent = `require('node:child_process')
      .spawn(process.execPath, ['-e', ${JSON.stringify(daemon)}], { stdio: 'inherit', detached: true })
      .unref()`
    const script = `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(parent)}], { stdio: 'inherit' })
      setInterval(() => {}, 1000)`
    let message = ''
    t.after(() => {
      const pid = Number(/daemon (\d+)/.exec(message)?.[1])
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    })
    await assert.rejects(node(script, { timeoutMs: 1_500, graceMs: 300 }), (error) => {
      message = error.message
      return true
    })
    assert.match(message, /exceeded its 1\.5 s limit at synthetic stage; its last output:\n/)
    assert.match(message, /daemon \d+/)
  },
)

test('a command that prints more than the cap is stopped and says so', options, async () => {
  await assert.rejects(
    node(
      `process.stdout.write('first line\\n' + 'x'.repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000)`,
    ),
    /printed more than 8 MiB at synthetic stage; its last output:\n/,
  )
})

test('an interruption is reported as one, not as an exceeded limit', options, async () => {
  const controller = new AbortController()
  const pending = node(`console.log('started'); setInterval(() => {}, 1000)`, {
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 300)
  await assert.rejects(pending, { message: 'Command interrupted at synthetic stage' })
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(node(`setInterval(() => {}, 1000)`, { signal: aborted.signal }), {
    message: 'Command interrupted at synthetic stage',
  })
})
