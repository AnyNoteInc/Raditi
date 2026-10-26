import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'

import Docker from 'dockerode'
import { afterAll, describe, expect, it } from 'vitest'

import { DATABASE_USER } from './containers.ts'
import { execIn } from './exec.ts'
import { createDockerStagingDatabaseRuntime, stagingNames } from './staging.ts'

// Explicit opt-in (RADITI_PREVIEW_DOCKER_TESTS=1), with the preview's database image present
// (infra/preview/README.md). Never pulls; only what this suite creates is removed.
const enabled = process.env.RADITI_PREVIEW_DOCKER_TESTS === '1'
const socketPath = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
const image = 'mariadb@sha256:70cc072b29b4a89ae07abb2d4da2c64678a7f2dfe092751bb51c87d67dc1338b'
const docker = new Docker({ socketPath })
const runtime = createDockerStagingDatabaseRuntime({ runtime: 'runc', socketPath })
const made: string[] = []
const ids = async () => (await runtime.list()).map((row) => row.stagingId)

const dumpOf = (text: string) =>
  (async function* () {
    yield Buffer.from(text)
  })()

/** Runs one statement as `loader` inside the staging container. */
async function query(stagingId: string, password: string, sql: string) {
  const outcome = await execIn(docker.getContainer(stagingNames(stagingId).container), {
    argv: [
      'mariadb',
      '--protocol=TCP',
      '--host=127.0.0.1',
      '--user=loader',
      '--skip-ssl',
      '--batch',
      '--skip-column-names',
      '--database=staging',
      `--execute=${sql}`,
    ],
    user: DATABASE_USER,
    env: [`MYSQL_PWD=${password}`],
    stdoutBytes: 64 * 1024,
    stderrBytes: 64 * 1024,
    timeoutMs: 10_000,
  })
  return { code: outcome.code, out: outcome.stdout.toString().trim() }
}

afterAll(async () => {
  for (const id of made) await runtime.remove(id).catch(() => {})
})

describe.runIf(enabled)('the staging database on Docker', () => {
  it('loads a dump, answers on the loopback, and is gone after remove', async () => {
    const stagingId = randomUUID()
    made.push(stagingId)
    const staged = await runtime.load({
      stagingId,
      image,
      dump: dumpOf(
        "SET NAMES utf8mb4;\nDROP TABLE IF EXISTS `wp_options`;\nCREATE TABLE `wp_options` (`option_id` bigint unsigned NOT NULL AUTO_INCREMENT, `option_name` varchar(191) NOT NULL, `option_value` longtext NOT NULL, PRIMARY KEY (`option_id`)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;\nINSERT INTO `wp_options` VALUES (1,'blogname','Сайт');\n",
      ),
    })
    expect(staged.access).toMatchObject({
      engine: 'mysql',
      host: '127.0.0.1',
      database: 'staging',
      tls: 'plain',
    })
    expect(
      await query(stagingId, staged.access.password, 'SELECT option_value FROM wp_options'),
    ).toEqual({
      code: 0,
      out: 'Сайт',
    })
    // The published port is a MariaDB server: its greeting comes first.
    const greeting = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: Number(staged.access.port) })
      socket.once('data', (data: Buffer) => {
        socket.destroy()
        resolve(data)
      })
      socket.once('error', reject)
    })
    expect(greeting.length).toBeGreaterThan(4)
    // No file is read or written for the loader.
    const outfile = await query(stagingId, staged.access.password, "SELECT 1 INTO OUTFILE '/tmp/x'")
    expect(outfile.code).not.toBe(0)
    expect(await ids()).toContain(stagingId)
    await runtime.remove(stagingId)
    expect(await ids()).not.toContain(stagingId)
  }, 180_000)

  it('refuses a dump that runs a client command, and leaves nothing behind', async () => {
    const stagingId = randomUUID()
    made.push(stagingId)
    await expect(
      runtime.load({ stagingId, image, dump: dumpOf('\\! touch /tmp/escaped\nSELECT 1;\n') }),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(await ids()).not.toContain(stagingId)
  }, 180_000)
})
