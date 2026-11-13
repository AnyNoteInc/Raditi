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

test(
  'the watchdog keeps a turn while its lease is ahead and removes it with the lease once it passed',
  { skip: !image, timeout: 30_000 },
  async () => {
    // docs/plan/70-turn-without-time-limit.md, ВР5: labels never change; leases move a turn on.
    const { dockerClient, reapExpired } = await import('./watchdog.mjs')
    const task = randomUUID()
    const created = []
    const create = async (name, labels, start) => {
      const args = [start ? 'run' : 'create', ...(start ? ['-d'] : []), '--name', name]
      for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
      args.push('--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', '10001:10001')
      args.push(image)
      const { stdout } = await run('docker', args)
      created.push(stdout.trim())
      return stdout.trim()
    }
    const exists = async (id) =>
      run('docker', ['inspect', id]).then(
        () => true,
        () => false,
      )
    try {
      const now = Date.now()
      const main = await create(
        `raditi-turn-${task}-1`,
        {
          'io.raditi.sandbox.owner': 'raditi',
          'io.raditi.sandbox.protocol': '1',
          'io.raditi.sandbox.taskId': task,
          'io.raditi.sandbox.turn': '1',
          'io.raditi.sandbox.deadline': String(now - 1_000),
        },
        true,
      )
      const until = now + 60_000
      const lease = await create(
        `raditi-turn-${task}-1-lease-${until}`,
        {
          'io.raditi.turnlease.owner': 'raditi',
          'io.raditi.turnlease.protocol': '1',
          'io.raditi.turnlease.taskId': task,
          'io.raditi.turnlease.turn': '1',
          'io.raditi.turnlease.deadline': String(until),
        },
        false,
      )
      const client = dockerClient(process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock')
      await reapExpired(client, now)
      assert.equal(await exists(main), true)
      assert.equal(await exists(lease), true)
      await reapExpired(client, until + 1)
      assert.equal(await exists(main), false)
      assert.equal(await exists(lease), false)
    } finally {
      for (const id of created) await run('docker', ['rm', '-f', id]).catch(() => {})
    }
  },
)
