import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import process from 'node:process'

const run = promisify(execFile)
const image = process.env.RADITI_DOCKER_TEST_IMAGE
test(
  'independent watchdog removes an expired sandbox after its creator exits',
  { skip: !image, timeout: 20_000 },
  async () => {
    const task = randomUUID()
    const name = `raditi-turn-${task}-1`
    let watchdog
    let id
    try {
      const result = await run('docker', [
        'run',
        '-d',
        '--name',
        name,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '10001:10001',
        '--label',
        'io.raditi.sandbox.owner=raditi',
        '--label',
        'io.raditi.sandbox.protocol=1',
        '--label',
        `io.raditi.sandbox.taskId=${task}`,
        '--label',
        'io.raditi.sandbox.turn=1',
        '--label',
        `io.raditi.sandbox.deadline=${Date.now() + 2_000}`,
        image,
      ])
      id = result.stdout.trim()
      watchdog = spawn(
        process.execPath,
        [fileURLToPath(new URL('./watchdog.mjs', import.meta.url))],
        { stdio: 'ignore' },
      )
      const until = Date.now() + 10_000
      let removed = false
      while (Date.now() < until) {
        await delay(200)
        try {
          await run('docker', ['inspect', id])
        } catch {
          removed = true
          break
        }
      }
      assert.ok(removed, 'deadline watchdog must remove the container without its creator process')
      assert.equal(watchdog.exitCode, null)
    } finally {
      watchdog?.kill('SIGTERM')
      if (id) await run('docker', ['rm', '-f', id]).catch(() => {})
    }
  },
)
